import { randomUUID } from "node:crypto";
import { assertBusinessOwner, businessHash, isValidTimeZone, jsonValue, localParts, nextCron, parseCron, TERMINAL_TASKS } from "@open-instinct/core";
import type { BusinessAuthority, BusinessConnection, BusinessEvent, BusinessOrigin, BusinessRecordKind, BusinessStore, BusinessTask, Channel, Json, LogicalAction, Principal, TaskRunBinding, Versioned } from "@open-instinct/core";
import type { BusinessCoordinator } from "./business-coordinator.js";

export interface CommitmentOwner { principal: Principal; channel: Channel; ownerTurn: boolean; taskRun?: TaskRunBinding }
export interface ContactHours { days: number[]; startMinute: number; endMinute: number }
export interface FollowUpPolicy { maxUnanswered: number; intervalHours: number; contactHours: ContactHours }
export const DEFAULT_FOLLOW_UP: FollowUpPolicy = { maxUnanswered: 2, intervalHours: 72, contactHours: { days: [1, 2, 3, 4, 5], startMinute: 9 * 60, endMinute: 17 * 60 } };
export type RoutineKind = "incoming-request" | "follow-through" | "daily-brief" | "meeting-prep";
export interface RoutineInput {
  kind: RoutineKind; name: string; objective: string; doneCriteria: string[]; enabled: boolean;
  sources: Array<{ connectionId: string; accountId: string }>; timezone: string; cron: string | null;
  followUp: FollowUpPolicy;
}
export interface BusinessRoutine extends RoutineInput {
  id: string; activationAt: number | null; authorityRef: string | null; nextCheck: number | null;
}
export interface CommitmentPremise {
  correlationKey: string | null; after: number; eventCursor: number;
  connection: { id: string; accountId: string; epoch: number } | null;
  sourceRevisions: Record<string, number>; availabilityKey: string | null;
}
export interface CommitmentInput {
  name: string; objective: string; doneCriteria: string[]; dueAt: number; timezone: string;
  cron: string | null; parentTaskId: string | null; routineId: string | null;
  sourceRefs: string[]; premise: CommitmentPremise; followUp: FollowUpPolicy | null;
}
export interface BusinessCommitment extends CommitmentInput {
  id: string; authorityRef: string; origin: BusinessOrigin; status: "active" | "completed" | "cancelled" | "suppressed";
  nextCheck: number | null; occurrence: number; lastTaskId: string | null; lastOccurrenceAt: number | null; cancellationReason: string | null;
}
export interface PremiseResult { valid: boolean; reason?: string }
export interface BusinessCommitmentOptions {
  recheckPremise?: (commitment: BusinessCommitment) => Promise<PremiseResult>;
}
const KINDS: RoutineKind[] = ["incoming-request", "follow-through", "daily-brief", "meeting-prep"];
const STOP_EVENTS: Record<string, true> = { reply: true, "mail.reply": true, opt_out: true, owner_intervention: true, source_changed: true, availability_changed: true, work_cancelled: true };
const HOUR = 3_600_000;
function object(value: unknown): asserts value is Record<string, unknown> { jsonValue(value); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a commitment object"); }
function text(value: unknown): asserts value is string { if (typeof value !== "string" || !value.trim() || value.length > 32_768) throw new Error("Expected nonempty bounded text"); }
function number(value: unknown): asserts value is number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Expected nonnegative safe integer"); }
function strings(value: unknown): asserts value is string[] { if (!Array.isArray(value)) throw new Error("Expected text list"); for (const item of value) text(item); }
function timezone(value: unknown): asserts value is string { text(value); if (!isValidTimeZone(value)) throw new Error("Invalid IANA timezone"); }
function recurrence(value: unknown): void { if (value !== null) { text(value); parseCron(value); } }
function policy(value: unknown): void {
  object(value); number(value.maxUnanswered); if (value.maxUnanswered < 1) throw new Error("A positive bounded follow-up count is required");
  if (typeof value.intervalHours !== "number" || !Number.isFinite(value.intervalHours) || value.intervalHours <= 0) throw new Error("Invalid elapsed follow-up interval");
  object(value.contactHours); const h = value.contactHours;
  if (!Array.isArray(h.days) || !h.days.length || h.days.some(d => !Number.isInteger(d) || Number(d) < 0 || Number(d) > 6)) throw new Error("Invalid contact weekdays");
  number(h.startMinute); number(h.endMinute); if (h.startMinute >= h.endMinute || h.endMinute > 1440) throw new Error("Invalid contact hours");
}
function premise(value: unknown): void {
  object(value); if (value.correlationKey !== null) text(value.correlationKey); number(value.after); number(value.eventCursor);
  if (value.connection !== null) { object(value.connection); text(value.connection.id); text(value.connection.accountId); number(value.connection.epoch); }
  object(value.sourceRevisions); for (const [key, version] of Object.entries(value.sourceRevisions)) { sourceKey(key); number(version); }
  if (value.availabilityKey !== null) text(value.availabilityKey);
}
function sourceKey(key: string): { kind: BusinessRecordKind; id: string } {
  const colon = key.indexOf(":"); const kind = key.slice(0, colon); const id = key.slice(colon + 1);
  if (!["knowledge", "profile", "artifact"].includes(kind) || !id) throw new Error("Source revision keys must be knowledge:, profile: or artifact: IDs");
  return { kind: kind as BusinessRecordKind, id };
}
function validateRoutine(value: unknown): void {
  object(value); text(value.id); text(value.name); text(value.objective); strings(value.doneCriteria); if (!value.doneCriteria.length) throw new Error("Done criteria required");
  if (!KINDS.includes(value.kind as RoutineKind) || typeof value.enabled !== "boolean") throw new Error("Invalid routine");
  timezone(value.timezone); recurrence(value.cron); policy(value.followUp);
  if (!Array.isArray(value.sources)) throw new Error("Routine source scope required");
  for (const source of value.sources) { object(source); text(source.connectionId); text(source.accountId); }
  if (value.activationAt !== null) number(value.activationAt); if (value.nextCheck !== null) number(value.nextCheck); if (value.authorityRef !== null) text(value.authorityRef);
}
function validateCommitment(value: unknown): void {
  object(value); text(value.id); text(value.name); text(value.objective); text(value.authorityRef); strings(value.doneCriteria); strings(value.sourceRefs);
  if (!value.doneCriteria.length) throw new Error("Done criteria required"); number(value.dueAt); timezone(value.timezone); recurrence(value.cron); premise(value.premise);
  if (value.followUp !== null) policy(value.followUp);
  if (!["active", "completed", "cancelled", "suppressed"].includes(String(value.status))) throw new Error("Invalid commitment status");
  number(value.occurrence); for (const key of ["nextCheck", "lastOccurrenceAt"]) if (value[key] !== null) number(value[key]);
  for (const key of ["parentTaskId", "routineId", "lastTaskId", "cancellationReason"]) if (value[key] !== null) text(value[key]);
  object(value.origin); if (value.origin.requester !== "owner" || value.origin.audience !== "owner") throw new Error("Commitment owner origin required");
}
function owner(actor: CommitmentOwner): void {
  assertBusinessOwner(actor.principal, actor.channel);
  if (!actor.ownerTurn || actor.taskRun) throw new Error("Only a direct owner turn may change standing instructions");
}
function origin(id: string): BusinessOrigin { return { channel: "chat", conversationKey: `business:commitment:${id}`, replyRef: {}, requester: "owner", audience: "owner" }; }
function next(cron: string, after: number, zone: string): number {
  const value = nextCron(parseCron(cron), new Date(after), zone)?.getTime(); if (value === undefined) throw new Error("Recurrence has no occurrence in the next two years"); return value;
}
export function nextContactTime(at: number, zone: string, hours: ContactHours): number {
  const inside = (time: number) => { const p = localParts(new Date(time), zone); const minute = p.hour * 60 + p.minute; return hours.days.includes(p.dow) && minute >= hours.startMinute && minute < hours.endMinute; };
  if (inside(at)) return at;
  let time = Math.ceil(at / 60_000) * 60_000;
  for (let minutes = 0; minutes <= 8 * 1440; minutes++, time += 60_000) if (inside(time)) return time;
  throw new Error("No contact window in the next eight days");
}

/** Durable state only. The coordinator owns the single sweep timer and all dispatch. */
export class BusinessCommitments {
  readonly store: BusinessStore;
  constructor(readonly coordinator: BusinessCoordinator, private readonly options: BusinessCommitmentOptions = {}) { this.store = coordinator.store; }

  seedDefaults(): void {
    this.store.transaction(() => {
      for (const kind of KINDS) {
        if (this.store.get("routine", kind)) continue;
        const objective = { "incoming-request": "Handle new customer requests within the selected sources and current business rules.", "follow-through": "Follow through on delegated work; suppress chases when the current premise changes.", "daily-brief": "Prepare a source-linked daily brief of current work, deadlines and genuine blockers.", "meeting-prep": "Prepare source-linked meeting briefs for upcoming meetings in the selected calendars." }[kind];
        this.store.put<BusinessRoutine>("routine", kind, { id: kind, kind, name: kind, objective, doneCriteria: ["Provide the requested result with current source evidence"], enabled: false, sources: [], timezone: this.store.settings().value.timezone, cron: kind === "daily-brief" ? "0 8 * * *" : kind === "meeting-prep" ? "0 8 * * *" : null, followUp: structuredClone(DEFAULT_FOLLOW_UP), activationAt: null, authorityRef: null, nextCheck: null }, null, validateRoutine);
      }
    });
  }
  routines(actor: CommitmentOwner): Versioned<BusinessRoutine>[] { owner(actor); return this.store.list("routine", validateRoutine); }
  commitments(actor: CommitmentOwner): Versioned<BusinessCommitment>[] { owner(actor); return this.store.list("commitment", validateCommitment); }
  saveRoutine(actor: CommitmentOwner, id: string, expectedVersion: number, input: RoutineInput): Versioned<BusinessRoutine> {
    owner(actor); text(id); number(expectedVersion);
    return this.store.transaction(() => {
      const old = this.store.get<BusinessRoutine>("routine", id, validateRoutine);
      if (!old || old.version !== expectedVersion || old.value.kind !== input.kind) throw new Error("Routine revision conflict");
      const sameSources = businessHash(input.sources) === businessHash(old.value.sources);
      const activationAt = input.enabled ? old.value.enabled && sameSources ? old.value.activationAt! : this.store.now() : null;
      const authorityRef = input.enabled ? `routine:${id}:${expectedVersion + 1}` : null;
      const value: BusinessRoutine = { ...input, id, activationAt, authorityRef, nextCheck: input.enabled && input.cron ? next(input.cron, this.store.now(), input.timezone) : null };
      validateRoutine(value);
      if (input.enabled && ["incoming-request", "meeting-prep"].includes(input.kind) && !input.sources.length) throw new Error("Select explicit connected sources before enabling this routine");
      for (const source of input.enabled ? input.sources : []) {
        const connection = this.store.get<BusinessConnection>("connection", source.connectionId);
        if (!connection || connection.value.status !== "connected" || connection.value.accountId !== source.accountId) throw new Error("Routine source account is not connected");
      }
      if (old.value.authorityRef) {
        const authority = this.store.get<BusinessAuthority>("authority", old.value.authorityRef)!;
        this.store.put("authority", authority.id, { ...authority.value, enabled: false, version: authority.value.version + 1 }, authority.version);
      }
      if (authorityRef) this.store.put<BusinessAuthority>("authority", authorityRef, { id: authorityRef, kind: "routine", sourceId: id, enabled: true, version: 1, scope: JSON.stringify(input) }, null);
      const result = this.store.put("routine", id, value, expectedVersion, validateRoutine);
      this.store.recordActivity("routine.updated", { id, enabled: input.enabled, activationAt, version: result.version }); return result;
    });
  }
  create(actor: CommitmentOwner, input: CommitmentInput, requestId: string): Versioned<BusinessCommitment> {
    owner(actor); text(requestId);
    return this.store.transaction(() => {
      const id = `schedule:${businessHash(requestId)}`;
      const old = this.store.get<BusinessCommitment>("commitment", id, validateCommitment);
      if (old) { if (businessHash(this.inputOf(old.value)) !== businessHash(input)) throw new Error("Commitment idempotency conflict"); return old; }
      const authority = this.coordinator.ownerAuthority(actor.principal, actor.channel, `commitment:${requestId}`, input.objective);
      return this.insert(id, input, authority, origin(id));
    });
  }
  createForTask(binding: TaskRunBinding, input: Omit<CommitmentInput, "parentTaskId">, requestId: string): Versioned<BusinessCommitment> {
    return this.store.transaction(() => {
      const task = this.coordinator.assertActive(binding);
      if (input.cron || input.routineId) throw new Error("Workers cannot create or widen standing routines");
      if (input.followUp) {
        const routine = this.store.get<BusinessRoutine>("routine", "follow-through", validateRoutine);
        if (!routine?.value.enabled) throw new Error("Owner must enable the follow-through routine first");
        if (businessHash(input.followUp) !== businessHash(routine.value.followUp)) throw new Error("Worker follow-up policy must equal the owner-defined policy");
      }
      const id = `task:${task.id}:${businessHash(input.followUp ? { followUp: input.premise.correlationKey, connection: input.premise.connection } : requestId)}`;
      const value = { ...input, parentTaskId: task.id };
      const old = this.store.get<BusinessCommitment>("commitment", id, validateCommitment);
      if (old) { if (businessHash(this.inputOf(old.value)) !== businessHash(value)) throw new Error("Commitment idempotency conflict"); return old; }
      return this.insert(id, value, task.authorityRef, task.origin);
    });
  }
  private inputOf(value: BusinessCommitment): CommitmentInput {
    const { name, objective, doneCriteria, dueAt, timezone, cron, parentTaskId, routineId, sourceRefs, premise, followUp } = value;
    return { name, objective, doneCriteria, dueAt, timezone, cron, parentTaskId, routineId, sourceRefs, premise, followUp };
  }
  private insert(id: string, input: CommitmentInput, authorityRef: string, taskOrigin: BusinessOrigin): Versioned<BusinessCommitment> {
    const due = input.followUp ? Math.max(input.dueAt, input.premise.after + input.followUp.intervalHours * HOUR) : input.dueAt;
    const value: BusinessCommitment = { ...input, id, authorityRef, origin: taskOrigin, status: "active", nextCheck: due, occurrence: 0, lastTaskId: null, lastOccurrenceAt: null, cancellationReason: null };
    validateCommitment(value);
    if (input.parentTaskId && !this.store.task(input.parentTaskId)) throw new Error("Parent task not found");
    if (input.followUp && (!input.premise.correlationKey || !input.premise.connection)) throw new Error("Follow-up requires a bound account and reply correlation");
    this.assertSources(input.premise);
    const result = this.store.put("commitment", id, value, null, validateCommitment);
    this.store.recordActivity("commitment.created", { id, dueAt: due, followUp: input.followUp as unknown as Json }, input.parentTaskId); return result;
  }
  cancel(actor: CommitmentOwner, id: string, expectedVersion: number, reason: string): Versioned<BusinessCommitment> {
    owner(actor); text(reason);
    return this.store.transaction(() => {
      const row = this.store.get<BusinessCommitment>("commitment", id, validateCommitment);
      if (!row || row.version !== expectedVersion) throw new Error("Commitment revision conflict");
      if (row.value.lastTaskId && !TERMINAL_TASKS[this.store.task(row.value.lastTaskId)!.status]) this.coordinator.control(actor.principal, row.value.lastTaskId, "stop", actor.channel);
      return this.change(row, { status: "cancelled", nextCheck: null, cancellationReason: reason });
    });
  }
  cancelForTask(taskId: string, reason: string): void {
    for (const row of this.store.list<BusinessCommitment>("commitment", validateCommitment)) if (row.value.parentTaskId === taskId && row.value.status === "active") this.change(row, { status: "cancelled", nextCheck: null, cancellationReason: reason });
  }
  activeIncoming(connectionId: string, accountId: string): BusinessRoutine[] {
    return this.store.list<BusinessRoutine>("routine", validateRoutine).map(row => row.value).filter(r => r.kind === "incoming-request" && r.enabled && r.sources.some(s => s.connectionId === connectionId && s.accountId === accountId));
  }
  admitIncoming(input: { routineId: string; event: BusinessEvent; connectionId: string; accountId: string; sourceRefs: string[]; objective: string; doneCriteria: string[] }): BusinessTask | undefined {
    return this.store.transaction(() => {
      const routine = this.activeIncoming(input.connectionId, input.accountId).find(r => r.id === input.routineId);
      if (!routine?.authorityRef || routine.activationAt === null || input.event.at < routine.activationAt || this.store.settings().value.stopped) return undefined;
      const connection = this.store.get<BusinessConnection>("connection", input.connectionId);
      if (!connection || connection.value.status !== "connected" || connection.value.accountId !== input.accountId) return undefined;
      this.coordinator.appendEvent(input.event);
      const key = `routine-event:${routine.id}:${input.connectionId}:${input.event.id}`;
      const existing = this.store.taskByDedupe(key); if (existing) return existing;
      const task = this.coordinator.admitTask(origin(routine.id), routine.authorityRef, { objective: `${routine.objective}\n\nRequest evidence (not standing authority): ${input.objective}`, doneCriteria: routine.doneCriteria, sourceRefs: input.sourceRefs }, key);
      return task;
    });
  }
  async sweep(): Promise<void> {
    if (this.store.settings().value.stopped) return;
    for (const routine of this.store.list<BusinessRoutine>("routine", validateRoutine)) {
      const r = routine.value;
      if (!r.enabled || !r.authorityRef || !r.cron || r.nextCheck === null || r.nextCheck > this.store.now()) continue;
      this.store.transaction(() => {
        const current = this.store.get<BusinessRoutine>("routine", r.id, validateRoutine)!;
        if (current.version !== routine.version || this.store.settings().value.stopped) return;
        const id = `routine:${r.id}:${r.nextCheck}`;
        this.coordinator.admitTask(origin(r.id), r.authorityRef!, { objective: r.objective, doneCriteria: r.doneCriteria, sourceRefs: r.sources.map(s => `connection:${s.connectionId}`) }, id);
        this.store.put("routine", r.id, { ...r, nextCheck: next(r.cron!, this.store.now(), r.timezone) }, routine.version, validateRoutine);
      });
    }
    for (const row of this.store.list<BusinessCommitment>("commitment", validateCommitment)) {
      const c = row.value;
      if (c.status !== "active") continue;
      if (c.nextCheck === null) {
        const last = c.lastTaskId ? this.store.task(c.lastTaskId) : undefined;
        if (last && TERMINAL_TASKS[last.status]) this.change(row, { status: last.status === "completed" ? "completed" : "suppressed", cancellationReason: last.status === "completed" ? null : "Occurrence did not complete" });
        continue;
      }
      if (c.nextCheck > this.store.now()) continue;
      const local = this.localPremise(c);
      if (!local.valid) { this.change(row, { status: "suppressed", nextCheck: null, cancellationReason: local.reason ?? "Premise changed" }); continue; }
      if (c.lastTaskId) {
        const last = this.store.task(c.lastTaskId)!;
        if (!TERMINAL_TASKS[last.status]) continue;
        if (last.status !== "completed") { this.change(row, { status: "suppressed", nextCheck: null, cancellationReason: "Previous occurrence did not complete" }); continue; }
      }
      if (c.followUp) {
        const after = c.lastTaskId ? Math.max(c.lastOccurrenceAt!, ...this.store.actions(c.lastTaskId).filter(a => a.effectful).map(a => a.updatedAt)) : c.premise.after;
        const due = nextContactTime(Math.max(this.store.now(), after + c.followUp.intervalHours * HOUR), c.timezone, c.followUp.contactHours);
        if (due > this.store.now()) { this.change(row, { nextCheck: due }); continue; }
      }
      const remote = await this.currentPremise(c);
      this.store.transaction(() => {
        const current = this.store.get<BusinessCommitment>("commitment", c.id, validateCommitment)!;
        if (current.version !== row.version || this.store.settings().value.stopped) return;
        const rechecked = this.localPremise(c);
        if (!remote.valid || !rechecked.valid) { this.change(current, { status: "suppressed", nextCheck: null, cancellationReason: remote.reason ?? rechecked.reason ?? "Premise changed" }); return; }
        const occurrence = c.occurrence + 1;
        const task = this.coordinator.admitTask(c.origin, c.authorityRef, { objective: c.objective, doneCriteria: c.doneCriteria, sourceRefs: c.sourceRefs }, `commitment:${c.id}:${occurrence}`);
        this.store.put("cursor", `commitment-task:${task.id}`, { commitmentId: c.id, occurrence }, null);
        const nextCheck = c.followUp ? occurrence < c.followUp.maxUnanswered ? this.store.now() + c.followUp.intervalHours * HOUR : null : c.cron ? next(c.cron, this.store.now(), c.timezone) : null;
        this.change(current, { occurrence, lastTaskId: task.id, lastOccurrenceAt: this.store.now(), nextCheck });
      });
    }
  }
  /** Invoke immediately before each external effect, including resumed task effects. */
  async assertDispatch(binding: TaskRunBinding, action: LogicalAction): Promise<void> {
    if (!action.effectful) return;
    const authority = this.store.get<BusinessAuthority>("authority", binding.authorityRef)?.value;
    if (authority?.kind === "routine") {
      const routine = this.store.get<BusinessRoutine>("routine", authority.sourceId, validateRoutine)?.value;
      if (!routine?.enabled || routine.authorityRef !== binding.authorityRef) throw new Error("Routine authority changed");
      if (action.connection && !routine.sources.some(source => source.connectionId === action.connection!.id && source.accountId === action.connection!.accountId)) throw new Error("Effect account is outside the owner-defined routine scope");
      for (const source of routine.sources) {
        const connection = this.store.get<BusinessConnection>("connection", source.connectionId)?.value;
        if (!connection || connection.status !== "connected" || connection.accountId !== source.accountId) throw new Error("Routine account disconnected or substituted");
      }
    }
    const occurrence = this.store.get<{ commitmentId: string; occurrence: number }>("cursor", `commitment-task:${binding.taskId}`);
    if (!occurrence) return;
    const row = this.store.get<BusinessCommitment>("commitment", occurrence.value.commitmentId, validateCommitment)!;
    const c = row.value;
    if (c.status === "cancelled" || c.status === "suppressed" || c.occurrence !== occurrence.value.occurrence || c.lastTaskId !== binding.taskId) throw new Error("Commitment occurrence cancelled or superseded");
    const local = this.localPremise(c); if (!local.valid) throw new Error(local.reason);
    if (c.followUp && nextContactTime(this.store.now(), c.timezone, c.followUp.contactHours) !== this.store.now()) throw new Error("Outside owner-defined contact hours; wait for next contact window");
    const remote = await this.currentPremise(c);
    const latest = this.store.get<BusinessCommitment>("commitment", c.id, validateCommitment)!;
    if (latest.version !== row.version || !remote.valid) throw new Error(remote.reason ?? "Commitment changed during premise check");
    const final = this.localPremise(latest.value); if (!final.valid) throw new Error(final.reason);
    if (c.followUp && nextContactTime(this.store.now(), c.timezone, c.followUp.contactHours) !== this.store.now()) throw new Error("Contact window ended during the provider premise check");
    if (c.followUp && action.tool === "business_google" && action.arguments && typeof action.arguments === "object" && !Array.isArray(action.arguments) && action.arguments.operation === "send") {
      if (action.connection?.accountId !== c.premise.connection?.accountId || action.connection?.id !== c.premise.connection?.id) throw new Error("Follow-up send must use its original bound account");
      if (this.store.actions(binding.taskId).some(previous => previous.effectful && previous.tool === "business_google" && previous.arguments && typeof previous.arguments === "object" && !Array.isArray(previous.arguments) && previous.arguments.operation === "send" && !["cancelled", "superseded"].includes(previous.status))) throw new Error("This follow-up occurrence already attempted its customer message");
    }
  }
  private async currentPremise(c: BusinessCommitment): Promise<PremiseResult> {
    if (!c.followUp && c.premise.availabilityKey === null) return { valid: true };
    if (!this.options.recheckPremise) return { valid: false, reason: "Live provider premise verification is unavailable" };
    return this.options.recheckPremise(c);
  }
  private assertSources(p: CommitmentPremise): void {
    for (const [key, version] of Object.entries(p.sourceRevisions)) { const { kind, id } = sourceKey(key); if (this.store.get(kind, id)?.version !== version) throw new Error("Source revision changed"); }
  }
  private localPremise(c: BusinessCommitment): PremiseResult {
    const invalid = (reason: string) => ({ valid: false, reason });
    if (!this.store.get<BusinessAuthority>("authority", c.authorityRef)?.value.enabled) return invalid("Execution authority disabled");
    if (c.parentTaskId) { const parent = this.store.task(c.parentTaskId); if (!parent || ["cancelled", "failed"].includes(parent.status)) return invalid("Parent objective cancelled or failed"); }
    if (c.routineId || c.followUp) { const routine = this.store.get<BusinessRoutine>("routine", c.routineId ?? "follow-through", validateRoutine)?.value; if (!routine?.enabled) return invalid("Routine disabled"); if (c.followUp && businessHash(c.followUp) !== businessHash(routine.followUp)) return invalid("Owner follow-up policy changed"); }
    if (c.premise.connection) { const expected = c.premise.connection; const actual = this.store.get<BusinessConnection>("connection", expected.id)?.value; if (!actual || actual.status !== "connected" || actual.accountId !== expected.accountId || actual.epoch !== expected.epoch) return invalid("Source account disabled or changed"); }
    try { this.assertSources(c.premise); } catch { return invalid("Source revision changed"); }
    if (c.premise.correlationKey && this.store.events(c.premise.correlationKey, c.premise.eventCursor).some(e => e.value.at >= c.premise.after && STOP_EVENTS[e.value.kind] === true)) return invalid("Reply, opt-out, owner intervention or changed premise observed");
    return { valid: true };
  }
  private change(row: Versioned<BusinessCommitment>, patch: Partial<BusinessCommitment>): Versioned<BusinessCommitment> {
    const result = this.store.put("commitment", row.id, { ...row.value, ...patch }, row.version, validateCommitment);
    this.store.recordActivity("commitment.updated", { id: row.id, status: result.value.status, nextCheck: result.value.nextCheck, reason: result.value.cancellationReason }, result.value.parentTaskId); return result;
  }
}
