import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BusinessStore, type BusinessConnection, type ToolContext } from "@open-instinct/core";
import { BusinessCoordinator } from "../src/business-coordinator.js";
import { BusinessOnboarding } from "../src/business-onboarding.js";
import { businessOwnerTools } from "../src/business-owner-tools.js";
import { BusinessService } from "../src/business-service.js";
import { createWorkspaceHandler, type OwnerConnections } from "../src/workspace-http.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const owner = { kind: "owner", id: "owner", tier: "owner" } as const;
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "business-onboarding-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const store = new BusinessStore(join(root, "private"));
  const coordinator = new BusinessCoordinator(store);
  const sent: string[] = [];
  const service = new BusinessService(coordinator, { send: async message => { sent.push(message.text); } });
  cleanup.push(async () => { await service.close(); await coordinator.close(); store.close(); });
  const text = "Help me set up my business";
  const messageId = "owner-onboarding";
  const authorityRef = coordinator.ownerAuthority(owner, "chat", messageId, text);
  const context: ToolContext = { principal: owner, channel: "chat", conversationKey: "chat:owner", ownerTurn: true, businessOwnerSource: { authorityRef, messageId, text }, now: () => new Date("2026-10-24T09:00:00Z") };
  return { store, coordinator, service, context, sent };
}
function account(): BusinessConnection & { version: number } {
  return { id: "gmail-owner", toolkit: "gmail", accountId: "verified-gmail-account", identity: "owner@fixture.test", scopes: [], status: "connected", epoch: 1, connectedBy: "owner", verifiedAt: 1792832400000, revocation: "none", revokeJobId: null, version: 1 };
}

