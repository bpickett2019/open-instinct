import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BusinessStore, StateDir, type BusinessConnection, type Json } from "@open-instinct/core";
import { ComposioApps, createBusinessProviders, type GoogleData } from "@open-instinct/apps";
import { BusinessCoordinator } from "../../src/business-coordinator.js";
import { BusinessCommitments, type CommitmentOwner } from "../../src/business-commitments.js";
import { gmailCorrelation, sweepGoogleRoutines } from "../../src/business-proactive-google.js";
import { OutboundIsolation } from "../../testing/isolation.js";
import { createGoogleFixture } from "../../testing/emulators/google.js";
import { createComposioFixture } from "../../testing/emulators/composio.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const owner: CommitmentOwner = { principal: { kind: "owner", id: "owner", tier: "owner" }, channel: "chat", ownerTurn: true };
const activationAt = Date.parse("2026-10-23T12:00:00Z");
interface SourceMessage { id: string; threadId: string; value: GoogleData }

async function fixture() {
  const isolation = new OutboundIsolation();
  cleanups.push(async () => { isolation.restore(); isolation.assertClean(); });
  const google = await createGoogleFixture(isolation); cleanups.push(() => google.close());
  // This slice never calls Calendar; an accidental Calendar request fails at Gmail.
  const composio = await createComposioFixture(isolation, google.url, google.url); cleanups.push(() => composio.close());
  isolation.install();
  const root = mkdtempSync(join(tmpdir(), "gmail-open-thread-"));
  const state = new StateDir(root); state.ensure();
  const store = new BusinessStore(join(root, "business"), () => activationAt);
  cleanups.push(async () => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const apps = new ComposioApps({ apiKey: "synthetic-composio-key", userId: store.settings().value.workspaceId, toolkits: ["gmail"], state, adapters: composio.adapters });
  cleanups.push(() => apps.close()); await apps.connect();
  const providers = createBusinessProviders({ apps, store });
  const connection = (await providers.connections.list()).find(row => row.toolkit === "gmail")!;
  const coordinator = new BusinessCoordinator(store); cleanups.push(() => coordinator.close());
  const service = new BusinessCommitments(coordinator); service.seedDefaults();
  const routine = service.routines(owner).find(row => row.id === "incoming-request")!;
  service.saveRoutine(owner, routine.id, routine.version, { ...routine.value, enabled: true, sources: [{ connectionId: connection.id, accountId: connection.accountId }] });
  let sequence = 0;
  async function message(label: string, threadId?: string): Promise<SourceMessage> {
    const raw = Buffer.from(`From: customer@fixture.test\r\nTo: owner@fixture.test\r\nDate: Tue, 01 Sep 2026 12:00:00 +0000\r\nSubject: ${label}\r\nMessage-ID: <${label}-${++sequence}@fixture.test>\r\n\r\nExisting customer work.\r\n`).toString("base64url");
    const response = await google.requestUpstream("/gmail/v1/users/me/messages/import", { method: "POST", body: JSON.stringify({ raw, ...(threadId ? { threadId } : {}), labelIds: ["INBOX"], internalDateSource: "dateHeader" }) });
    expect(response.status).toBe(200);
    const ref = await response.json() as { id: string; threadId: string };
    const value = await providers.googleForAccount(connection.accountId).message(ref.id);
    expect(Number(value.internalDate)).toBe(Date.parse("2026-09-01T12:00:00Z"));
    if (threadId) expect(ref.threadId).toBe(threadId);
    return { ...ref, value };
  }
  function task(label: string, sourceRefs: string[] = []) {
    const authority = coordinator.ownerAuthority(owner.principal, "chat", label, label);
    return coordinator.admitTask({ channel: "chat", conversationKey: "chat:owner", replyRef: {}, requester: "owner", audience: "owner" }, authority, { objective: label, doneCriteria: ["Read source evidence"], sourceRefs }, label);
  }
  function wait(label: string, threadId: string, accountId = connection.accountId, sourceRefs: string[] = []) {
    const work = task(label, sourceRefs);
    coordinator.wait(coordinator.claimRun(work.id)!, { kind: "external_event", correlationKey: gmailCorrelation(accountId, threadId), eventCursor: 0, deadline: null, requiresVerification: true });
    return work;
  }
  function cache(source: SourceMessage) {
    const id = `gmail-message:${connection.accountId}:${source.id}`;
    store.put("cursor", id, { message: source.value as Json, admitted: true }, null);
    return id;
  }
  function commitment(label: string, threadId: string, patch: Partial<{ accountId: string; epoch: number }> = {}) {
    return service.create(owner, { name: label, objective: label, doneCriteria: ["Read source evidence"], dueAt: activationAt + 86_400_000, timezone: "UTC", cron: null, parentTaskId: null, routineId: null, sourceRefs: [], followUp: null, premise: { correlationKey: gmailCorrelation(patch.accountId ?? connection.accountId, threadId), after: 0, eventCursor: 0, connection: { id: connection.id, accountId: connection.accountId, epoch: connection.epoch, ...patch }, sourceRevisions: {}, availabilityKey: null } }, label);
  }
  const poll = () => sweepGoogleRoutines(service, providers);
  const cursor = (accountId = connection.accountId) => store.get<{ openThreads: string[]; mode: string }>("cursor", `gmail-intake:${accountId}`)!.value;
  const directCalls = () => google.attempts.filter(call => call.path.includes("/threads/")).map(call => decodeURIComponent(call.path.split("/threads/")[1]!));
  return { store, coordinator, service, providers, google, composio, connection, message, task, wait, cache, commitment, poll, cursor, directCalls };
}

describe.sequential("BO153 production Gmail open-thread recovery (stateful emulation)", () => {
  it("recovers an old active-thread reply after history expiry without replaying closed, unrelated or other-account mail", async () => {
    const f = await fixture();
    const active = await f.message("active-original"), closed = await f.message("closed-original"), unrelated = await f.message("unrelated"), foreign = await f.message("foreign");
    const work = f.wait("Active customer work", active.threadId, f.connection.accountId, [f.cache(active)]);
    const closedWork = f.wait("Closed customer work", closed.threadId, f.connection.accountId, [f.cache(closed)]);
    f.coordinator.control(owner.principal, closedWork.id, "stop");
    const foreignWork = f.wait("Other account work", foreign.threadId, "different-account");
    await f.poll();
    expect(f.cursor()).toMatchObject({ mode: "history", openThreads: [active.threadId] });
    expect(f.directCalls()).toEqual([active.threadId]);
    expect(f.store.waits(work.id)[0]!.status).toBe("waiting");
    const reply = await f.message("active-reply", active.threadId);
    await f.message("closed-reply", closed.threadId);
    f.google.attempts.length = 0;
    f.google.expireHistory(); await f.poll();
    expect(f.cursor().mode).toBe("window");
    expect(f.directCalls()).toEqual([]);
    await f.poll();
    expect(f.directCalls()).toEqual([active.threadId]);
    expect(f.store.waits(work.id)[0]).toMatchObject({ status: "satisfied", satisfiedBy: `gmail-message:${f.connection.accountId}:${reply.id}` });
    expect(f.store.events(gmailCorrelation(f.connection.accountId, active.threadId)).map(row => row.value.id)).toEqual([`gmail-message:${f.connection.accountId}:${reply.id}`]);
    expect(f.store.tasks()).toHaveLength(3); // Historical readback never admits a new incoming request.
    expect(f.store.waits(foreignWork.id)[0]!.status).toBe("waiting");
    for (const source of [unrelated, foreign]) expect(f.store.get("cursor", `gmail-message:${f.connection.accountId}:${source.id}`)).toBeUndefined();
    f.google.expireHistory(false); f.google.attempts.length = 0; await f.poll();
    // The satisfied wait no longer supplies scope; its still-open source task does.
    expect(f.cursor().openThreads).toEqual([active.threadId]); expect(f.directCalls()).toEqual([active.threadId]);
    expect(f.store.events(gmailCorrelation(f.connection.accountId, active.threadId))).toHaveLength(1);
    f.coordinator.control(owner.principal, work.id, "stop"); f.google.attempts.length = 0;
    await f.poll(); expect(f.cursor().openThreads).toEqual([]); expect(f.directCalls()).toEqual([]);
  });

  it("adds waits and exact-account commitments after activation and removes satisfied, terminal and cancelled scope", async () => {
    const f = await fixture();
    const waiting = await f.message("late-wait"), committed = await f.message("active-commitment"), cancelled = await f.message("cancelled-commitment"), stale = await f.message("stale-epoch"), foreign = await f.message("foreign-commitment");
    await f.poll(); expect(f.cursor().openThreads).toEqual([]);
    const work = f.wait("Added after activation", waiting.threadId);
    const active = f.commitment("Active commitment", committed.threadId);
    const removed = f.commitment("Cancelled commitment", cancelled.threadId); f.service.cancel(owner, removed.id, removed.version, "Owner closed it");
    f.commitment("Stale epoch commitment", stale.threadId, { epoch: 99 });
    f.commitment("Other account commitment", foreign.threadId, { accountId: "different-account" });
    f.google.attempts.length = 0; f.google.expireHistory(); await f.poll(); await f.poll();
    expect(f.cursor().openThreads).toEqual([waiting.threadId, committed.threadId].sort());
    expect(f.directCalls().sort()).toEqual([waiting.threadId, committed.threadId].sort());
    expect(f.store.waits(work.id)[0]!.status).toBe("satisfied");
    expect(f.store.tasks()).toHaveLength(1);
    for (const source of [cancelled, stale, foreign]) expect(f.store.get("cursor", `gmail-message:${f.connection.accountId}:${source.id}`)).toBeUndefined();
    f.service.cancel(owner, active.id, active.version, "Finished externally");
    f.google.expireHistory(false); f.google.attempts.length = 0; await f.poll();
    expect(f.cursor().openThreads).toEqual([]); expect(f.directCalls()).toEqual([]);
  });

  it.each(["epoch", "identity", "account"] as const)("never reuses open work after a connection %s change", async change => {
    const f = await fixture(); const source = await f.message(`binding-${change}`);
    const work = f.wait("Bound original account", source.threadId, f.connection.accountId, [f.cache(source)]);
    await f.poll(); expect(f.cursor().openThreads).toEqual([source.threadId]);
    const saved = f.store.get<BusinessConnection>("connection", f.connection.id)!;
    let accountId = saved.value.accountId;
    if (change === "account") {
      accountId = `${accountId}-replacement`; f.composio.substitute(saved.value.accountId, accountId);
      f.store.put("connection", saved.id, { ...saved.value, status: "disabled", epoch: saved.value.epoch + 1 }, saved.version);
      f.store.put("connection", accountId, { ...saved.value, id: accountId, accountId, identity: "replacement@fixture.test", epoch: 0 }, null);
      const routine = f.service.routines(owner).find(row => row.id === "incoming-request")!;
      f.service.saveRoutine(owner, routine.id, routine.version, { ...routine.value, sources: [{ connectionId: accountId, accountId }] });
    } else {
      f.store.put("connection", saved.id, { ...saved.value, ...(change === "epoch" ? { epoch: saved.value.epoch + 1 } : { identity: "replacement@fixture.test" }) }, saved.version);
    }
    f.google.attempts.length = 0; await f.poll();
    expect(f.cursor(accountId).openThreads).toEqual([]); expect(f.directCalls()).toEqual([]);
    expect(f.store.waits(work.id)[0]!.status).toBe("waiting");
    expect(f.store.events(gmailCorrelation(f.connection.accountId, source.threadId))).toEqual([]);
  });
});
