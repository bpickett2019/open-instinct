import { randomUUID } from "node:crypto";
import { BusinessStore, businessHash, canonicalJson, assertBusinessOwner, TERMINAL_TASKS } from "@open-instinct/core";
import type { BusinessAction, BusinessAuthority, BusinessConnection, BusinessEvent, BusinessOrigin, BusinessTask, BusinessTaskRequest, BusinessWait, Channel, DispatchOutcome, Json, LogicalAction, Principal, TaskRunBinding } from "@open-instinct/core";

export interface BusinessWorkerResult { checkpoint: Json; result?: string; evidenceRefs?: string[]; progress: boolean }
export interface BusinessCoordinatorOptions {
  worker?: (binding: TaskRunBinding, task: BusinessTask, signal: AbortSignal) => Promise<BusinessWorkerResult>;
  audit?: (kind: string, detail: Json) => void;
  reconcile?: (action: BusinessAction) => Promise<{ verified: boolean; receipt: Json; evidenceRefs: string[] } | undefined>;
  onTaskEvent?: (task: BusinessTask, kind: "completed" | "blocked" | "waiting") => Promise<void>;
  dueWork?: () => Promise<void>;
  beforeDispatch?: (binding: TaskRunBinding, action: LogicalAction) => Promise<void>;
  cancelCommitments?: (taskId: string, reason: string) => void;
}
const CONTROL_OPERATIONS = ["pause", "resume", "stop", "close"] as const;
export type BusinessControl = typeof CONTROL_OPERATIONS[number];

/** Only this service admits authority, claims execution and transitions effect records. */
export class BusinessCoordinator {
  private readonly active = new Map<string, AbortController>();
  private readonly effects = new Set<string>();
  private computerLease: string | undefined;
  private timer?: ReturnType<typeof setInterval>;
  private sweeping = false;
  private closing = false;
  private readonly workers = new Set<Promise<void>>();
  private sweepPromise?: Promise<void>;
  private readonly notices = new Set<Promise<void>>();
  private readonly sliceDeadlines = new Map<string, number>();
  private readonly externalOperations = new Set<string>();
  constructor(readonly store: BusinessStore, private readonly options: BusinessCoordinatorOptions = {}) {}

