import { randomUUID } from "node:crypto";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { BusinessStore } from "@open-instinct/core";
import { BusinessCoordinator } from "../src/business-coordinator.js";
import { BusinessKnowledge } from "../src/business-knowledge.js";
import { BusinessService } from "../src/business-service.js";
import { createWorkspaceHandler } from "../src/workspace-http.js";

let directory: string, store: BusinessStore, coordinator: BusinessCoordinator, knowledge: BusinessKnowledge, business: BusinessService, server: Server, origin: string, cookie: string, ownerRef: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "workspace-http-"));
  store = new BusinessStore(join(directory, "private")); coordinator = new BusinessCoordinator(store); knowledge = new BusinessKnowledge(store);
  business = new BusinessService(coordinator, { send: async () => { throw new Error("Read-only route regression must not send messages"); } });
  ownerRef = coordinator.ownerAuthority({ kind: "owner", id: "owner", tier: "owner", displayName: "Synthetic owner" }, "chat", randomUUID(), "Import a synthetic source");
  server = createServer();
  const listening = Promise.withResolvers<void>(); server.once("error", listening.reject); server.listen(0, "127.0.0.1", listening.resolve); await listening.promise;
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing local route test listener");
  origin = `http://127.0.0.1:${address.port}`;
  const handler = createWorkspaceHandler({ token: "synthetic-route-test-token", origin, allowLoopbackHttp: true, business, artifacts: knowledge });
  server.on("request", (req, res) => { void handler(req, res).then(handled => { if (!handled) { res.writeHead(404); res.end(); } }); });
  const login = await fetch(`${origin}/api/owner/session`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ token: "synthetic-route-test-token" }) });
  expect(login.status).toBe(200); cookie = login.headers.get("set-cookie")!.split(";")[0]!; await login.json();
});
afterEach(async () => {
  const closed = Promise.withResolvers<void>(); server.close(error => error ? closed.reject(error) : closed.resolve()); server.closeAllConnections(); await closed.promise;
  await business.close(); await knowledge.close(); await coordinator.close(); store.close(); await rm(directory, { recursive: true, force: true });
});
const get = (path: string) => fetch(`${origin}/api/owner${path}`, { headers: { cookie } });

it("returns 404 for absent records without turning missing stored bytes into a 404", async () => {
  const missing = randomUUID();
  for (const path of [`/files/${missing}/download`, `/knowledge/${missing}`, `/sources/${missing}`]) expect((await get(path)).status).toBe(404);
  const artifact = await knowledge.upload({ filename: "source.txt", mimeType: "text/plain", bytes: Buffer.from("Original synthetic source") }, ownerRef);
  const original = await get(`/files/${artifact.id}/download`); expect(original.status).toBe(200); expect(await original.text()).toBe("Original synthetic source");
  await unlink(join(store.root, "artifacts", `${artifact.id}.bin`));
  expect((await get(`/knowledge/${artifact.id}`)).status).toBe(200);
  const broken = await get(`/files/${artifact.id}/download`); expect(broken.status).toBe(500);
  const error = await broken.json(); expect(error).toEqual({ error: "Workspace operation failed. Inspect activity or retry after correcting the source." }); expect(JSON.stringify(error)).not.toContain(directory);
});

it("projects accounted amounts, held reservations and unknown pricing without inventing caps", async () => {
  const settings = store.settings();
  store.updateSettings(settings.version, { ...settings.value, limits: { purchaseMinor: 1000, modelMinor: null, currency: "USD" } });
  store.transaction(() => {
    store.reserveAmount("synthetic-settled-purchase", { category: "purchase", currency: "USD", amountMinor: 200 });
    store.settleReservation("synthetic-settled-purchase", true);
    store.reserveAmount("synthetic-held-purchase", { category: "purchase", currency: "USD", amountMinor: 300 });
  });
  const current = store.settings();
  store.updateSettings(current.version, { ...current.value, usage: { ...current.value.usage, modelMinor: 17, modelPriceUnknown: true } });
  for (const path of ["/overview", "/settings"]) {
    const response = await get(path); expect(response.status).toBe(200);
    expect((await response.json() as { allowances: unknown }).allowances).toMatchObject({
      purchase: { currency: "USD", limitMinor: 1000, usedMinor: 200, heldMinor: 300, remainingMinor: 500, unknown: false },
      model: { currency: "USD", limitMinor: null, usedMinor: 17, heldMinor: 0, remainingMinor: null, unknown: true },
    });
  }
});
