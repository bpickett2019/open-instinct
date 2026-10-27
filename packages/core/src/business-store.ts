import { DatabaseSync } from "node:sqlite";
import { randomUUID, createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import type { BusinessAction, BusinessEvent, BusinessRecordKind, BusinessSettings, BusinessTask, BusinessWait, Json, OwnerMessage, Versioned } from "./business-types.js";
import { acquireBusinessLock } from "./business-lock.js";

export const BUSINESS_SCHEMA_VERSION = 3;
const TASK_STATUSES = ["queued", "running", "waiting", "blocked", "completed", "cancelled", "failed"];
const ACTION_STATUSES = ["prepared", "dispatching", "accepted", "verified", "unknown", "failed", "cancelled", "superseded"];

export function jsonValue(value: unknown, depth = 0): asserts value is Json {
  if (depth > 50) throw new Error("Business payload nesting limit exceeded");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) { for (const item of value) jsonValue(item, depth + 1); return; }
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [key, item] of Object.entries(value)) {
      if (["__proto__", "constructor", "prototype"].includes(key)) throw new Error("Unsafe business payload key");
      jsonValue(item, depth + 1);
    }
    return;
  }
  throw new Error("Invalid business JSON payload");
}
export function canonicalJson(value: unknown): string {
  jsonValue(value);
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}
export function businessHash(value: unknown): string { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }
function object(value: unknown): asserts value is Record<string, unknown> {
  jsonValue(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected business record");
}
function text(value: unknown): asserts value is string { if (typeof value !== "string" || !value.trim()) throw new Error("Expected nonempty business string"); }
function integer(value: unknown): asserts value is number { if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error("Invalid business integer"); }
function strings(value: unknown): asserts value is string[] { if (!Array.isArray(value) || value.some(v => typeof v !== "string")) throw new Error("Invalid business string list"); }
function nullableText(value: unknown): void { if (value !== null && typeof value !== "string") throw new Error("Invalid nullable business string"); }
function nullableInteger(value: unknown): void { if (value !== null) integer(value); }
function revisions(value: unknown): void { object(value); for (const [key, revision] of Object.entries(value)) { text(key); integer(revision); if (revision === 0) throw new Error("Invalid source revision"); } }
function validateAllowance(value: unknown): void {
  object(value); integer(value.amountMinor);
  if (!["purchase", "model"].includes(String(value.category)) || typeof value.currency !== "string" || !/^[A-Z]{3}$/.test(value.currency)) throw new Error("Invalid allowance");
}
function validateRecord(kind: BusinessRecordKind, value: unknown): void {
  object(value);
  if (kind === "authority") {
    text(value.id); text(value.sourceId); text(value.scope); integer(value.version);
    if (!["owner", "routine"].includes(String(value.kind)) || typeof value.enabled !== "boolean" || value.version === 0) throw new Error("Invalid execution authority");
  } else if (kind === "connection") {
    text(value.id); text(value.toolkit); text(value.accountId); text(value.connectedBy); strings(value.scopes); integer(value.epoch); nullableInteger(value.verifiedAt); nullableText(value.revokeJobId);
    if (!["connected", "disabled", "challenge"].includes(String(value.status)) || !["none", "requested", "failed"].includes(String(value.revocation)) || typeof value.identity !== "string" || value.status === "connected" && (!value.identity || value.verifiedAt === null)) throw new Error("Invalid connection binding");
  }
}
function validateWait(value: unknown): void {
  object(value); text(value.id); text(value.taskId); text(value.correlationKey); integer(value.eventCursor); nullableInteger(value.deadline); nullableText(value.satisfiedBy);
  if (!["timer", "external_event", "missing_information", "provider_challenge", "connection", "constraint", "reconciliation"].includes(String(value.kind)) || !["waiting", "satisfied", "expired", "cancelled"].includes(String(value.status)) || typeof value.requiresVerification !== "boolean") throw new Error("Invalid durable wait");
}
function validateEvent(value: unknown): void {
  object(value); text(value.id); text(value.channel); text(value.correlationKey); text(value.kind); integer(value.at); jsonValue(value.content);
  if (typeof value.verified !== "boolean") throw new Error("Invalid provider event verification");
}
function validateMessage(value: unknown): void {
  object(value); text(value.id); text(value.channel); text(value.thread); nullableText(value.taskId); strings(value.artifactIds); integer(value.at);
  if (typeof value.text !== "string" || !["owner", "assistant", "notice"].includes(String(value.role))) throw new Error("Invalid owner message");
}
function decode<T>(payload: unknown, validate: (v: unknown) => void): T {
  if (typeof payload !== "string") throw new Error("Corrupt business record");
  const value: unknown = JSON.parse(payload); validate(value); return value as T;
}
function validateTask(value: unknown): void {
  object(value); text(value.id); text(value.workspaceId); text(value.objective); text(value.authorityRef);
  integer(value.version); integer(value.executionEpoch); integer(value.createdAt); integer(value.updatedAt);
  integer(value.dispatches); integer(value.noProgress); strings(value.doneCriteria); strings(value.sourceRefs); strings(value.evidenceRefs);
  if (!value.doneCriteria.length || value.doneCriteria.some(item => !item.trim()) || !TASK_STATUSES.includes(String(value.status)) || value.version === 0) throw new Error("Invalid task state");
  nullableText(value.runId); nullableText(value.result); nullableText(value.blocker); nullableInteger(value.nextWake); jsonValue(value.checkpoint);
  if (value.status === "running" && !value.runId || value.status !== "running" && value.runId !== null) throw new Error("Invalid task run binding");
  object(value.origin); text(value.origin.conversationKey); object(value.origin.replyRef);
  if (value.origin.audience !== "owner" || value.origin.requester !== "owner" || !["chat", "sms", "imessage", "email", "a2a", "scheduled"].includes(String(value.origin.channel)) || Object.values(value.origin.replyRef).some(item => typeof item !== "string")) throw new Error("Invalid task origin");
}
function validateAction(value: unknown): void {
  object(value); text(value.id); text(value.taskId); text(value.stepId); text(value.tool); text(value.argsHash); text(value.runId);
  integer(value.version); integer(value.taskRevision); strings(value.evidenceRefs);
  integer(value.createdAt); integer(value.updatedAt); revisions(value.sourceRevisions); nullableText(value.error); jsonValue(value.receipt);
  if (value.version === 0 || value.taskRevision === 0 || value.spendCapable !== undefined && typeof value.spendCapable !== "boolean") throw new Error("Invalid action revision or spend classification");
  if (value.unpricedModel !== undefined && typeof value.unpricedModel !== "boolean") throw new Error("Invalid model pricing classification");
  if (value.connection !== undefined) { object(value.connection); text(value.connection.id); text(value.connection.accountId); integer(value.connection.version); integer(value.connection.epoch); if (value.connection.version === 0) throw new Error("Invalid account revision"); }
  if (value.allowance !== undefined) validateAllowance(value.allowance);
  if (!ACTION_STATUSES.includes(String(value.status)) || typeof value.effectful !== "boolean") throw new Error("Invalid action state");
  if (businessHash(value.arguments) !== value.argsHash) throw new Error("Action arguments integrity failure");
}
function validateSettings(value: unknown): void {
  object(value); text(value.workspaceId); integer(value.globalControlEpoch); text(value.timezone); text(value.currency);
  if (value.autonomy !== "full" || typeof value.stopped !== "boolean") throw new Error("Invalid business settings");
  new Intl.DateTimeFormat("en", { timeZone: value.timezone });
  if (!/^[A-Z]{3}$/.test(value.currency)) throw new Error("Invalid business currency");
  object(value.limits); object(value.usage); strings(value.constraints);
  for (const key of ["purchaseMinor", "modelMinor"]) {
    if (value.limits[key] !== null) integer(value.limits[key]);
    integer(value.usage[key]);
  }
  integer(value.profileVersion); integer(value.backupRetention); integer(value.usage.inputTokens); integer(value.usage.outputTokens);
  const preferences = value.notificationPreferences; object(preferences);
  if (value.backupRetention < 1 || value.backupRetention > 365 || value.limits.currency !== value.currency || typeof value.usage.modelPriceUnknown !== "boolean" || ["progress", "blockers", "completion"].some(key => typeof preferences[key] !== "boolean")) throw new Error("Invalid business control settings");
}

/** A synchronous transaction is the unit of accounting; callbacks must never await. */
export class BusinessStore {
  readonly root: string;
  readonly dbPath: string;
  private readonly db: DatabaseSync;
  private inTransaction = false;
  private closed = false;
  private readonly releaseLock: () => void;
  constructor(directory: string, readonly now: () => number = Date.now) {
    this.root = resolve(directory);
    if (existsSync(this.root) && lstatSync(this.root).isSymbolicLink()) throw new Error("Business state cannot be a symlink");
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    chmodSync(this.root, 0o700);
    this.root = realpathSync(this.root);
    this.dbPath = join(this.root, "business.sqlite");
    if (existsSync(this.dbPath) && lstatSync(this.dbPath).isSymbolicLink()) throw new Error("Business database cannot be a symlink");
    this.releaseLock = acquireBusinessLock(this.root);
    try { this.db = new DatabaseSync(this.dbPath); }
    catch (error) { this.releaseLock(); throw error; }
    try {
      chmodSync(this.dbPath, 0o600);
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
      const version = Number(this.db.prepare("PRAGMA user_version").get()?.user_version);
      if (![0, 1, 2, BUSINESS_SCHEMA_VERSION].includes(version)) throw new Error(`Unsupported business schema ${version}`);
      if (version === 0) this.migrate();
      if (version < 2) this.transaction(() => {
        this.db.exec("CREATE VIRTUAL TABLE knowledge_chunks USING fts5(source_id UNINDEXED, source_version UNINDEXED, locator UNINDEXED, text); PRAGMA user_version=2;");
      });
      if (version < 3) this.transaction(() => {
        this.db.exec("ALTER TABLE reservations RENAME TO reservations_v2; CREATE TABLE reservations (action_id TEXT PRIMARY KEY,category TEXT NOT NULL,amount INTEGER NOT NULL CHECK(amount>=0),currency TEXT NOT NULL,status TEXT NOT NULL); INSERT INTO reservations SELECT * FROM reservations_v2; DROP TABLE reservations_v2; PRAGMA user_version=3;");
      });
      const integrity = this.db.prepare("PRAGMA quick_check").get();
      if (integrity?.quick_check !== "ok") throw new Error("Business database integrity check failed");
      for (const suffix of ["-wal", "-shm"]) if (existsSync(this.dbPath + suffix)) chmodSync(this.dbPath + suffix, 0o600);
      this.settings();
    } catch (error) { this.db.close(); this.releaseLock(); throw error; }
  }
  private migrate(): void {
    this.transaction(() => {
      this.db.exec(`
        CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, payload TEXT NOT NULL);
        CREATE TABLE records (kind TEXT NOT NULL,id TEXT NOT NULL,version INTEGER NOT NULL,payload TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(kind,id));
        CREATE TABLE tasks (id TEXT PRIMARY KEY,dedupe_key TEXT NOT NULL UNIQUE,status TEXT NOT NULL,version INTEGER NOT NULL,next_wake INTEGER,payload TEXT NOT NULL);
        CREATE INDEX tasks_due ON tasks(status,next_wake);
        CREATE TABLE actions (id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),step_id TEXT NOT NULL,status TEXT NOT NULL,version INTEGER NOT NULL,payload TEXT NOT NULL,UNIQUE(task_id,step_id));
        CREATE INDEX actions_status ON actions(status,task_id);
        CREATE TABLE events (cursor INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,correlation_key TEXT NOT NULL,payload TEXT NOT NULL);
        CREATE INDEX events_correlation ON events(correlation_key,cursor);
        CREATE TABLE waits (id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),correlation_key TEXT NOT NULL,status TEXT NOT NULL,deadline INTEGER,payload TEXT NOT NULL);
        CREATE INDEX waits_due ON waits(status,deadline);
        CREATE TABLE messages (cursor INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,payload TEXT NOT NULL);
        CREATE TABLE activity (cursor INTEGER PRIMARY KEY AUTOINCREMENT,at INTEGER NOT NULL,task_id TEXT,action_id TEXT,kind TEXT NOT NULL,payload TEXT NOT NULL);
        CREATE TABLE reservations (action_id TEXT PRIMARY KEY REFERENCES actions(id),category TEXT NOT NULL,amount INTEGER NOT NULL CHECK(amount>=0),currency TEXT NOT NULL,status TEXT NOT NULL);
        PRAGMA user_version=1;
      `);
      const initial: BusinessSettings = {
        workspaceId: randomUUID(), autonomy: "full", stopped: false, globalControlEpoch: 0, timezone: "UTC", currency: "USD", constraints: [], profileVersion: 0,
        notificationPreferences: { progress: true, blockers: true, completion: true },
        limits: { purchaseMinor: null, modelMinor: null, currency: "USD" },
        usage: { purchaseMinor: 0, modelMinor: 0, modelPriceUnknown: false, inputTokens: 0, outputTokens: 0 }, backupRetention: 7,
      };
      this.db.prepare("INSERT INTO settings VALUES(1,1,?)").run(canonicalJson(initial));
    });
  }
  replaceKnowledgeChunks(sourceId: string, sourceVersion: number, chunks: Array<{ locator: string; text: string }>): void {
    text(sourceId); integer(sourceVersion);
    this.transaction(() => {
      this.removeKnowledgeChunks(sourceId);
      const insert = this.db.prepare("INSERT INTO knowledge_chunks(source_id,source_version,locator,text) VALUES(?,?,?,?)");
      for (const chunk of chunks) { text(chunk.locator); text(chunk.text); insert.run(sourceId, sourceVersion, chunk.locator, chunk.text); }
    });
  }
  removeKnowledgeChunks(sourceId: string): void { this.db.prepare("DELETE FROM knowledge_chunks WHERE source_id=?").run(sourceId); }
  searchKnowledge(query: string, limit = 20): Array<{ sourceId: string; sourceVersion: number; locator: string; text: string }> {
    integer(limit);
    const terms = query.match(/[\p{L}\p{N}_]+/gu)?.slice(0, 32) ?? [];
    if (!terms.length) return [];
    const escaped = terms.map(term => `"${term.replaceAll('"', '""')}"`).join(" AND ");
    return this.db.prepare("SELECT source_id,source_version,locator,text FROM knowledge_chunks WHERE knowledge_chunks MATCH ? ORDER BY rank LIMIT ?")
      .all(escaped, Math.min(limit, 100)).map(row => ({ sourceId: String(row.source_id), sourceVersion: Number(row.source_version), locator: String(row.locator), text: String(row.text) }));
  }
  transaction<T>(fn: () => T): T {
    if (fn.constructor.name === "AsyncFunction") throw new Error("Async business transaction forbidden");
    if (this.inTransaction) {
      const result = fn();
      if (result && typeof result === "object" && "then" in result && typeof result.then === "function") throw new Error("Async business transaction forbidden");
      return result;
    }
    this.db.exec("BEGIN IMMEDIATE"); this.inTransaction = true;
    try {
      const result = fn();
      if (result && typeof result === "object" && "then" in result && typeof result.then === "function") throw new Error("Async business transaction forbidden");
      this.db.exec("COMMIT"); return result;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    finally { this.inTransaction = false; }
  }
  settings(): Versioned<BusinessSettings> {
    const row = this.db.prepare("SELECT * FROM settings WHERE id=1").get();
    if (!row) throw new Error("Missing business settings");
    return { id: "settings", version: Number(row.version), value: decode(row.payload, validateSettings), updatedAt: 0 };
  }
  updateSettings(expected: number, value: BusinessSettings): Versioned<BusinessSettings> {
    validateSettings(value);
    const previous = this.settings().value;
    if (value.limits.currency !== value.currency) throw new Error("Purchase limit currency must match business currency");
    if (value.currency !== previous.currency && (previous.usage.purchaseMinor > 0 || Number(this.db.prepare("SELECT count(*) AS count FROM reservations WHERE category='purchase' AND status='held'").get()?.count) > 0)) throw new Error("Cannot reinterpret purchase usage or held reservations in another currency");
    if (canonicalJson({ timezone: value.timezone, currency: value.currency, constraints: value.constraints, limits: value.limits }) !== canonicalJson({ timezone: previous.timezone, currency: previous.currency, constraints: previous.constraints, limits: previous.limits })) value = { ...value, globalControlEpoch: Math.max(value.globalControlEpoch, previous.globalControlEpoch + 1) };
    if (value.workspaceId !== this.settings().value.workspaceId) throw new Error("Workspace identity is immutable");
    this.changed(this.db.prepare("UPDATE settings SET version=version+1,payload=? WHERE id=1 AND version=?").run(canonicalJson(value), expected).changes);
    return this.settings();
  }
  get<T>(kind: BusinessRecordKind, id: string, validate: (v: unknown) => void = object): Versioned<T> | undefined {
    const row = this.db.prepare("SELECT * FROM records WHERE kind=? AND id=?").get(kind, id);
    return row ? { id, version: Number(row.version), value: decode<T>(row.payload, value => { validateRecord(kind, value); validate(value); }), updatedAt: Number(row.updated_at) } : undefined;
  }
  list<T>(kind: BusinessRecordKind, validate: (v: unknown) => void = object): Versioned<T>[] {
    return this.db.prepare("SELECT * FROM records WHERE kind=? ORDER BY updated_at,id").all(kind).map(row => ({ id: String(row.id), version: Number(row.version), value: decode<T>(row.payload, value => { validateRecord(kind, value); validate(value); }), updatedAt: Number(row.updated_at) }));
  }
  put<T>(kind: BusinessRecordKind, id: string, value: T, expected: number | null, validate: (v: unknown) => void = object): Versioned<T> {
    text(id); validateRecord(kind, value); validate(value); if (expected !== null) integer(expected);
    const payload = canonicalJson(value);
    if (expected === null) this.db.prepare("INSERT INTO records VALUES(?,?,1,?,?)").run(kind, id, payload, this.now());
    else this.changed(this.db.prepare("UPDATE records SET version=version+1,payload=?,updated_at=? WHERE kind=? AND id=? AND version=?").run(payload, this.now(), kind, id, expected).changes);
    return this.get<T>(kind, id, validate)!;
  }
  task(id: string): BusinessTask | undefined { const row = this.db.prepare("SELECT payload FROM tasks WHERE id=?").get(id); return row ? decode(row.payload, validateTask) : undefined; }
  taskByDedupe(key: string): BusinessTask | undefined { const row = this.db.prepare("SELECT payload FROM tasks WHERE dedupe_key=?").get(key); return row ? decode(row.payload, validateTask) : undefined; }
  tasks(): BusinessTask[] { return this.db.prepare("SELECT payload FROM tasks ORDER BY rowid DESC").all().map(row => decode(row.payload, validateTask)); }
  insertTask(task: BusinessTask, dedupeKey: string): void {
    validateTask(task); this.db.prepare("INSERT INTO tasks VALUES(?,?,?,?,?,?)").run(task.id, dedupeKey, task.status, task.version, task.nextWake, canonicalJson(task));
  }
  updateTask(task: BusinessTask, expected: number): BusinessTask {
    validateTask(task);
    if (task.version !== expected + 1) throw new Error("Task revision must advance once");
    this.changed(this.db.prepare("UPDATE tasks SET status=?,version=?,next_wake=?,payload=? WHERE id=? AND version=?").run(task.status, task.version, task.nextWake, canonicalJson(task), task.id, expected).changes);
    return task;
  }
  action(id: string): BusinessAction | undefined { const row = this.db.prepare("SELECT payload FROM actions WHERE id=?").get(id); return row ? decode(row.payload, validateAction) : undefined; }
  actionForStep(taskId: string, stepId: string): BusinessAction | undefined { const row = this.db.prepare("SELECT payload FROM actions WHERE task_id=? AND step_id=?").get(taskId, stepId); return row ? decode(row.payload, validateAction) : undefined; }
  actions(taskId?: string): BusinessAction[] {
    const rows = taskId ? this.db.prepare("SELECT payload FROM actions WHERE task_id=? ORDER BY rowid").all(taskId) : this.db.prepare("SELECT payload FROM actions ORDER BY rowid").all();
    return rows.map(row => decode(row.payload, validateAction));
  }
  insertAction(action: BusinessAction): void { validateAction(action); this.db.prepare("INSERT INTO actions VALUES(?,?,?,?,?,?)").run(action.id, action.taskId, action.stepId, action.status, action.version, canonicalJson(action)); }
  updateAction(action: BusinessAction, expected: number): BusinessAction {
    validateAction(action);
    const old = this.action(action.id);
    if (!old || action.version !== expected + 1) throw new Error("Invalid action revision");
    const immutable = (a: BusinessAction) => ({ taskId: a.taskId, stepId: a.stepId, tool: a.tool, arguments: a.arguments, argsHash: a.argsHash, sourceRevisions: a.sourceRevisions, connection: a.connection ?? null, effectful: a.effectful, spendCapable: a.spendCapable ?? false, unpricedModel: a.unpricedModel ?? false, allowance: a.allowance ?? null });
    if (canonicalJson(immutable(old)) !== canonicalJson(immutable(action))) throw new Error("Action payload is immutable");
    const neverAttempted = old.status === "prepared" && action.status === "prepared" && old.receipt === null && old.evidenceRefs.length === 0;
    if (!neverAttempted && (old.runId !== action.runId || old.taskRevision !== action.taskRevision)) throw new Error("Attempted action binding is immutable");
    this.changed(this.db.prepare("UPDATE actions SET status=?,version=?,payload=? WHERE id=? AND version=?").run(action.status, action.version, canonicalJson(action), action.id, expected).changes);
    return action;
  }
  appendEvent(event: BusinessEvent): { cursor: number; inserted: boolean } {
    validateEvent(event);
    const result = this.db.prepare("INSERT OR IGNORE INTO events(id,correlation_key,payload) VALUES(?,?,?)").run(event.id, event.correlationKey, canonicalJson(event));
    const row = this.db.prepare("SELECT cursor,payload FROM events WHERE id=?").get(event.id)!;
    if (row.payload !== canonicalJson(event)) throw new Error("Event identity reused with different content");
    return { cursor: Number(row.cursor), inserted: Number(result.changes) === 1 };
  }
  events(key: string, after = 0): Array<{ cursor: number; value: BusinessEvent }> {
    integer(after); return this.db.prepare("SELECT cursor,payload FROM events WHERE correlation_key=? AND cursor>? ORDER BY cursor").all(key, after).map(row => ({ cursor: Number(row.cursor), value: decode(row.payload, validateEvent) }));
  }
  eventCursor(id: string): number | undefined {
    const row = this.db.prepare("SELECT cursor FROM events WHERE id=?").get(id);
    return row ? Number(row.cursor) : undefined;
  }
  waits(taskId?: string): BusinessWait[] {
    const rows = taskId ? this.db.prepare("SELECT payload FROM waits WHERE task_id=?").all(taskId) : this.db.prepare("SELECT payload FROM waits").all();
    return rows.map(row => decode(row.payload, validateWait));
  }
  putWait(wait: BusinessWait, expectedStatus: BusinessWait["status"] | null): void {
    validateWait(wait);
    if (expectedStatus === null) this.db.prepare("INSERT INTO waits VALUES(?,?,?,?,?,?)").run(wait.id, wait.taskId, wait.correlationKey, wait.status, wait.deadline, canonicalJson(wait));
    else this.changed(this.db.prepare("UPDATE waits SET status=?,deadline=?,payload=? WHERE id=? AND status=?").run(wait.status, wait.deadline, canonicalJson(wait), wait.id, expectedStatus).changes);
  }
  message(id: string): OwnerMessage | undefined {
    const row = this.db.prepare("SELECT cursor,payload FROM messages WHERE id=?").get(id);
    return row ? { ...decode<Omit<OwnerMessage, "cursor">>(row.payload, validateMessage), cursor: Number(row.cursor) } : undefined;
  }
  appendMessage(message: Omit<OwnerMessage, "cursor">): OwnerMessage {
    validateMessage(message);
    this.db.prepare("INSERT OR IGNORE INTO messages(id,payload) VALUES(?,?)").run(message.id, canonicalJson(message));
    const row = this.db.prepare("SELECT cursor,payload FROM messages WHERE id=?").get(message.id)!;
    if (row.payload !== canonicalJson(message)) throw new Error("Message id reused with different content");
    return { ...message, cursor: Number(row.cursor) };
  }
  messages(after = 0, limit = 100): OwnerMessage[] {
    integer(after); integer(limit);
    return this.db.prepare("SELECT cursor,payload FROM messages WHERE cursor>? ORDER BY cursor LIMIT ?").all(after, Math.min(limit, 200)).map(row => ({ ...decode<Omit<OwnerMessage, "cursor">>(row.payload, validateMessage), cursor: Number(row.cursor) }));
  }
  recordActivity(kind: string, payload: Json, taskId: string | null = null, actionId: string | null = null): void {
    this.db.prepare("INSERT INTO activity(at,task_id,action_id,kind,payload) VALUES(?,?,?,?,?)").run(this.now(), taskId, actionId, kind, canonicalJson(payload));
  }
  activity(after = 0, limit = 100): Array<{ cursor: number; at: number; taskId: string | null; actionId: string | null; kind: string; detail: Json }> {
    integer(after); integer(limit);
    return this.db.prepare("SELECT * FROM activity WHERE cursor>? ORDER BY cursor LIMIT ?").all(after, Math.min(limit, 200)).map(row => ({ cursor: Number(row.cursor), at: Number(row.at), taskId: row.task_id as string | null, actionId: row.action_id as string | null, kind: String(row.kind), detail: decode(row.payload, jsonValue) }));
  }
  configureSavedPurchaseRules(rules: { perActionMinor: number | null; perDayMinor: number | null; timezone: string }): void {
    for (const amount of [rules.perActionMinor, rules.perDayMinor]) if (amount !== null) integer(amount);
    new Intl.DateTimeFormat("en-CA", { timeZone: rules.timezone });
    const previous = this.get<typeof rules>("cursor", "saved-owner-purchase-rules");
    if (previous && canonicalJson(previous.value) === canonicalJson(rules)) return;
    this.transaction(() => {
      this.put("cursor", "saved-owner-purchase-rules", rules, previous?.version ?? null);
      if (previous) { const settings = this.settings(); this.updateSettings(settings.version, { ...settings.value, globalControlEpoch: settings.value.globalControlEpoch + 1 }); }
    });
  }
  savedPurchaseBalance() {
    const rules = this.get<{ perActionMinor: number | null; perDayMinor: number | null; timezone: string }>("cursor", "saved-owner-purchase-rules")?.value;
    if (!rules || (rules.perActionMinor === null && rules.perDayMinor === null)) return null;
    for (const amount of [rules.perActionMinor, rules.perDayMinor]) if (amount !== null) integer(amount);
    const date = new Intl.DateTimeFormat("en-CA", { timeZone: rules.timezone, year: "numeric", month: "2-digit", day: "2-digit" });
    const today = date.format(this.now());
    let usedMinor = 0, heldMinor = 0, unknown = false;
    const reserved = new Set(this.db.prepare("SELECT action_id FROM reservations WHERE status='held'").all().map(row => String(row.action_id)));
    for (const prior of this.actions()) {
      if (!prior.spendCapable && prior.allowance?.category !== "purchase") continue;
      const unresolved = ["dispatching", "accepted", "unknown"].includes(prior.status) || prior.status === "prepared" && (!prior.allowance || reserved.has(prior.id));
      if (!unresolved && (prior.status !== "verified" || date.format(prior.updatedAt) !== today)) continue;
      if (!prior.allowance || prior.allowance.currency !== "USD") { unknown = true; continue; }
      if (unresolved) heldMinor += prior.allowance.amountMinor; else usedMinor += prior.allowance.amountMinor;
      integer(heldMinor + usedMinor);
    }
    return { ...rules, currency: "USD", date: today, usedMinor, heldMinor, unknown, remainingMinor: rules.perDayMinor === null || unknown ? null : Math.max(0, rules.perDayMinor - usedMinor - heldMinor) };
  }
  private checkSavedPurchaseRules(action: BusinessAction, additional = true): void {
    if (!action.spendCapable && action.allowance?.category !== "purchase") return;
    const balance = this.savedPurchaseBalance(); if (!balance) return;
    if (!action.allowance || action.allowance.currency !== "USD") throw new Error("Saved USD purchase restrictions require a trusted USD amount");
    if (balance.perActionMinor !== null && action.allowance.amountMinor > balance.perActionMinor) throw new Error("Saved owner per-action restriction exceeded");
    if (balance.perDayMinor !== null && (balance.unknown || balance.usedMinor + balance.heldMinor + (additional ? action.allowance.amountMinor : 0) > balance.perDayMinor)) throw new Error("Saved owner daily purchase restriction exceeded or usage unknown");
  }
  reserve(action: BusinessAction): void {
    this.checkSavedPurchaseRules(action);
    if (action.unpricedModel) {
      const settings = this.settings();
      if (settings.value.limits.modelMinor !== null) throw new Error("Model price unavailable; cannot enforce the configured model allowance");
      if (!settings.value.usage.modelPriceUnknown) this.updateSettings(settings.version, { ...settings.value, usage: { ...settings.value.usage, modelPriceUnknown: true } });
    }
    if (action.spendCapable && !action.allowance && this.settings().value.limits.purchaseMinor !== null) throw new Error("Configured purchase allowance requires a trusted amount and currency before dispatch");
    if (action.allowance) this.reserveAmount(action.id, action.allowance);
  }
  assertReservation(action: BusinessAction): void {
    this.checkSavedPurchaseRules(action, false);
    const settings = this.settings().value;
    if (action.unpricedModel && settings.limits.modelMinor !== null) throw new Error("Model price unavailable; cannot enforce the configured model allowance");
    if (action.spendCapable && !action.allowance && settings.limits.purchaseMinor !== null) throw new Error("Configured purchase allowance requires a trusted amount and currency before dispatch");
    if (action.allowance) {
      const reservation = this.db.prepare("SELECT * FROM reservations WHERE action_id=? AND status='held'").get(action.id);
      if (!reservation || reservation.category !== action.allowance.category || reservation.currency !== action.allowance.currency || Number(reservation.amount) !== action.allowance.amountMinor) throw new Error("Prepared action reservation is missing or changed");
      this.checkAllowanceBudget(action.allowance, 0);
    }
  }
  reserveAmount(id: string, allowance: NonNullable<BusinessAction["allowance"]>): void {
    text(id); validateAllowance(allowance);
    this.checkAllowanceBudget(allowance, allowance.amountMinor);
    this.db.prepare("INSERT INTO reservations VALUES(?,?,?,?, 'held')").run(id, allowance.category, allowance.amountMinor, allowance.currency);
  }
  private checkAllowanceBudget(allowance: NonNullable<BusinessAction["allowance"]>, additional: number): void {
    const settings = this.settings().value;
    if (allowance.currency !== (allowance.category === "model" ? "USD" : settings.limits.currency)) throw new Error("Allowance currency mismatch");
    const used = settings.usage[`${allowance.category}Minor`];
    const held = Number(this.db.prepare("SELECT coalesce(sum(amount),0) AS total FROM reservations WHERE category=? AND status='held'").get(allowance.category)?.total);
    const limit = settings.limits[`${allowance.category}Minor`];
    integer(used + held + additional);
    const unknown = allowance.category === "model" ? settings.usage.modelPriceUnknown : this.unmeteredPurchases();
    if (limit !== null && (unknown || used + held + additional > limit)) throw new Error("Configured allowance exhausted or usage unknown");
  }
  settleReservation(actionId: string, spent: boolean, actualAmountMinor?: number): void {
    const row = this.db.prepare("SELECT * FROM reservations WHERE action_id=? AND status='held'").get(actionId); if (!row) return;
    if (spent) {
      const settings = this.settings(); const key = `${row.category}Minor` as "modelMinor" | "purchaseMinor";
      const amount = actualAmountMinor ?? Number(row.amount); integer(amount);
      if (amount > Number(row.amount)) throw new Error("Usage exceeded its reserved allowance; accounting investigation required");
      const total = settings.value.usage[key] + amount; integer(total);
      settings.value.usage[key] = total; this.updateSettings(settings.version, settings.value);
    }
    this.db.prepare("UPDATE reservations SET status=? WHERE action_id=? AND status='held'").run(spent ? "settled" : "released", actionId);
  }
  private unmeteredPurchases(): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM actions WHERE json_extract(payload,'$.spendCapable')=1 AND json_type(payload,'$.allowance') IS NULL AND status IN ('prepared','dispatching','accepted','unknown','verified') LIMIT 1").get());
  }
  allowanceBalances() {
    const settings = this.settings().value;
    const balance = (category: "purchase" | "model") => {
      const heldMinor = Number(this.db.prepare("SELECT coalesce(sum(amount),0) AS total FROM reservations WHERE category=? AND status='held'").get(category)?.total);
      const limitMinor = settings.limits[`${category}Minor`], usedMinor = settings.usage[`${category}Minor`];
      const unknown = category === "model" ? settings.usage.modelPriceUnknown : this.unmeteredPurchases();
      return { currency: category === "model" ? "USD" : settings.currency, limitMinor, usedMinor, heldMinor, remainingMinor: limitMinor === null || unknown ? null : Math.max(0, limitMinor - usedMinor - heldMinor), unknown };
    };
    return { purchase: balance("purchase"), model: balance("model"), savedOwner: this.savedPurchaseBalance() };
  }
  private changed(changes: number | bigint): void { if (Number(changes) !== 1) throw new Error("Business revision conflict"); }
  close(): void { if (!this.closed) { try { this.db.close(); } finally { this.releaseLock(); this.closed = true; } } }
}
