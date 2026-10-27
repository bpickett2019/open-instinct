import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BusinessStore } from "@open-instinct/core";
import type { BusinessConnection, BusinessEvent, LogicalAction, ToolContext } from "@open-instinct/core";
import { BusinessCoordinator } from "../src/business-coordinator.js";
import { BusinessCommitments, DEFAULT_FOLLOW_UP, nextContactTime } from "../src/business-commitments.js";
import type { BusinessCommitment, CommitmentInput, CommitmentOwner, RoutineInput } from "../src/business-commitments.js";
import { createBusinessCommitmentTools } from "../src/business-commitment-tools.js";

const owner: CommitmentOwner = { principal: { kind: "owner", id: "owner", tier: "owner", displayName: "Synthetic owner" }, channel: "chat", ownerTurn: true };
const effect: LogicalAction = { stepId: "chase", tool: "test_send", arguments: {}, sourceRevisions: {}, effectful: true };
const HOUR = 3_600_000;
describe("durable business commitments", () => {
  let directory: string;
  let store: BusinessStore;
  let coordinator: BusinessCoordinator;
  let service: BusinessCommitments;
  let now: number;
  let liveValid: boolean;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "business-commitments-"));
    now = Date.parse("2026-10-19T10:00:00Z"); liveValid = true;
    store = new BusinessStore(directory, () => now);
    coordinator = new BusinessCoordinator(store, { beforeDispatch: (binding, action) => service.assertDispatch(binding, action), cancelCommitments: (id, reason) => service.cancelForTask(id, reason) });
    service = new BusinessCommitments(coordinator, { recheckPremise: async () => ({ valid: liveValid, reason: "Current provider premise changed" }) });
    service.seedDefaults();
    store.put<BusinessConnection>("connection", "mailbox", { id: "mailbox", toolkit: "gmail", accountId: "account", identity: "owner@example.test", scopes: [], status: "connected", epoch: 0, connectedBy: "owner", verifiedAt: now, revocation: "none", revokeJobId: null }, null);
  });
  afterEach(async () => { await coordinator.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  function enable(kind: "follow-through" | "incoming-request" | "daily-brief", patch: Partial<RoutineInput> = {}) {
    const row = service.routines(owner).find(r => r.id === kind)!;
    return service.saveRoutine(owner, kind, row.version, { ...row.value, enabled: true, sources: kind === "incoming-request" ? [{ connectionId: "mailbox", accountId: "account" }] : [], ...patch });
  }
  function input(patch: Partial<CommitmentInput> = {}): CommitmentInput {
    return { name: "Follow through", objective: "Finish delegated work", doneCriteria: ["Record outcome evidence"], dueAt: now, timezone: "UTC", cron: null, parentTaskId: null, routineId: null, sourceRefs: [], premise: { correlationKey: "thread", after: now - 72 * HOUR, eventCursor: 0, connection: { id: "mailbox", accountId: "account", epoch: 0 }, sourceRevisions: {}, availabilityKey: null }, followUp: null, ...patch };
  }
  function event(id: string, kind = "reply", at = now): BusinessEvent { return { id, channel: "gmail", correlationKey: "thread", kind, content: {}, at, verified: true }; }
  function task() {
    const authority = coordinator.ownerAuthority(owner.principal, "chat", "request", "Finish requested work");
    return coordinator.admitTask({ channel: "chat", conversationKey: "chat:owner", replyRef: {}, requester: "owner", audience: "owner" }, authority, { objective: "Finish requested work", doneCriteria: ["Source evidence"] }, "request");
  }
  async function finish(id: string) {
    const binding = coordinator.claimRun(id)!;
    await coordinator.dispatch(binding, { ...effect, effectful: false }, async () => ({ value: "read", receipt: {}, evidenceRefs: [`source:${id}`], verified: true }));
    coordinator.complete(binding, "Verified result", [`source:${id}`]);
  }

  it("seeds visible disabled routines without granting mailbox history authority", () => {
    expect(service.routines(owner).map(r => [r.id, r.value.enabled])).toEqual(expect.arrayContaining([["incoming-request", false], ["follow-through", false], ["daily-brief", false], ["meeting-prep", false]]));
    expect(service.activeIncoming("mailbox", "account")).toEqual([]);
    expect(service.routines(owner).find(r => r.id === "follow-through")!.value.followUp).toEqual(DEFAULT_FOLLOW_UP);
  });
  it("rejects historic intake and dedupes new provider messages across a routine revision", () => {
    const routine = enable("incoming-request");
    const intake = { routineId: routine.id, event: event("old", "mail.reply", now - 1), connectionId: "mailbox", accountId: "account", sourceRefs: ["gmail:message"], objective: "Customer asks a question", doneCriteria: ["Reply"] };
    expect(service.admitIncoming(intake)).toBeUndefined();
    const admitted = service.admitIncoming({ ...intake, event: event("new", "mail.reply") })!;
    expect(service.admitIncoming({ ...intake, event: event("new", "mail.reply") })!.id).toBe(admitted.id);
    service.saveRoutine(owner, routine.id, routine.version, { ...routine.value, objective: "Handle questions using updated owner scope" });
    expect(service.admitIncoming({ ...intake, event: event("new", "mail.reply") })!.id).toBe(admitted.id);
    expect(store.tasks()).toHaveLength(1);
  });
  it("enforces in-execute owner provenance and expected versions", async () => {
    const row = enable("daily-brief");
    expect(() => service.saveRoutine(owner, row.id, 1, row.value)).toThrow(/revision/);
    const t = task(); const binding = coordinator.claimRun(t.id)!;
    expect(() => service.saveRoutine({ ...owner, taskRun: binding }, row.id, row.version, row.value)).toThrow(/direct owner/);
    const tool = createBusinessCommitmentTools(service).find(t => t.spec.name === "routine_update")!;
    const ctx: ToolContext = { ...owner, conversationKey: "worker", now: () => new Date(now), taskRun: binding };
    await expect(tool.spec.execute({ id: row.id, expectedVersion: row.version, routine: row.value }, ctx)).rejects.toThrow(/direct owner/);
    expect(() => service.routines({ ...owner, channel: "email" })).toThrow(/owner authority/);
    expect(() => service.routines({ ...owner, ownerTurn: false })).toThrow(/direct owner/);
  });
  it("revokes old standing authority when the owner edits a routine", () => {
    const row = enable("incoming-request");
    const admitted = service.admitIncoming({ routineId: row.id, event: event("mail"), connectionId: "mailbox", accountId: "account", sourceRefs: [], objective: "Question", doneCriteria: ["Answer"] })!;
    service.saveRoutine(owner, row.id, row.version, { ...row.value, enabled: false });
    expect(coordinator.claimRun(admitted.id)).toBeUndefined();
    expect(store.task(admitted.id)?.status).toBe("blocked");
  });
  it("does not lose an event immediately before wait registration or reopen terminal tasks", () => {
    const t = task(); const binding = coordinator.claimRun(t.id)!;
    coordinator.appendEvent(event("early"));
    const wait = coordinator.wait(binding, { kind: "external_event", correlationKey: "thread", eventCursor: 0, deadline: now + HOUR, requiresVerification: true });
    expect(wait.status).toBe("satisfied"); expect(wait.satisfiedBy).toBe("early");
    coordinator.appendEvent(event("early"));
    expect(store.events("thread")).toHaveLength(1);
    coordinator.control(owner.principal, t.id, "stop");
    coordinator.appendEvent(event("late"));
    expect(store.task(t.id)?.status).toBe("cancelled");
  });
  it("keeps provider challenges waiting until a verified provider event and blocks expired waits", async () => {
    const t = task(); const binding = coordinator.claimRun(t.id)!;
    coordinator.wait(binding, { kind: "provider_challenge", correlationKey: "challenge", eventCursor: 0, deadline: now + HOUR, requiresVerification: true });
    coordinator.appendEvent({ ...event("owner-done"), correlationKey: "challenge", verified: false });
    expect(store.task(t.id)?.status).toBe("waiting");
    now += 2 * HOUR; await coordinator.sweep();
    expect(store.task(t.id)?.status).toBe("blocked");
    expect(store.waits(t.id)[0]?.status).toBe("expired");
  });
  it("admits one fresh recurrence after downtime and persists dedupe over restart", async () => {
    const created = service.create(owner, input({ cron: "0 10 * * *" }), "daily");
    now += 21 * 24 * HOUR;
    await Promise.all([service.sweep(), service.sweep()]);
    expect(store.tasks()).toHaveLength(1);
    expect(store.get<BusinessCommitment>("commitment", created.id)!.value.nextCheck).toBeGreaterThan(now);
    await coordinator.close(); store.close();
    store = new BusinessStore(directory, () => now); coordinator = new BusinessCoordinator(store); service = new BusinessCommitments(coordinator);
    await service.sweep(); expect(store.tasks()).toHaveLength(1);
  });
  it("uses IANA contact windows across DST without calling elapsed hours business days", () => {
    expect(nextContactTime(Date.parse("2026-10-30T22:00:00Z"), "America/New_York", DEFAULT_FOLLOW_UP.contactHours)).toBe(Date.parse("2026-11-02T14:00:00Z"));
    expect(() => service.create(owner, input({ timezone: "invented/zone" }), "invalid-zone")).toThrow(/timezone/);
  });
  it.each(["reply", "opt_out", "owner_intervention", "source_changed", "availability_changed"])("suppresses a chase after %s", async kind => {
    enable("follow-through"); const c = service.create(owner, input({ followUp: structuredClone(DEFAULT_FOLLOW_UP) }), kind);
    coordinator.appendEvent(event(kind, kind)); await service.sweep();
    expect(store.tasks()).toHaveLength(0); expect(store.get<BusinessCommitment>("commitment", c.id)!.value.status).toBe("suppressed");
  });
  it("suppresses changed source revisions, account substitution and live availability", async () => {
    enable("follow-through");
    store.put("knowledge", "source", { text: "original" }, null);
    const value = input({ followUp: structuredClone(DEFAULT_FOLLOW_UP) }); value.premise.sourceRevisions = { "knowledge:source": 1 };
    const c = service.create(owner, value, "source");
    store.put("knowledge", "source", { text: "corrected" }, 1); await service.sweep();
    expect(store.get<BusinessCommitment>("commitment", c.id)!.value.status).toBe("suppressed");
    const other = service.create(owner, input({ followUp: structuredClone(DEFAULT_FOLLOW_UP) }), "account");
    const connection = store.get<BusinessConnection>("connection", "mailbox")!;
    store.put("connection", "mailbox", { ...connection.value, accountId: "substituted" }, connection.version); await service.sweep();
    expect(store.get<BusinessCommitment>("commitment", other.id)!.value.status).toBe("suppressed");
    store.put("connection", "mailbox", connection.value, connection.version + 1);
    liveValid = false; const availability = service.create(owner, input({ followUp: structuredClone(DEFAULT_FOLLOW_UP) }), "availability"); await service.sweep();
    expect(store.get<BusinessCommitment>("commitment", availability.id)!.value.status).toBe("suppressed");
  });
  it("rechecks a reply racing after admission immediately before dispatch", async () => {
    enable("follow-through"); const c = service.create(owner, input({ followUp: structuredClone(DEFAULT_FOLLOW_UP) }), "race");
    await service.sweep(); const taskId = store.get<BusinessCommitment>("commitment", c.id)!.value.lastTaskId!; const binding = coordinator.claimRun(taskId)!;
    coordinator.appendEvent(event("reply-after-claim")); let calls = 0;
    await expect(coordinator.dispatch(binding, effect, async () => { calls++; return { value: "sent", receipt: {}, evidenceRefs: ["mail"], verified: true }; })).rejects.toThrow(/premise/);
    expect(calls).toBe(0);
  });
  it("bounds unanswered occurrences to two, at least 72 elapsed hours apart", async () => {
    enable("follow-through"); const c = service.create(owner, input({ followUp: structuredClone(DEFAULT_FOLLOW_UP) }), "bounded");
    await service.sweep(); await finish(store.get<BusinessCommitment>("commitment", c.id)!.value.lastTaskId!);
    now += 71 * HOUR; await service.sweep(); expect(store.tasks()).toHaveLength(1);
    now += HOUR; await service.sweep(); expect(store.tasks()).toHaveLength(2);
    await finish(store.get<BusinessCommitment>("commitment", c.id)!.value.lastTaskId!);
    now += 30 * 24 * HOUR; await service.sweep(); expect(store.tasks()).toHaveLength(2);
    expect(store.get<BusinessCommitment>("commitment", c.id)!.value.status).toBe("completed");
  });
  it("workers cannot enable recurrence or widen follow-up policy, or reset count with another key", () => {
    enable("follow-through"); const t = task(); const binding = coordinator.claimRun(t.id)!;
    const { parentTaskId: _parent, ...value } = input({ followUp: structuredClone(DEFAULT_FOLLOW_UP) });
    expect(() => service.createForTask(binding, { ...value, cron: "0 8 * * *" }, "wide")).toThrow(/standing/);
    expect(() => service.createForTask(binding, { ...value, followUp: { ...DEFAULT_FOLLOW_UP, intervalHours: 1 } }, "fast")).toThrow(/owner-defined/);
    const first = service.createForTask(binding, value, "first"); const again = service.createForTask(binding, value, "different-model-key");
    expect(first.id).toBe(again.id); expect(service.commitments(owner)).toHaveLength(1);
    coordinator.control(owner.principal, t.id, "stop");
    expect(store.get<BusinessCommitment>("commitment", first.id)!.value.status).toBe("cancelled");
  });
  it("does not allow another model step to send a second chase in one occurrence", async () => {
    enable("follow-through"); const c = service.create(owner, input({ followUp: structuredClone(DEFAULT_FOLLOW_UP) }), "one-send");
    await service.sweep();
    const binding = coordinator.claimRun(store.get<BusinessCommitment>("commitment", c.id)!.value.lastTaskId!)!;
    const send: LogicalAction = { ...effect, tool: "business_google", arguments: { operation: "send", input: {} }, connection: { id: "mailbox", accountId: "account", epoch: 0, version: 1 } };
    let sends = 0;
    await coordinator.dispatch(binding, send, async () => { sends++; return { value: "sent", receipt: { id: "sent" }, evidenceRefs: ["gmail:sent"], verified: true }; });
    await expect(coordinator.dispatch(binding, { ...send, stepId: "renamed-step" }, async () => { sends++; return { value: "sent", receipt: {}, evidenceRefs: ["gmail:duplicate"], verified: true }; })).rejects.toThrow(/already attempted/);
    expect(sends).toBe(1);
  });
  it("routes schedule tools to durable storage and dedupes retries after clock advancement", async () => {
    const tool = createBusinessCommitmentTools(service).find(t => t.spec.name === "schedule_create")!;
    const ctx: ToolContext = { ...owner, conversationKey: "chat:owner", now: () => new Date(now) };
    const args = { requestId: "schedule-request", name: "Morning brief", prompt: "Prepare a source-linked brief", doneCriteria: ["Provide source-linked result"], cron: "0 8 * * *", tz: "America/New_York" };
    await tool.spec.execute(args, ctx);
    now += 24 * HOUR;
    await tool.spec.execute(args, ctx);
    expect(service.commitments(owner)).toHaveLength(1);
    await service.sweep();
    expect(store.tasks()).toHaveLength(1);
    expect(service.commitments(owner)[0]!.value.status).toBe("active");
  });
  it("starts a fresh activation window when a routine is re-enabled", () => {
    const first = enable("incoming-request");
    const disabled = service.saveRoutine(owner, first.id, first.version, { ...first.value, enabled: false });
    now += 24 * HOUR;
    const enabled = service.saveRoutine(owner, first.id, disabled.version, { ...disabled.value, enabled: true });
    expect(enabled.value.activationAt).toBe(now);
    expect(service.admitIncoming({ routineId: first.id, event: event("during-disabled", "mail.reply", now - HOUR), connectionId: "mailbox", accountId: "account", sourceRefs: [], objective: "Old message", doneCriteria: ["Handle"] })).toBeUndefined();
  });
  it("owner cancellation fences the pending occurrence and rejects stale cancellation", async () => {
    const c = service.create(owner, input(), "cancel"); await service.sweep();
    const current = store.get<BusinessCommitment>("commitment", c.id)!;
    expect(() => service.cancel(owner, c.id, c.version, "cancel")).toThrow(/revision/);
    service.cancel(owner, c.id, current.version, "No longer needed");
    expect(store.task(current.value.lastTaskId!)?.status).toBe("cancelled");
    expect(coordinator.claimRun(current.value.lastTaskId!)).toBeUndefined();
  });
});