// Only uncertain provider transitions are adapted here. State, provenance, tools and
// HTTP handling are production implementations; full provider integration is in scenarios.
describe("assistant-led onboarding boundaries", () => {
  it("keeps missing providers honest through both owner HTTP and owner tools", async () => {
    const { service, store, context, sent } = fixture();
    const server = createServer();
    const listening = Promise.withResolvers<void>();
    server.once("error", listening.reject); server.listen(0, "127.0.0.1", listening.resolve); await listening.promise;
    cleanup.push(async () => { const closed = Promise.withResolvers<void>(); server.close(error => error ? closed.reject(error) : closed.resolve()); server.closeAllConnections(); await closed.promise; });
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing test listener");
    const origin = `http://127.0.0.1:${address.port}`;
    const handler = createWorkspaceHandler({ token: "synthetic-onboarding-token", origin, allowLoopbackHttp: true, business: service });
    server.on("request", (req, res) => { void handler(req, res).then(handled => { if (!handled) { res.writeHead(404); res.end(); } }); });
    expect((await fetch(`${origin}/api/owner/onboarding`)).status).toBe(401);
    const login = await fetch(`${origin}/api/owner/session`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ token: "synthetic-onboarding-token" }) });
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const { csrf } = await login.json() as { csrf: string };
    const snapshot = await fetch(`${origin}/api/owner/onboarding`, { headers: { cookie } });
    expect(snapshot.status).toBe(200);
    expect(await snapshot.json()).toMatchObject({ canContinue: true, profile: { version: 0, facts: [] }, apps: [{ toolkit: "gmail", status: "setup_required", identity: null }, { toolkit: "googlecalendar", status: "setup_required", identity: null }], computer: { status: "setup_required" }, nextQuestion: { key: "businessName" } });
    for (const toolkit of ["gmail", "googlecalendar"]) {
      const connect = await fetch(`${origin}/api/owner/connections`, { method: "POST", headers: { cookie, origin, "content-type": "application/json", "x-workspace-csrf": csrf }, body: JSON.stringify({ toolkit }) });
      expect(connect.status).toBe(200);
      expect(await connect.json()).toMatchObject({ url: null, status: "setup_required", message: expect.any(String) });
    }
    const tools = businessOwnerTools(service);
    const snapshotTool = tools.find(tool => tool.spec.name === "business_onboarding")!;
    const connectTool = tools.find(tool => tool.spec.name === "apps_connect")!;
    expect(await snapshotTool.spec.execute({}, context)).toBeDefined();
    const result = await connectTool.spec.execute({ toolkit: "gmail" }, context);
    expect(JSON.stringify(result)).toContain("setup_required");
    expect(store.list("cursor").filter(row => row.id.startsWith("onboarding:connect:"))).toEqual([]);
    expect(store.list("routine")).toEqual([]);
    expect(store.tasks()).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("rejects nonowners, email/group authority, indirect turns, forged provenance and task workers inside onboarding tools", async () => {
    const { service, context, coordinator, store } = fixture();
    const task = coordinator.admitTask({ channel: "chat", conversationKey: "chat:owner", replyRef: {}, requester: "owner", audience: "owner" }, context.businessOwnerSource!.authorityRef, { objective: "Inspect assigned work", doneCriteria: ["Report assigned work"] }, "worker-boundary");
    const binding = coordinator.claimRun(task.id)!;
    const denied: ToolContext[] = [
      { ...context, principal: { kind: "agent", id: "stranger", tier: "stranger" } },
      { ...context, principal: { ...owner, tier: "friend", cappedFrom: "owner" } },
      { ...context, channel: "email" },
      { ...context, ownerTurn: false },
      { ...context, businessOwnerSource: undefined },
      { ...context, businessOwnerSource: { ...context.businessOwnerSource!, text: "Forged current owner instruction" } },
      { ...context, taskRun: binding },
      { ...context, ownerTurn: false, taskRun: binding },
    ];
    for (const name of ["business_onboarding", "business_connections", "apps_connect"]) {
      const tool = businessOwnerTools(service).find(candidate => candidate.spec.name === name)!;
      for (const ctx of denied) await expect(tool.spec.execute(name === "apps_connect" ? { toolkit: "gmail" } : {}, ctx)).rejects.toThrow();
    }
    expect(store.list("cursor")).toEqual([]);
    expect(store.list("routine")).toEqual([]);
  });

  it("never upgrades a pending connection on failed reads or an unverified account, then confirms once", async () => {
    const { store } = fixture();
    let failure = false;
    let accounts: Array<BusinessConnection & { version: number }> = [];
    const connections: OwnerConnections = {
      list: async () => { if (failure) throw new Error("Provider unavailable"); return structuredClone(accounts); },
      connect: async () => ({ url: "https://provider.fixture.test/oauth/gmail" }),
      disconnect: async () => { throw new Error("Onboarding must not disconnect accounts"); },
    };
    const notices: Array<{ id: string; text: string }> = [];
    const onboarding = new BusinessOnboarding(store, connections, () => false, async (id, text) => { notices.push({ id, text }); });
    expect(await onboarding.connect("gmail")).toMatchObject({ status: "waiting", url: "https://provider.fixture.test/oauth/gmail" });
    expect((await onboarding.snapshot()).apps[0]).toMatchObject({ status: "waiting", identity: null });
    failure = true;
    await onboarding.checkPending();
    expect((await onboarding.snapshot()).apps[0]).toMatchObject({ status: "unavailable", identity: null });
    expect(store.get<{ status: string }>("cursor", "onboarding:connect:gmail")!.value.status).toBe("waiting");
    expect(notices).toEqual([]);
    failure = false;
    accounts = [{ ...account(), verifiedAt: null }];
    await onboarding.checkPending();
    expect(notices).toEqual([]);
    expect(store.get<{ status: string }>("cursor", "onboarding:connect:gmail")!.value.status).toBe("waiting");
    expect((await onboarding.snapshot()).apps[0]).toMatchObject({ status: "waiting", identity: null });
    accounts = [account()];
    await Promise.all([onboarding.checkPending(), onboarding.checkPending()]);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.text).toContain("owner@fixture.test");
    expect((await onboarding.snapshot()).apps[0]).toMatchObject({ status: "connected", identity: "owner@fixture.test" });
    const resumed = new BusinessOnboarding(store, connections, () => true, async (id, text) => { notices.push({ id, text }); });
    await resumed.checkPending();
    expect(notices).toHaveLength(1);
    expect(store.list("routine")).toEqual([]);
    expect(store.tasks()).toEqual([]);
  });

  it("recovers interruption after durable confirmation without losing or resending the notice", async () => {
    const { store, service, sent } = fixture();
    let connected = false;
    const connections: OwnerConnections = {
      list: async () => connected ? [account()] : [],
      connect: async () => ({ url: "https://provider.fixture.test/oauth/gmail" }),
      disconnect: async () => { throw new Error("Unexpected disconnect"); },
    };
    const interrupted = new BusinessOnboarding(store, connections, () => false, async (id, text) => {
      await service.ownerNotice(id, text);
      throw new Error("Interrupted after durable notification");
    });
    await interrupted.connect("gmail");
    connected = true;
    await expect(interrupted.checkPending()).rejects.toThrow("Interrupted after durable notification");
    expect(sent).toHaveLength(1);
    expect(store.get<{ status: string }>("cursor", "onboarding:connect:gmail")!.value.status).toBe("waiting");
    const resumed = new BusinessOnboarding(store, connections, () => false, (id, text) => service.ownerNotice(id, text));
    await resumed.checkPending();
    await resumed.checkPending();
    expect(store.get<{ status: string }>("cursor", "onboarding:connect:gmail")!.value.status).toBe("verified");
    expect(store.messages().filter(message => message.id.startsWith("onboarding-connected:"))).toHaveLength(1);
    expect(store.list("notification")).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });
  it("does not create another authorization intent for an already verified account", async () => {
    const { store, service } = fixture();
    const connections: OwnerConnections = { list: async () => [account()], connect: async () => { throw new Error("Must not authorize again"); }, disconnect: async () => { throw new Error("Unexpected disconnect"); } };
    const onboarding = new BusinessOnboarding(store, connections, () => false, (id, text) => service.ownerNotice(id, text));
    expect(await onboarding.connect("gmail")).toMatchObject({ status: "connected", url: null });
    expect(store.get("cursor", "onboarding:connect:gmail")).toBeUndefined();
    expect(store.list("notification")).toEqual([]);
  });

  it("does not send a stale connected notice when disconnect wins during account discovery", async () => {
    const { store, service, sent } = fixture();
    const gate = Promise.withResolvers<Array<BusinessConnection & { version: number }>>();
    let checking = false;
    const connections: OwnerConnections = { list: async () => checking ? gate.promise : [], connect: async () => ({ url: "https://provider.fixture.test/oauth/gmail" }), disconnect: async () => { throw new Error("Unexpected disconnect"); } };
    const onboarding = new BusinessOnboarding(store, connections, () => false, (id, text) => service.ownerNotice(id, text));
    await onboarding.connect("gmail");
    checking = true;
    const pending = onboarding.checkPending();
    store.put("cursor", "connect:gmail", { pending: false, cancelled: true }, null);
    gate.resolve([account()]);
    await pending;
    checking = false;
    expect((await onboarding.snapshot()).apps[0]).toMatchObject({ status: "available", identity: null });
    expect(store.get<{ status: string }>("cursor", "onboarding:connect:gmail")!.value.status).toBe("cancelled");
    expect(sent).toEqual([]);
    expect(store.list("notification")).toEqual([]);
  });
});
