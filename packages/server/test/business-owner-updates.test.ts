import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { BusinessStore, type Outbox, type ToolContext } from "@open-instinct/core";
import { BusinessCoordinator, type BusinessCoordinatorOptions } from "../src/business-coordinator.js";
import { BusinessService } from "../src/business-service.js";
import { businessTaskTools } from "../src/business-task-tools.js";

const owner = { kind: "owner", id: "owner", tier: "owner" } as const;
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function fixture(options: BusinessCoordinatorOptions = {}, failSend = false) {
  const directory = mkdtempSync(join(tmpdir(), "owner-updates-"));
  const sent: string[] = [];
  const outbox: Outbox = { send: async message => { sent.push(message.text); if (failSend) throw new Error("Acceptance unknown"); } };
  let store = new BusinessStore(directory);
  let service: BusinessService;
  let coordinator = new BusinessCoordinator(store, { ...options, onTaskEvent: (task, kind) => service.taskEvent(task, kind) });
  service = new BusinessService(coordinator, outbox);
  const authority = coordinator.ownerAuthority(owner, "imessage", "request", "Check my calendar");
  const task = coordinator.admitTask({ channel: "imessage", conversationKey: "imessage:owner", replyRef: {}, requester: "owner", audience: "owner" }, authority, { objective: "Check my calendar", doneCriteria: ["Read today's events"] }, "request");
  cleanup.push(async () => { await coordinator.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return {
    get store() { return store; }, get coordinator() { return coordinator; }, get service() { return service; }, task, sent,
    async restart() {
      await coordinator.close(); store.close(); store = new BusinessStore(directory);
      coordinator = new BusinessCoordinator(store, { onTaskEvent: (current, kind) => service.taskEvent(current, kind) });
      coordinator.recover(); service = new BusinessService(coordinator, outbox);
    },
    tools() {
      const ctx: ToolContext = { principal: owner, channel: "imessage", conversationKey: `system:business:${task.id}`, now: () => new Date(), taskRun: coordinator.claimRun(task.id)!, updateTaskRun: binding => { ctx.taskRun = binding; } };
      const tools = Object.fromEntries(businessTaskTools(service).map(tool => [tool.spec.name, tool.spec]));
      return { ctx, call: (name: string, args: Record<string, unknown>) => tools[name]!.execute(args, ctx) };
    },
  };
}

it("keeps explicit checkpoints and worker final handoff text out of owner messages", async () => {
  const internal = "Reconcile provider filtering; owner blocker already accepted and must not be resent.";
  const f = fixture({ worker: async () => ({ checkpoint: { text: internal }, progress: true }) });
  const tools = f.tools();
  await tools.call("task_checkpoint", { checkpoint: { next: internal } });
  expect(f.store.task(f.task.id)!.checkpoint).toEqual({ next: internal });
  expect(f.sent).toEqual([]); expect(f.store.messages()).toEqual([]);
  f.coordinator.control(owner, "workspace", "pause");
  f.coordinator.control(owner, "workspace", "resume");
  await f.coordinator.sweep(); await f.coordinator.close();
  expect(f.store.task(f.task.id)!.checkpoint).toEqual({ text: internal });
  expect(f.sent).toEqual([]); expect(f.store.messages()).toEqual([]);
});

it("sends one plain owner question, retains task metadata, and never replays it after restart", async () => {
  const f = fixture(), tools = f.tools();
  const question = "Which calendar should I check?";
  await tools.call("ask_owner", { question });
  const wait = f.store.waits(f.task.id)[0]!;
  expect(f.sent).toEqual([question]);
  expect(f.store.messages()).toMatchObject([{ text: question, taskId: f.task.id }]);
  expect(f.store.get("notification", `wait:${wait.id}`)!.value).toMatchObject({ text: question, taskId: f.task.id, status: "accepted" });
  await f.restart();
  await f.service.taskNotice(f.store.task(f.task.id)!, `wait:${wait.id}`, question);
  await f.service.taskEvent(f.store.task(f.task.id)!, "waiting");
  expect(f.sent).toEqual([question]); expect(f.store.messages()).toHaveLength(1);
  f.coordinator.appendEvent({ id: "owner-calendar", channel: "imessage", correlationKey: wait.correlationKey, kind: "owner_information", content: { text: "Work" }, at: f.store.now(), verified: false });
  await f.tools().call("ask_owner", { question: "What time zone should I use?" });
  expect(f.sent).toEqual([question, "What time zone should I use?"]);
});

it("persists a silent internal wait without converting checkpoint notes into a notice", async () => {
  const f = fixture(), tools = f.tools();
  const update = "I can access your calendar, but I can't confirm today's events yet.";
  await f.service.taskNotice(f.task, "calendar-access", update);
  expect(f.store.get("notification", "calendar-access")!.value).toMatchObject({ status: "accepted", taskId: f.task.id });
  await tools.call("task_checkpoint", { checkpoint: { next: "Verify the provider window; the owner was already told." } });
  await tools.call("task_wait", { kind: "reconciliation", correlationKey: "calendar:window" });
  await f.service.taskEvent(f.store.task(f.task.id)!, "waiting");
  expect(f.store.waits(f.task.id)).toMatchObject([{ status: "waiting", requiresVerification: true }]);
  expect(f.sent).toEqual([update]); expect(f.store.messages()).toMatchObject([{ text: update, taskId: f.task.id }]);
  await f.restart(); await f.service.taskEvent(f.store.task(f.task.id)!, "waiting");
  expect(f.sent).toEqual([update]); expect(f.store.messages()).toHaveLength(1);
});

it("delivers an evidenced owner result once without adding a task-ID prefix", async () => {
  const f = fixture(), tools = f.tools();
  await f.coordinator.dispatch(tools.ctx.taskRun!, { stepId: "events", tool: "calendar_read", arguments: {}, sourceRevisions: {}, effectful: false }, async () => ({ value: [], receipt: { count: 0 }, evidenceRefs: ["calendar:today"], verified: true }));
  await tools.call("task_finish", { result: "You're free today. There are no events on your calendar.", criteriaEvidence: [{ criterion: 0, evidenceRefs: ["calendar:today"] }] });
  await f.coordinator.close();
  const text = "You're free today. There are no events on your calendar.";
  expect(f.sent).toEqual([text]); expect(f.store.messages()).toMatchObject([{ text, taskId: f.task.id }]);
  await f.restart(); await f.service.taskEvent(f.store.task(f.task.id)!, "completed");
  expect(f.sent).toEqual([text]); expect(f.store.messages()).toHaveLength(1);
});

it("does not resend an uncertain owner question after restart", async () => {
  const f = fixture({}, true), tools = f.tools();
  await tools.call("ask_owner", { question: "Which calendar should I check?" });
  const wait = f.store.waits(f.task.id)[0]!;
  expect(f.store.get("notification", `wait:${wait.id}`)!.value).toMatchObject({ status: "unknown" });
  await f.restart();
  await f.service.taskNotice(f.store.task(f.task.id)!, `wait:${wait.id}`, "Which calendar should I check?");
  expect(f.sent).toEqual(["Which calendar should I check?"]);
});

it("keeps raw blocker diagnostics in the task record rather than sending them", async () => {
  const f = fixture(), tools = f.tools();
  const current = f.store.task(f.task.id)!;
  const blocked = f.store.updateTask({ ...current, status: "blocked", runId: null, blocker: "Reconcile provider filtering for task8; raw transport receipt unavailable", version: current.version + 1 }, current.version);
  await f.service.taskEvent(blocked, "blocked");
  expect(f.sent).toHaveLength(1);
  expect(f.sent[0]).not.toContain(blocked.blocker!);
  expect(f.sent[0]).not.toContain(f.task.id);
  expect(f.store.task(f.task.id)!.blocker).toBe(blocked.blocker);
  expect(f.store.messages()[0]!.taskId).toBe(f.task.id);
  await expect(tools.call("ask_owner", { question: "Should never send" })).rejects.toThrow();
  expect(f.sent).toHaveLength(1);
});

it.each(["non-owner", "capped-owner", "foreground"])("does not let a %s context turn internal work into owner notices", async kind => {
  const f = fixture(), tools = f.tools();
  if (kind === "non-owner") tools.ctx.principal = { kind: "stranger", id: "other", tier: "stranger" };
  if (kind === "capped-owner") tools.ctx.principal = { ...owner, cappedFrom: "owner" };
  if (kind === "foreground") tools.ctx.ownerTurn = true;
  await expect(tools.call("ask_owner", { question: "Should never send" })).rejects.toThrow(/Server-bound business worker required/);
  expect(f.sent).toEqual([]); expect(f.store.messages()).toEqual([]); expect(f.store.waits(f.task.id)).toEqual([]);
});

it.each(["reconciliation", "timer", "external_event", "constraint"])("rejects a question on an internal %s wait before changing task state", async kind => {
  const f = fixture(), tools = f.tools();
  const before = f.store.task(f.task.id)!;
  await expect(tools.call("task_wait", { kind, correlationKey: "internal-work", question: "Owner already told; reconcile provider filters." })).rejects.toThrow(/Save internal notes with task_checkpoint/);
  expect(f.store.task(f.task.id)).toEqual(before); expect(f.store.waits(f.task.id)).toEqual([]);
  expect(f.sent).toEqual([]); expect(f.store.messages()).toEqual([]);
});

it.each(["missing_information", "provider_challenge", "connection"])("delivers a necessary %s owner request without weakening verification", async kind => {
  const f = fixture(), tools = f.tools();
  const question = kind === "missing_information" ? "Which calendar should I use?" : "Please reconnect your calendar in the app so I can check it.";
  await tools.call("task_wait", { kind, correlationKey: "calendar-owner-action", question });
  const wait = f.store.waits(f.task.id)[0]!;
  expect(f.sent).toEqual([question]);
  expect(f.store.messages()).toMatchObject([{ text: question, taskId: f.task.id }]);
  f.coordinator.appendEvent({ id: "owner-says-done", channel: "imessage", correlationKey: wait.correlationKey, kind: "owner_information", content: { text: "Done" }, at: f.store.now(), verified: false });
  expect(f.store.waits(f.task.id)[0]!.status).toBe(kind === "missing_information" ? "satisfied" : "waiting");
});