  ownerAuthority(principal: Principal, channel: Channel, sourceId: string, scope: string): string {
    assertBusinessOwner(principal, channel); if (!sourceId || !scope.trim()) throw new Error("Authority source and scope required");
    const id = `owner:${sourceId}`;
    const existing = this.store.get<BusinessAuthority>("authority", id);
    if (existing) {
      if (existing.value.scope !== scope || !existing.value.enabled) throw new Error("Authority source conflict");
      return id;
    }
    this.store.put<BusinessAuthority>("authority", id, { id, kind: "owner", sourceId, enabled: true, version: 1, scope }, null);
    return id;
  }
  admitTask(origin: BusinessOrigin, authorityRef: string, request: BusinessTaskRequest, dedupeKey: string): BusinessTask {
    if (this.closing) throw new Error("Business admission is closed");
    if (!request.objective.trim() || !request.doneCriteria.length || request.doneCriteria.some(x => !x.trim())) throw new Error("Objective and done criteria required");
    return this.store.transaction(() => {
      const authority = this.store.get<BusinessAuthority>("authority", authorityRef);
      if (!authority?.value.enabled || origin.audience !== "owner" || origin.requester !== "owner") throw new Error("Business authority required");
      const existing = this.store.taskByDedupe(dedupeKey);
      if (existing) {
        if (existing.objective !== request.objective || existing.authorityRef !== authorityRef) throw new Error("Admission idempotency conflict");
        return existing;
      }
      const settings = this.store.settings().value;
      const task: BusinessTask = {
        id: randomUUID(), workspaceId: settings.workspaceId, objective: request.objective, doneCriteria: request.doneCriteria,
        origin, authorityRef, sourceRefs: request.sourceRefs ?? [], version: 1, status: "queued", executionEpoch: 0, runId: null,
        checkpoint: null, result: null, evidenceRefs: [], blocker: null, nextWake: null, dispatches: 0, noProgress: 0,
        createdAt: this.store.now(), updatedAt: this.store.now(),
      };
      this.store.insertTask(task, dedupeKey); this.event("task.admitted", { objective: task.objective }, task.id);
      return task;
    });
  }
  claimRun(taskId: string): TaskRunBinding | undefined {
    return this.store.transaction(() => {
      const task = this.requireTask(taskId); const settings = this.store.settings().value;
      if (this.closing || settings.stopped || task.status !== "queued" || task.nextWake !== null && task.nextWake > this.store.now()) return undefined;
      if (this.store.actions(taskId).some(action => action.effectful && ["unknown", "accepted", "dispatching"].includes(action.status))) {
        this.mutate(task, { status: "blocked", blocker: "Reconcile prior effects before dispatch" }); return undefined;
      }
      const authority = this.store.get<BusinessAuthority>("authority", task.authorityRef);
      if (!authority?.value.enabled) { this.mutate(task, { status: "blocked", blocker: "Execution authority disabled" }); return undefined; }
      const updated = this.mutate(task, { status: "running", runId: randomUUID(), executionEpoch: task.executionEpoch + 1 });
      return Object.freeze({ taskId, runId: updated.runId!, taskRevision: updated.version, executionEpoch: updated.executionEpoch, globalControlEpoch: settings.globalControlEpoch, authorityRef: task.authorityRef });
    });
  }
  assertActive(binding: TaskRunBinding): BusinessTask {
    const task = this.requireTask(binding.taskId); const settings = this.store.settings().value;
    const authority = this.store.get<BusinessAuthority>("authority", binding.authorityRef);
    if (this.closing || settings.stopped || settings.globalControlEpoch !== binding.globalControlEpoch || task.status !== "running" || task.runId !== binding.runId || task.executionEpoch !== binding.executionEpoch || task.version !== binding.taskRevision || task.authorityRef !== binding.authorityRef || !authority?.value.enabled) throw new Error("Business execution fenced");
    return task;
  }
  checkpoint(binding: TaskRunBinding, value: Json): TaskRunBinding {
    return this.store.transaction(() => {
      const task = this.assertActive(binding); const updated = this.mutate(task, { checkpoint: value });
      return Object.freeze({ ...binding, taskRevision: updated.version });
    });
  }
  editTask(owner: Principal, id: string, expectedVersion: number, patch: { objective: string; doneCriteria: string[] }): BusinessTask {
    assertBusinessOwner(owner, "chat");
    return this.store.transaction(() => {
      const task = this.requireTask(id);
      if (task.version !== expectedVersion || TERMINAL_TASKS[task.status]) throw new Error("Task revision conflict or terminal task; make a new request");
      if (!patch.objective.trim() || !patch.doneCriteria.length || patch.doneCriteria.some(value => !value.trim())) throw new Error("Objective and done criteria required");
      const authorityRef = this.ownerAuthority(owner, "chat", `edit:${id}:${expectedVersion + 1}`, patch.objective);
      const oldRunId = task.runId;
      const revised = this.mutate(task, { ...patch, authorityRef, status: "queued", runId: null, executionEpoch: task.executionEpoch + 1, blocker: null });
      const sources = this.store.get("cursor", `task-sources:${id}`);
      if (sources) this.store.put("cursor", sources.id, { revisions: {} }, sources.version);
      this.options.cancelCommitments?.(id, "Owner changed the task premise");
      if (oldRunId) this.active.get(oldRunId)?.abort();
      this.event("task.edited", { previousVersion: expectedVersion, objective: patch.objective }, id);
      return revised;
    });
  }
  async dispatch<T>(binding: TaskRunBinding, logicalAction: LogicalAction, invoke: (signal: AbortSignal) => Promise<DispatchOutcome<T>>): Promise<T> {
    const deadline = this.sliceDeadlines.get(binding.runId);
    if (deadline !== undefined && Date.now() >= deadline) throw new Error("Reasoning slice elapsed; checkpoint and continue on the next run");
    if (logicalAction.effectful) await this.options.beforeDispatch?.(binding, logicalAction);
    if (this.effects.has(binding.taskId)) throw new Error("Task effects must be serialized");
    const computer = ["computer", "computer_batch", "computer_type_credential", "computer_import_artifact", "run_shell", "shell", "get_computer", "read_file", "write_file", "request_takeover", "takeover_status"].includes(logicalAction.tool);
    if (computer && this.computerLease && this.computerLease !== binding.taskId) throw new Error("Computer leased by another task");
    const action = this.store.transaction(() => {
      this.assertActive(binding);
      if (logicalAction.effectful && this.store.actions(binding.taskId).some(prior => prior.effectful && ["dispatching", "accepted", "unknown"].includes(prior.status))) throw new Error("Reconcile uncertain prior effects before any new consequential action");
      const previous = this.store.actionForStep(binding.taskId, logicalAction.stepId);
      if (previous) {
        if (previous.argsHash !== businessHash(logicalAction.arguments) || previous.tool !== logicalAction.tool) throw new Error("Logical action is immutable; replan requires a new sourced step");
        if (previous.status !== "prepared") throw new Error(`Logical action already ${previous.status}; inspect evidence, never replay`);
        this.assertDispatch(binding, logicalAction);
        this.store.assertReservation(previous);
        return this.store.updateAction({ ...previous, ...logicalAction, runId: binding.runId, taskRevision: binding.taskRevision, version: previous.version + 1, updatedAt: this.store.now() }, previous.version);
      }
      this.checkConnection(logicalAction);
      for (const [id, revision] of Object.entries(logicalAction.sourceRevisions)) this.assertSource(id, revision);
      const value: BusinessAction = { ...logicalAction, id: randomUUID(), taskId: binding.taskId, taskRevision: binding.taskRevision, version: 1, argsHash: businessHash(logicalAction.arguments), status: "prepared", runId: binding.runId, receipt: null, evidenceRefs: [], error: null, createdAt: this.store.now(), updatedAt: this.store.now() };
      this.store.insertAction(value); this.store.reserve(value);
      this.event("action.prepared", { tool: value.tool, argsHash: value.argsHash }, value.taskId, value.id);
      return value;
    });
    this.effects.add(binding.taskId); if (computer) this.computerLease = binding.taskId;
    if (logicalAction.tool !== "model_turn") this.externalOperations.add(binding.taskId);
    const ownsController = !this.active.has(binding.runId);
    const controller = this.active.get(binding.runId) ?? new AbortController();
    if (ownsController) this.active.set(binding.runId, controller);
    try {
      // Preparation is durable before the attempt marker. No await separates this
      // final transaction/fence from adapter invocation.
      this.store.transaction(() => {
        this.assertDispatch(binding, logicalAction);
        const current = this.store.action(action.id)!;
        if (current.status !== "prepared") throw new Error("Prepared action is no longer dispatchable");
        this.store.assertReservation(current);
        this.store.updateAction({ ...current, status: "dispatching", version: current.version + 1, updatedAt: this.store.now() }, current.version);
        this.event("action.dispatching", { tool: current.tool, argsHash: current.argsHash }, current.taskId, current.id);
      });
      const outcome = await invoke(AbortSignal.any([controller.signal, AbortSignal.timeout(180_000)]));
      this.store.transaction(() => {
        const current = this.store.action(action.id)!;
        const verified = outcome.verified && outcome.evidenceRefs.length > 0;
        this.store.updateAction({ ...current, status: verified ? "verified" : "accepted", receipt: outcome.receipt, evidenceRefs: outcome.evidenceRefs, updatedAt: this.store.now(), version: current.version + 1 }, current.version);
        if (verified) this.store.settleReservation(action.id, true, outcome.actualAmountMinor);
        this.event(verified ? "action.verified" : "action.accepted", { evidenceRefs: outcome.evidenceRefs, late: this.store.settings().value.stopped || this.requireTask(binding.taskId).runId !== binding.runId }, binding.taskId, action.id);
      });
      return outcome.value;
    } catch (error) {
      // Once attempted, even abort/error may follow provider acceptance. Retain allowance.
      this.store.transaction(() => {
        const current = this.store.action(action.id)!;
        if (["dispatching", "accepted"].includes(current.status)) {
          const uncertain = current.effectful || Boolean(current.allowance) || current.tool === "model_turn";
          this.store.updateAction({ ...current, status: uncertain ? "unknown" : "failed", error: uncertain ? "Adapter did not establish an outcome; reconciliation required" : "Read failed", version: current.version + 1, updatedAt: this.store.now() }, current.version);
          if (!uncertain) this.store.settleReservation(action.id, false);
          this.event(uncertain ? "action.unknown" : "action.failed", { tool: action.tool }, binding.taskId, action.id);
        } else if (current.status === "prepared") {
          this.event("action.preparation_blocked", { tool: action.tool }, binding.taskId, action.id);
        }
      });
      throw error;
    } finally {
      this.effects.delete(binding.taskId); this.externalOperations.delete(binding.taskId);
      if (deadline !== undefined && Date.now() >= deadline) controller.abort();
      if (ownsController) { this.active.delete(binding.runId); this.releaseComputer(binding.taskId); }
    }
  }
  assertDispatch(binding: TaskRunBinding, action: LogicalAction): void {
    this.assertActive(binding); this.checkConnection(action);
    for (const [source, revision] of Object.entries(action.sourceRevisions)) this.assertSource(source, revision);
  }
  invoke<T>(binding: TaskRunBinding, action: LogicalAction, call: (signal: AbortSignal) => Promise<DispatchOutcome<T>>): Promise<T> { return this.dispatch(binding, action, call); }
  recordReceipt(binding: TaskRunBinding, stepId: string, receipt: Json): void {
    this.store.transaction(() => {
      const action = this.store.actionForStep(binding.taskId, stepId);
      if (!action || action.runId !== binding.runId || !["dispatching", "accepted"].includes(action.status)) throw new Error("Receipt has no matching dispatched action");
      this.store.updateAction({ ...action, receipt, status: "accepted", version: action.version + 1, updatedAt: this.store.now() }, action.version);
      this.event("action.receipt", { evidenceLevel: "accepted-not-verified" }, action.taskId, action.id);
    });
  }
  sourceRevisions(taskId: string): Record<string, number> {
    return this.store.get<{ revisions: Record<string, number> }>("cursor", `task-sources:${taskId}`)?.value.revisions ?? {};
  }
  recordSource(binding: TaskRunBinding, sourceId: string, revision: number): void {
    this.store.transaction(() => {
      this.assertActive(binding); this.assertSource(sourceId, revision);
      const id = `task-sources:${binding.taskId}`;
      const prior = this.store.get<{ revisions: Record<string, number> }>("cursor", id);
      const revisions = { ...prior?.value.revisions, [sourceId]: revision };
      // Consuming the replacement retires its ancestors, not unrelated stale inputs.
      if (!sourceId.startsWith("profile:")) {
        const seen = new Set<string>();
        let ancestor = this.store.get<Record<string, Json>>("knowledge", sourceId.replace(/^knowledge:/, ""))?.value.supersedes;
        while (typeof ancestor === "string" && !seen.has(ancestor)) {
          seen.add(ancestor); delete revisions[ancestor]; delete revisions[`knowledge:${ancestor}`];
          ancestor = this.store.get<Record<string, Json>>("knowledge", ancestor)?.value.supersedes;
        }
      }
      this.store.put("cursor", id, { revisions }, prior?.version ?? null);
    });
  }
  private assertSource(key: string, revision: number): void {
    const kind = key.startsWith("profile:") ? "profile" : "knowledge";
    const id = key.startsWith(`${kind}:`) ? key.slice(kind.length + 1) : key;
    const source = this.store.get<Record<string, Json>>(kind, id);
    if (!source || source.version !== revision || source.value.deleted === true || typeof source.value.supersededBy === "string") throw new Error(`Source revision changed or retired: ${key}`);
  }
  async withComputerLease<T>(binding: TaskRunBinding, invoke: () => Promise<T>): Promise<T> {
    this.assertActive(binding);
    if (this.computerLease && this.computerLease !== binding.taskId) throw new Error("Computer leased by another task");
    this.computerLease = binding.taskId;
    return invoke();
  }
  private checkConnection(action: LogicalAction): void {
    if (!action.connection) return;
    const connection = this.store.get<BusinessConnection>("connection", action.connection.id);
    if (!connection || connection.version !== action.connection.version || connection.value.epoch !== action.connection.epoch || connection.value.accountId !== action.connection.accountId || connection.value.status !== "connected") throw new Error("Connection disabled, changed or not verified");
  }
  wait(binding: TaskRunBinding, specification: Omit<BusinessWait, "id" | "taskId" | "status" | "satisfiedBy">): BusinessWait {
    return this.store.transaction(() => {
      const task = this.assertActive(binding);
      const cursorId = `wait-event:${task.id}:${businessHash(specification.correlationKey)}`;
      const consumed = this.store.get<{ cursor: number }>("cursor", cursorId)?.value.cursor ?? 0;
      const eventCursor = Math.max(specification.eventCursor, consumed);
      const matching = this.store.events(specification.correlationKey, eventCursor).find(event => !specification.requiresVerification || event.value.verified);
      if (matching) this.consumeEvent(task.id, specification.correlationKey, matching.cursor);
      const wait: BusinessWait = { ...specification, eventCursor, id: randomUUID(), taskId: task.id, status: matching ? "satisfied" : "waiting", satisfiedBy: matching?.value.id ?? null };
      this.store.putWait(wait, null);
      this.mutate(task, { status: matching ? "queued" : "waiting", runId: null, nextWake: specification.deadline });
      this.releaseComputer(task.id); return wait;
    });
  }
  private consumeEvent(taskId: string, correlationKey: string, cursor: number): void {
    const id = `wait-event:${taskId}:${businessHash(correlationKey)}`;
    const prior = this.store.get<{ cursor: number }>("cursor", id);
    if (!prior || cursor > prior.value.cursor) this.store.put("cursor", id, { cursor }, prior?.version ?? null);
  }
  appendEvent(event: BusinessEvent): void {
    this.store.transaction(() => {
      const admitted = this.store.appendEvent(event); if (!admitted.inserted) return;
      for (const wait of this.store.waits()) {
        if (wait.status !== "waiting" || wait.correlationKey !== event.correlationKey || admitted.cursor <= wait.eventCursor || wait.requiresVerification && !event.verified) continue;
        const task = this.requireTask(wait.taskId); if (TERMINAL_TASKS[task.status]) continue;
        this.consumeEvent(task.id, wait.correlationKey, admitted.cursor);
        this.store.putWait({ ...wait, status: "satisfied", satisfiedBy: event.id }, "waiting");
        if (task.status === "waiting") this.mutate(task, { status: "queued", nextWake: null });
      }
    });
  }
  complete(binding: TaskRunBinding, result: string, evidenceRefs: string[], criteriaEvidence?: Array<{ criterion: number; evidenceRefs: string[] }>): BusinessTask {
    return this.store.transaction(() => {
      const task = this.assertActive(binding); const actions = this.store.actions(task.id);
      for (const [source, revision] of Object.entries(this.sourceRevisions(task.id))) this.assertSource(source, revision);
      if (!result.trim() || !evidenceRefs.length) throw new Error("Outcome evidence required for completion");
      const coverage = criteriaEvidence ?? (task.doneCriteria.length === 1 ? [{ criterion: 0, evidenceRefs }] : []);
      if (task.doneCriteria.some((_, index) => !coverage.some(item => item.criterion === index && item.evidenceRefs.length > 0))) throw new Error("Every done criterion needs outcome evidence");
      if (coverage.some(item => !Number.isInteger(item.criterion) || item.criterion < 0 || item.criterion >= task.doneCriteria.length || item.evidenceRefs.some(ref => !evidenceRefs.includes(ref)))) throw new Error("Invalid criterion evidence");
      if (actions.some(action => ["prepared", "dispatching", "accepted", "unknown"].includes(action.status))) throw new Error("Unresolved actions prevent completion");
      const known = new Set(actions.filter(action => action.status === "verified" && action.tool !== "model_turn" && !(action.receipt && typeof action.receipt === "object" && !Array.isArray(action.receipt) && action.receipt.evidenceLevel === "primitive-only")).flatMap(action => action.evidenceRefs));
      for (const ref of evidenceRefs) if (!known.has(ref)) throw new Error("Completion evidence must come from a verified action in this task, not an arbitrary stored record");
      for (const action of actions) if (action.evidenceRefs.some(ref => evidenceRefs.includes(ref))) {
        for (const [source, revision] of Object.entries(action.sourceRevisions)) this.assertSource(source, revision);
      }
      const completed = this.mutate(task, { status: "completed", result, evidenceRefs, runId: null, dispatches: actions.length, checkpoint: { criteriaEvidence: coverage, verdicts: { toolExecution: "verified", requestedOutcome: "evidence-linked", businessOutcome: "unknown" } } });
      this.store.appendMessage({ id: `task-result:${task.id}:${completed.version}`, channel: task.origin.channel, thread: task.origin.conversationKey, role: "assistant", text: result, taskId: task.id, artifactIds: evidenceRefs.filter(ref => ref.startsWith("artifact:")).map(ref => ref.slice("artifact:".length)).filter(id => Boolean(this.store.get("artifact", id))), at: this.store.now() });
      this.event("task.completed", { result, evidenceRefs }, task.id); this.releaseComputer(task.id);
      this.notifyTask(completed, "completed");
      return completed;
    });
  }
  control(authenticatedOwner: Principal, target: string | "workspace", operation: BusinessControl, channel: Channel = "chat"): void {
    assertBusinessOwner(authenticatedOwner, channel);
    this.store.transaction(() => {
      if (target === "workspace") {
        if (operation !== "pause" && operation !== "resume") throw new Error("Use pause or resume for workspace control");
        const settings = this.store.settings();
        this.store.updateSettings(settings.version, { ...settings.value, stopped: operation === "pause", globalControlEpoch: settings.value.globalControlEpoch + 1 });
        for (const task of this.store.tasks()) if (task.status === "running") this.mutate(task, { status: "queued", runId: null, executionEpoch: task.executionEpoch + 1 });
        this.event(`workspace.${operation}`, { outstanding: this.store.actions().filter(a => ["dispatching", "unknown", "accepted"].includes(a.status)).map(a => a.id) });
      } else {
        if (operation !== "stop" && operation !== "close") throw new Error("Task controls are stop or close");
        const task = this.requireTask(target);
        this.options.cancelCommitments?.(target, "Owner stopped the task");
        if (!TERMINAL_TASKS[task.status]) this.mutate(task, { status: "cancelled", runId: null, executionEpoch: task.executionEpoch + 1, blocker: operation === "close" ? "Closed by owner" : "Stopped by owner" });
        for (const action of this.store.actions(target)) if (action.status === "prepared") { this.store.updateAction({ ...action, status: "cancelled", version: action.version + 1 }, action.version); this.store.settleReservation(action.id, false); }
        for (const wait of this.store.waits(target)) if (wait.status === "waiting") this.store.putWait({ ...wait, status: "cancelled" }, "waiting");
        this.event(`task.${operation}`, {}, target); this.releaseComputer(target);
      }
    });
    for (const [runId, controller] of this.active) if (target === "workspace" || this.store.tasks().some(task => task.id === target && this.store.actions(task.id).some(action => action.runId === runId))) controller.abort();
  }
  recover(): void {
    this.store.transaction(() => {
      for (const wait of this.store.waits()) if (wait.status === "satisfied" && wait.satisfiedBy) {
        const cursor = this.store.eventCursor(wait.satisfiedBy);
        if (cursor !== undefined) this.consumeEvent(wait.taskId, wait.correlationKey, cursor);
      }
      for (const notice of this.store.list<Record<string, Json>>("notification")) if (notice.value.status === "dispatching") {
        this.store.put("notification", notice.id, { ...notice.value, status: "unknown", note: "Controller restarted during a notification attempt; carrier acceptance is unknown. Never automatically resend." }, notice.version);
        this.event("notification.unknown", { notificationId: notice.id });
      }
      const attemptedUsage = this.store.list<Record<string, Json>>("usage").filter(record => record.value.status === "attempted");
      if (attemptedUsage.length) {
        for (const record of attemptedUsage) this.store.put("usage", record.id, { ...record.value, status: "unknown" }, record.version);
        const settings = this.store.settings(); settings.value.usage.modelPriceUnknown = true; this.store.updateSettings(settings.version, settings.value);
      }
      for (const action of this.store.actions()) if (action.status === "prepared" && !action.effectful) {
        this.store.updateAction({ ...action, status: "cancelled", version: action.version + 1, error: "Unattempted run-local read/model preparation retired on restart" }, action.version);
        this.store.settleReservation(action.id, false);
      }
      for (const action of this.store.actions()) if (action.status === "dispatching") this.store.updateAction({ ...action, status: "unknown", version: action.version + 1, error: "Controller restarted after recording attempt" }, action.version);
      for (const task of this.store.tasks()) if (task.status === "running") {
        const unknown = this.store.actions(task.id).some(action => ["unknown", "accepted"].includes(action.status));
        this.mutate(task, { status: unknown ? "blocked" : "queued", blocker: unknown ? "Reconcile prior effects before continuing" : null, runId: null, executionEpoch: task.executionEpoch + 1 });
      }
    });
  }
  start(): void {
    this.recover(); void this.sweep(); this.timer = setInterval(() => void this.sweep(), 30_000); this.timer.unref();
  }
  sweep(): Promise<void> {
    if (this.sweeping || this.closing) return this.sweepPromise ?? Promise.resolve();
    this.sweepPromise = this.runSweep();
    return this.sweepPromise;
  }
  private async runSweep(): Promise<void> {
    if (this.sweeping || this.closing) return; this.sweeping = true;
    try {
      await this.options.dueWork?.();
      for (const action of this.store.actions()) {
        if (!["unknown", "accepted"].includes(action.status) || !this.options.reconcile || this.active.has(action.runId)) continue;
        let outcome: Awaited<ReturnType<NonNullable<BusinessCoordinatorOptions["reconcile"]>>>;
        try { outcome = await this.options.reconcile(action); } catch { this.event("reconciliation.unavailable", { tool: action.tool }, action.taskId, action.id); continue; }
        if (outcome?.verified && outcome.evidenceRefs.length) this.store.transaction(() => {
          const latest = this.store.action(action.id)!;
          this.store.updateAction({ ...latest, status: "verified", receipt: outcome.receipt, evidenceRefs: outcome.evidenceRefs, error: null, updatedAt: this.store.now(), version: latest.version + 1 }, latest.version);
          this.store.settleReservation(action.id, true); this.event("action.reconciled", { evidenceRefs: outcome.evidenceRefs }, action.taskId, action.id);
          const task = this.requireTask(action.taskId);
          if (task.status === "blocked" && ["Reconciliation required", "Reconcile prior effects before dispatch", "Reconcile prior effects before continuing"].includes(task.blocker ?? "") && !this.store.actions(task.id).some(item => ["unknown", "accepted", "dispatching"].includes(item.status)) && this.store.get<BusinessAuthority>("authority", task.authorityRef)?.value.enabled) this.mutate(task, { status: "queued", blocker: null, nextWake: null });
        });
      }
      this.store.transaction(() => {
        for (const wait of this.store.waits()) {
          if (wait.status !== "waiting" || wait.deadline === null || wait.deadline > this.store.now()) continue;
          const task = this.requireTask(wait.taskId); if (TERMINAL_TASKS[task.status]) continue;
          this.store.putWait({ ...wait, status: wait.kind === "timer" ? "satisfied" : "expired" }, "waiting");
          if (task.status === "waiting") this.mutate(task, { status: wait.kind === "timer" ? "queued" : "blocked", blocker: wait.kind === "timer" ? null : "Wait expired; current premise needs verification", nextWake: null });
        }
      });
      if (this.options.worker && !this.store.settings().value.stopped) for (const task of this.store.tasks().reverse()) {
        if (this.workers.size >= 2) break;
        const binding = this.claimRun(task.id); if (!binding) continue;
        const work = this.runWorker(binding); this.workers.add(work); void work.finally(() => this.workers.delete(work));
      }
    } catch (error) { this.event("sweep.failed", { message: error instanceof Error ? error.message : "Unknown sweep error" }); }
    finally { this.sweeping = false; }
  }
  private async runWorker(binding: TaskRunBinding): Promise<void> {
    const controller = new AbortController(); this.active.set(binding.runId, controller);
    this.sliceDeadlines.set(binding.runId, Date.now() + 60_000);
    const timeout = setTimeout(() => { if (!this.externalOperations.has(binding.taskId)) controller.abort(); }, 60_000);
    try {
      const result = await this.options.worker!(binding, this.requireTask(binding.taskId), controller.signal);
      const task = this.store.task(binding.taskId)!;
      if (task.status !== "running" || task.runId !== binding.runId) return;
      const attempts = result.progress ? 0 : task.noProgress + 1;
      this.mutate(task, { status: attempts >= 3 ? "blocked" : "queued", checkpoint: result.checkpoint, noProgress: attempts, blocker: attempts >= 3 ? "Three turns without progress" : null, runId: null, dispatches: this.store.actions(task.id).length });
    } catch {
      const task = this.store.task(binding.taskId);
      if (task?.status === "running" && task.runId === binding.runId) {
        const uncertain = this.store.actions(task.id).some(a => a.status === "unknown");
        const attempts = task.noProgress + 1;
        this.mutate(task, { status: uncertain || attempts >= 3 ? "blocked" : "queued", blocker: uncertain ? "Reconciliation required" : attempts >= 3 ? "Three unsuccessful turns" : null, noProgress: attempts, runId: null, nextWake: this.store.now() + Math.min(30_000 * 2 ** attempts, 300_000) });
      }
    } finally {
      clearTimeout(timeout); this.sliceDeadlines.delete(binding.runId); this.active.delete(binding.runId); this.releaseComputer(binding.taskId);
      const task = this.store.task(binding.taskId); if (task?.status === "blocked") this.notifyTask(task, "blocked");
    }
  }
  beginClose(): void {
    this.closing = true; clearInterval(this.timer);
    for (const controller of this.active.values()) controller.abort();
  }
  async close(): Promise<void> {
    this.beginClose();
    await this.sweepPromise;
    await Promise.allSettled(this.workers);
    await Promise.allSettled(this.notices);
  }
  private notifyTask(task: BusinessTask, kind: "completed" | "blocked" | "waiting"): void {
    if (!this.options.onTaskEvent) return;
    const work = Promise.resolve().then(() => this.options.onTaskEvent!(task, kind)).catch(() => this.event("notification.failed", { reason: "Task notice could not be accounted" }, task.id));
    this.notices.add(work); void work.finally(() => this.notices.delete(work)).catch(() => {});
  }
  private releaseComputer(taskId: string): void { if (this.computerLease === taskId && !this.effects.has(taskId)) this.computerLease = undefined; }
  private requireTask(id: string): BusinessTask { const task = this.store.task(id); if (!task) throw new Error("Business task not found"); return task; }
  private mutate(task: BusinessTask, patch: Partial<BusinessTask>): BusinessTask { return this.store.updateTask({ ...task, ...patch, version: task.version + 1, updatedAt: this.store.now() }, task.version); }
  private event(kind: string, detail: Json, taskId: string | null = null, actionId: string | null = null): void {
    this.store.recordActivity(kind, detail, taskId, actionId); this.options.audit?.(kind, { taskId, actionId, detail });
  }
}
