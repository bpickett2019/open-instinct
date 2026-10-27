import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BusinessStore, type BusinessConnection, type StateDir } from "@open-instinct/core";
import { ComposioApps } from "../src/composio.js";
import { createBusinessProviders } from "../src/business-providers.js";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "instinct-reconnect-"));
  let store = new BusinessStore(root);
  cleanup.push(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const original: BusinessConnection = { id: "account", accountId: "account", toolkit: "gmail", identity: "owner@example.test", scopes: [], status: "connected", epoch: 0, connectedBy: "owner", verifiedAt: 1, revocation: "none", revokeJobId: null };
  store.put("connection", original.id, original, null);
  const wire = {
    activeId: "account", identity: original.identity, profileReads: 0,
    authorize: async () => ({ redirectUrl: "https://oauth.fixture.test/gmail" }),
    revoke: async (): Promise<Response> => Response.json({ error: "Synthetic revocation failure" }, { status: 503 }),
    profile: undefined as undefined | (() => Promise<Response>),
  };
  const apps = new ComposioApps({ apiKey: "synthetic", userId: store.settings().value.workspaceId, toolkits: ["gmail"], state: {} as StateDir, adapters: {
    createComposio: () => ({ sessions: {
      create: async () => ({ sessionId: "oauth", mcp: { url: "https://mcp.fixture.test" }, authorize: () => wire.authorize(), toolkits: async () => ({ items: [] }) }),
      use: async () => { throw new Error("Unexpected session reuse"); },
    } }),
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      if (init?.method === "DELETE") return wire.revoke();
      if (url.pathname.endsWith("/connected_accounts")) return Response.json({ items: [{ id: wire.activeId, toolkit: { slug: "gmail" }, status: "ACTIVE", is_disabled: false }], next_cursor: null });
      if (url.pathname.endsWith("/tool_router/session")) return Response.json({ session_id: "bound", config: { user_id: store.settings().value.workspaceId, connected_accounts: { gmail: wire.activeId } } });
      if (url.pathname.endsWith("/proxy_execute")) { wire.profileReads++; return wire.profile ? wire.profile() : Response.json({ result_type: "completed", status: 200, data: { emailAddress: wire.identity } }); }
      throw new Error(`Unexpected fixture request ${url.pathname}`);
    },
  } });
  return { wire, get store() { return store; }, providers: () => createBusinessProviders({ apps, store }), restart: () => { store.close(); store = new BusinessStore(root); } };
}

describe("explicit disconnect dominates older connection authority", () => {
  it("keeps old and newly prepared reads denied after failed revocation, repeated discovery and restart", async () => {
    const f = fixture(); const providers = f.providers();
    const prepared = providers.googleForAccount("account");
    await providers.connections.connect("gmail");
    expect((await providers.connections.disconnect("account")).revocation).toBe("failed");
    for (let attempt = 0; attempt < 2; attempt++) await providers.connections.list();
    expect(f.store.get<BusinessConnection>("connection", "account")!.value.status).toBe("disabled");
    await expect(prepared.profile()).rejects.toThrow("disabled");
    expect(() => providers.googleForAccount("account")).toThrow("connection required");
    f.restart(); await f.providers().connections.list();
    expect(f.store.get<BusinessConnection>("connection", "account")!.value).toMatchObject({ status: "disabled", revocation: "failed" });
    expect(f.wire.profileReads).toBe(0);
    await f.providers().connections.connect("gmail"); await f.providers().connections.list();
    expect(f.store.get<BusinessConnection>("connection", "account")!.value).toMatchObject({ status: "connected", identity: "owner@example.test", epoch: 2 });
    expect(f.wire.profileReads).toBe(1);
  });

  it("does not restore access while DELETE is in flight or its upstream revocation job remains unresolved", async () => {
    const f = fixture(); const providers = f.providers(); const gate = Promise.withResolvers<Response>(); const entered = Promise.withResolvers<void>();
    f.wire.revoke = () => { entered.resolve(); return gate.promise; };
    await providers.connections.connect("gmail");
    const disconnecting = providers.connections.disconnect("account"); await entered.promise;
    await providers.connections.list();
    expect(f.store.get<BusinessConnection>("connection", "account")!.value).toMatchObject({ status: "disabled", revocation: "requested" });
    await providers.connections.connect("gmail"); await providers.connections.list();
    expect(f.store.get<BusinessConnection>("connection", "account")!.value.status).toBe("disabled");
    gate.resolve(Response.json({ success: true, revoke_job_id: "pending-job" }));
    expect(await disconnecting).toMatchObject({ status: "disabled", revocation: "requested", revokeJobId: "pending-job" });
    f.restart(); await f.providers().connections.list();
    expect(f.store.get<BusinessConnection>("connection", "account")!.value).toMatchObject({ status: "disabled", revokeJobId: "pending-job" });
    expect(f.wire.profileReads).toBe(0);
  });

  it("rejects an authorization URL that finishes after disconnect instead of installing a fresh-looking intent", async () => {
    const f = fixture(); const providers = f.providers(); const gate = Promise.withResolvers<{ redirectUrl: string }>(); const entered = Promise.withResolvers<void>();
    f.wire.authorize = () => { entered.resolve(); return gate.promise; };
    const connecting = providers.connections.connect("gmail"); await entered.promise;
    await providers.connections.disconnect("account");
    gate.resolve({ redirectUrl: "https://oauth.fixture.test/obsolete-link" });
    await expect(connecting).rejects.toThrow();
    await providers.connections.list();
    expect(f.store.get<BusinessConnection>("connection", "account")!.value.status).toBe("disabled");
    expect(f.wire.profileReads).toBe(0);
  });

  it("does not adopt a different account created by an old OAuth link after disconnect", async () => {
    const f = fixture(); const providers = f.providers();
    await providers.connections.connect("gmail"); await providers.connections.disconnect("account");
    f.wire.activeId = "account-from-obsolete-oauth";
    await providers.connections.list(); f.restart(); await f.providers().connections.list();
    expect(f.store.get("connection", f.wire.activeId)).toBeUndefined();
    expect(f.wire.profileReads).toBe(0);
  });

  it("rejects a changed provider identity even with a newer explicit reconnect instruction", async () => {
    const f = fixture(); const providers = f.providers();
    await providers.connections.disconnect("account"); await providers.connections.connect("gmail");
    f.wire.identity = "different@example.test";
    await expect(providers.connections.list()).rejects.toThrow("identity changed");
    expect(f.store.get<BusinessConnection>("connection", "account")!.value).toMatchObject({ status: "disabled", identity: "owner@example.test" });
  });

  it("rejects identity verification that finishes after a newer disconnect", async () => {
    const f = fixture(); const providers = f.providers();
    await providers.connections.disconnect("account"); await providers.connections.connect("gmail");
    const gate = Promise.withResolvers<Response>(); const entered = Promise.withResolvers<void>();
    f.wire.profile = () => { entered.resolve(); return gate.promise; };
    const discovering = providers.connections.list(); await entered.promise;
    await providers.connections.disconnect("account");
    gate.resolve(Response.json({ result_type: "completed", status: 200, data: { emailAddress: "owner@example.test" } }));
    await expect(discovering).rejects.toThrow("authority changed");
    expect(f.store.get<BusinessConnection>("connection", "account")!.value).toMatchObject({ status: "disabled", revocation: "failed", epoch: 2 });
    expect(() => providers.googleForAccount("account")).toThrow("connection required");
  });
});
