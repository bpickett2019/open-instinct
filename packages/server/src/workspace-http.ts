import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { BusinessConnection, Principal } from "@open-instinct/core";
import type { BusinessService } from "./business-service.js";
import type { BusinessKnowledge } from "./business-knowledge.js";
import type { BusinessCommitments, RoutineInput } from "./business-commitments.js";
import { WorkspaceHttpError, WorkspaceSessions, type WorkspaceSessionOptions } from "./workspace-session.js";
import { workspacePage } from "./workspace-page.js";

export interface OwnerConnections {
  list(): Promise<Array<BusinessConnection & { version: number }>>;
  connect(toolkit: string): Promise<{ url: string | null }>;
  disconnect(id: string, expectedVersion: number): Promise<BusinessConnection>;
}
export interface OwnerComputer {
  status(): Promise<{ status: string; description: string; takeoverUrl?: string | null; taskId?: string | null }>;
  check(): Promise<{ status: string; description: string; takeoverUrl?: string | null; taskId?: string | null }>;
  clearPrivacy?(): Promise<{ status: string; description: string; takeoverUrl?: string | null; taskId?: string | null }>;
}
export interface OwnerOperations {
  backup(): Promise<{ id: string; createdAt: number; retention: number }>;
  export(): Promise<{ bytes: Uint8Array; filename: string; mimeType: string }>;
}
export interface WorkspaceOptions extends WorkspaceSessionOptions {
  business: BusinessService;
  artifacts?: Pick<BusinessKnowledge, "profile" | "saveProfile" | "list" | "detail" | "search" | "upload" | "retry" | "delete" | "download" | "source" | "deleteSource">;
  connections?: OwnerConnections;
  computer?: OwnerComputer;
  commitments?: Pick<BusinessCommitments, "saveRoutine" | "cancel">;
  operations?: OwnerOperations;
}
const OWNER: Principal = { id: "owner", kind: "owner", tier: "owner", displayName: "Owner" };
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WorkspaceHttpError(400, "Expected JSON object");
  return value as Record<string, unknown>;
}
function text(value: unknown, name: string, max = 20000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new WorkspaceHttpError(400, `Invalid ${name}`);
  return value;
}
function integer(value: unknown, name = "expectedVersion"): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new WorkspaceHttpError(400, `Invalid ${name}`);
  return Number(value);
}
function fields(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new WorkspaceHttpError(400, "Unsupported request field");
}
function json(res: ServerResponse, value: unknown, status = 200): void { res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(value)); }
async function body(req: IncomingMessage, max: number): Promise<Record<string, unknown>> {
  if (req.headers["content-type"]?.split(";")[0]?.trim() !== "application/json") throw new WorkspaceHttpError(415, "JSON requests required");
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { size += Buffer.byteLength(chunk); if (size > max) throw new WorkspaceHttpError(413, "Request too large"); chunks.push(Buffer.from(chunk)); }
  try { return object(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch (error) { if (error instanceof WorkspaceHttpError) throw error; throw new WorkspaceHttpError(400, "Invalid JSON"); }
}
const SAFE_DOWNLOAD_TYPES: Readonly<Record<string, true>> = {
  "text/plain": true, "text/markdown": true, "text/csv": true, "application/json": true, "application/pdf": true,
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": true,
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": true,
  "image/png": true, "image/jpeg": true, "image/webp": true,
};
function download(res: ServerResponse, file: { bytes: Uint8Array; filename: string; mimeType: string }): void {
  const filename = file.filename.replace(/[\x00-\x1f\x7f"\\/]/g, "_").slice(0, 180) || "download";
  res.writeHead(200, { "Content-Type": Object.hasOwn(SAFE_DOWNLOAD_TYPES, file.mimeType) ? file.mimeType : "application/octet-stream", "Content-Disposition": `attachment; filename="${filename.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(filename).replace(/'/g, "%27")}`, "Content-Length": file.bytes.byteLength, "Content-Security-Policy": "default-src 'none'; sandbox" });
  res.end(file.bytes);
}
function required<T>(service: T | undefined, name: string): T { if (!service) throw new WorkspaceHttpError(503, `${name} is not configured`); return service; }

/** Mounted only on the controller listener, never the webhook-only tunnel. */
export function createWorkspaceHandler(options: WorkspaceOptions): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const sessions = new WorkspaceSessions(options);
  const store = options.business.coordinator.store;
  const assets: Record<string, { url: URL; type: string }> = {
    "/workspace/assets/workspace.js": { url: new URL("./web/workspace.js", import.meta.url), type: "text/javascript; charset=utf-8" },
    "/workspace/assets/workspace.css": { url: new URL("./web/workspace.css", import.meta.url), type: "text/css; charset=utf-8" },
  };
  return async (req, res) => {
    const rawPath = (req.url ?? "").split("?")[0]!;
    if (rawPath !== "/workspace" && !rawPath.startsWith("/workspace/") && rawPath !== "/api/owner" && !rawPath.startsWith("/api/owner/")) return false;
    sessions.headers(res);
    try {
      sessions.validateRequest(req);
      const url = new URL(req.url!, options.origin); const path = url.pathname; const method = req.method ?? "GET";
      if (method === "GET" && (path === "/workspace" || path === "/workspace/")) { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(workspacePage()); return true; }
      if (method === "GET" && Object.hasOwn(assets, path)) { const asset = assets[path]!; const bytes = await readFile(asset.url); res.writeHead(200, { "Content-Type": asset.type }); res.end(bytes); return true; }
      if (path === "/api/owner/session" && method === "POST") {
        const input = await body(req, 8192); fields(input, ["token"]); const session = sessions.login(req, res, input.token);
        json(res, { csrf: session.csrf, ...sessions.summary() }); return true;
      }
      const mutation = method !== "GET" && method !== "HEAD";
      const session = sessions.authenticate(req, mutation);
      if (path === "/api/owner/session" && method === "GET") { json(res, { csrf: session.csrf, ...sessions.summary() }); return true; }
      const input = mutation ? await body(req, path === "/api/owner/knowledge" ? 28 * 1024 * 1024 : 64 * 1024) : {};
      if (path === "/api/owner/session" && method === "DELETE") { fields(input, ["all"]); sessions.logout(req, res, input.all === true); json(res, { signedOut: true }); return true; }
      const cursor = (): number => integer(Number(url.searchParams.get("after") ?? 0), "cursor");
      if (path === "/api/owner/overview" && method === "GET") {
        const tasks = store.tasks(); json(res, { settings: store.settings(), allowances: store.allowanceBalances(), active: tasks.filter(t => ["queued", "running"].includes(t.status)), waiting: tasks.filter(t => t.status === "waiting"), blockers: tasks.filter(t => t.status === "blocked" || t.status === "failed"), recent: tasks.filter(t => t.status === "completed").slice(0, 10), unknown: store.actions().filter(a => a.status === "unknown"), operationalBounds: { workers: 2, computerWorkers: 1, sliceSeconds: 60, dispatchesPerSlice: 12, noProgressAttempts: 3 } }); return true;
      }
      if (path === "/api/owner/tasks" && method === "GET") { json(res, { tasks: store.tasks() }); return true; }
      const taskMatch = /^\/api\/owner\/tasks\/([a-zA-Z0-9-]+)$/.exec(path);
      if (taskMatch) {
        const id = taskMatch[1]!; const task = store.task(id); if (!task) throw new WorkspaceHttpError(404, "Task not found");
        if (method === "GET") { json(res, { task, actions: store.actions(id), waits: store.waits(id) }); return true; }
        if (method === "PATCH") { fields(input, ["expectedVersion", "objective", "doneCriteria"]); const expected = integer(input.expectedVersion); const objective = text(input.objective, "objective"); if (!Array.isArray(input.doneCriteria) || !input.doneCriteria.length || input.doneCriteria.length > 30) throw new WorkspaceHttpError(400, "Done criteria required"); const doneCriteria = input.doneCriteria.map(v => text(v, "done criterion", 2000)); json(res, options.business.coordinator.editTask(OWNER, id, expected, { objective, doneCriteria })); return true; }
      }
      if (path === "/api/owner/messages" && method === "GET") { const messages = store.messages(cursor(), 100); json(res, { messages, nextCursor: messages.at(-1)?.cursor ?? cursor(), hasMore: messages.length === 100 }); return true; }
      if (path === "/api/owner/messages" && method === "POST") {
        fields(input, ["clientId", "text", "taskId"]); const clientId = text(input.clientId, "client id", 100); if (!/^[a-zA-Z0-9_-]{8,100}$/.test(clientId)) throw new WorkspaceHttpError(400, "Invalid client id");
        const message = text(input.text, "message"); const taskId = input.taskId === undefined ? undefined : text(input.taskId, "task reference", 100);
        if (taskId && !store.task(taskId)) throw new WorkspaceHttpError(404, "Task not found");
        const result = await options.business.intake({ id: `web:${clientId}`, channel: "chat", conversationKey: "chat:business-owner", from: "owner", text: message, replyRef: {}, receivedAt: new Date(store.now()).toISOString(), source: "owner-workspace", ...(taskId ? { meta: { taskId } } : {}) }, OWNER);
        json(res, { accepted: true, reply: result.reply }, 202); return true;
      }
      if (path === "/api/owner/control" && method === "POST") {
        fields(input, ["target", "operation", "expectedVersion"]); const target = text(input.target, "target", 100); const operation = input.operation;
        if (!["pause", "resume", "stop", "close"].includes(String(operation))) throw new WorkspaceHttpError(400, "Invalid control operation");
        if (target !== "workspace") { const task = store.task(target); if (!task) throw new WorkspaceHttpError(404, "Task not found"); if (task.version !== integer(input.expectedVersion)) throw new WorkspaceHttpError(409, "Task changed; refresh before applying control"); }
        if (target === "workspace" && operation === "resume" && store.settings().version !== integer(input.expectedVersion)) throw new WorkspaceHttpError(409, "Workspace changed; refresh before resuming");
        options.business.coordinator.control(OWNER, target, operation as "pause" | "resume" | "stop" | "close"); json(res, { settings: store.settings(), task: target === "workspace" ? null : store.task(target) }); return true;
      }
      if (path === "/api/owner/onboarding" && method === "GET") { json(res, await options.business.onboarding.snapshot()); return true; }
      if (path === "/api/owner/onboarding/conversation" && method === "POST") {
        fields(input, []);
        const result = await options.business.openOnboarding(OWNER);
        json(res, { accepted: true, reply: result.reply }, 202); return true;
      }
      if (path === "/api/owner/profile" && method === "GET") { json(res, required(options.artifacts, "Knowledge").profile()); return true; }
      if (path === "/api/owner/profile" && method === "PATCH") {
        fields(input, ["expectedVersion", "facts"]); if (!Array.isArray(input.facts) || input.facts.length > 50) throw new WorkspaceHttpError(400, "Invalid profile facts");
        const facts = input.facts.map(value => { const fact = object(value); fields(fact, ["key", "value", "scope"]); return { key: text(fact.key, "fact key", 100), value: text(fact.value, "fact value", 10000), scope: text(fact.scope, "fact scope", 200) }; });
        const authority = options.business.coordinator.ownerAuthority(OWNER, "chat", randomUUID(), "Save owner-entered business profile facts");
        json(res, required(options.artifacts, "Knowledge").saveProfile({ expectedVersion: integer(input.expectedVersion), facts }, authority)); return true;
      }
      if ((path === "/api/owner/knowledge" || path === "/api/owner/files") && method === "GET") { const service = required(options.artifacts, "Knowledge"); json(res, path.endsWith("knowledge") && url.searchParams.has("q") ? { results: service.search(text(url.searchParams.get("q"), "search", 500)) } : { artifacts: service.list() }); return true; }
      if (path === "/api/owner/knowledge" && method === "POST") {
        fields(input, ["filename", "mimeType", "base64", "authoritative", "scope", "supersedes", "expectedVersion"]);
        const base64 = text(input.base64, "file content", 28 * 1024 * 1024); if (base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new WorkspaceHttpError(400, "Invalid file encoding");
        const filename = text(input.filename, "filename", 180);
        if (/[\\/\x00-\x1f\x7f]/.test(filename) || filename === "." || filename === "..") throw new WorkspaceHttpError(400, "Filename must not contain paths or control characters");
        if (!/\.(txt|md|markdown|csv|pdf|docx|xlsx|png|jpe?g|webp)$/i.test(filename)) throw new WorkspaceHttpError(415, "Unsupported document format. Use text, Markdown, CSV, PDF, DOCX, XLSX or an image.");
        const bytes = Buffer.from(base64, "base64"); if (bytes.length > 20 * 1024 * 1024) throw new WorkspaceHttpError(413, "Files must be at most 20 MiB");
        if (input.authoritative !== undefined && typeof input.authoritative !== "boolean") throw new WorkspaceHttpError(400, "Invalid authority selection");
        const authority = options.business.coordinator.ownerAuthority(OWNER, "chat", randomUUID(), "Import the selected document with the explicitly selected authority and scope");
        const artifact = await required(options.artifacts, "Knowledge").upload({ filename, mimeType: text(input.mimeType, "MIME type", 120), bytes, authoritative: input.authoritative === true, ...(input.scope ? { scope: text(input.scope, "scope", 200) } : {}), ...(input.supersedes ? { supersedes: text(input.supersedes, "source id", 100), expectedVersion: integer(input.expectedVersion) } : {}) }, authority); json(res, artifact, 201); return true;
      }
      const artifactMatch = /^\/api\/owner\/(knowledge|files)\/([a-zA-Z0-9_-]+)(\/download|\/retry)?$/.exec(path);
      if (artifactMatch) {
        const service = required(options.artifacts, "Knowledge"); const id = artifactMatch[2]!;
        if (method === "GET" && artifactMatch[3] === "/download") { download(res, await service.download(id)); return true; }
        if (method === "GET" && !artifactMatch[3]) { json(res, service.detail(id)); return true; }
        if (method === "POST" && artifactMatch[3] === "/retry") { fields(input, ["expectedVersion"]); json(res, await service.retry(id, integer(input.expectedVersion))); return true; }
        if (method === "DELETE" && !artifactMatch[3]) { fields(input, ["expectedVersion"]); json(res, service.delete(id, integer(input.expectedVersion))); return true; }
      }
      const sourceMatch = /^\/api\/owner\/sources\/([a-zA-Z0-9_-]+)$/.exec(path);
      if (sourceMatch && method === "GET") { json(res, required(options.artifacts, "Knowledge").source(sourceMatch[1]!)); return true; }
      if (sourceMatch && method === "DELETE") { fields(input, ["expectedVersion"]); json(res, required(options.artifacts, "Knowledge").deleteSource(sourceMatch[1]!, integer(input.expectedVersion))); return true; }
      if (path === "/api/owner/connections" && method === "GET") { json(res, { connections: await required(options.connections, "Connected apps").list() }); return true; }
      if (path === "/api/owner/connections" && method === "POST") { fields(input, ["toolkit"]); const toolkit = text(input.toolkit, "toolkit", 80); if (!/^[a-zA-Z0-9_-]+$/.test(toolkit)) throw new WorkspaceHttpError(400, "Invalid toolkit"); json(res, await options.business.onboarding.connect(toolkit)); return true; }
      const connectionMatch = /^\/api\/owner\/connections\/([a-zA-Z0-9_-]+)$/.exec(path);
      if (connectionMatch && method === "DELETE") {
        fields(input, ["expectedVersion"]); const service = required(options.connections, "Connected apps"); const current = store.get<BusinessConnection>("connection", connectionMatch[1]!);
        if (!current) throw new WorkspaceHttpError(404, "Connection not found"); const expected = integer(input.expectedVersion);
        if (current.version !== expected) throw new WorkspaceHttpError(409, "Connection changed; refresh before disconnecting");
        json(res, await service.disconnect(current.id, expected)); return true;
      }
      if (path === "/api/owner/computer" && method === "GET") { json(res, await required(options.computer, "Hosted computer").status()); return true; }
      if (path === "/api/owner/computer/check" && method === "POST") { fields(input, []); json(res, await required(options.computer, "Hosted computer").check()); return true; }
      if (path === "/api/owner/computer/privacy" && method === "POST") {
        fields(input, ["sensitiveSessionCleared"]);
        if (input.sensitiveSessionCleared !== true) throw new WorkspaceHttpError(400, "Explicit confirmation that sensitive fields and sessions were cleared is required");
        const computer = required(options.computer, "Hosted computer"); if (!computer.clearPrivacy) throw new WorkspaceHttpError(503, "Computer privacy release is not configured");
        json(res, await computer.clearPrivacy()); return true;
      }
      if (path === "/api/owner/activity" && method === "GET") { const activity = store.activity(cursor(), 100); json(res, { activity, nextCursor: activity.at(-1)?.cursor ?? cursor(), hasMore: activity.length === 100, notifications: store.list("notification") }); return true; }
      const routineMatch = /^\/api\/owner\/routines\/([a-z-]+)$/.exec(path);
      if (routineMatch && method === "PATCH") {
        fields(input, ["expectedVersion", "routine"]); const routine = object(input.routine);
        fields(routine, ["kind", "name", "objective", "doneCriteria", "enabled", "sources", "timezone", "cron", "followUp"]);
        const service = required(options.commitments, "Standing routines");
        try { json(res, service.saveRoutine({ principal: OWNER, channel: "chat", ownerTurn: true }, routineMatch[1]!, integer(input.expectedVersion), routine as unknown as RoutineInput)); }
        catch (error) { if (error instanceof Error && !/conflict/i.test(error.message)) throw new WorkspaceHttpError(400, error.message); throw error; }
        return true;
      }
      const commitmentMatch = /^\/api\/owner\/commitments\/([^/]+)$/.exec(path);
      if (commitmentMatch && method === "DELETE") {
        fields(input, ["expectedVersion", "reason"]);
        json(res, required(options.commitments, "Commitments").cancel({ principal: OWNER, channel: "chat", ownerTurn: true }, decodeURIComponent(commitmentMatch[1]!), integer(input.expectedVersion), text(input.reason, "cancellation reason", 2000))); return true;
      }
      if (path === "/api/owner/settings" && method === "GET") { json(res, { settings: store.settings(), allowances: store.allowanceBalances(), sessions: sessions.summary(), routines: store.list("routine"), commitments: store.list("commitment"), backupAvailable: Boolean(options.operations), exportAvailable: Boolean(options.operations) }); return true; }
      if (path === "/api/owner/settings" && method === "PATCH") {
        fields(input, ["expectedVersion", "timezone", "currency", "constraints", "notificationPreferences", "limits", "backupRetention"]);
        const settings = store.settings(); if (settings.version !== integer(input.expectedVersion)) throw new WorkspaceHttpError(409, "Settings changed; refresh before saving");
        const timezone = text(input.timezone, "timezone", 100); try { new Intl.DateTimeFormat("en", { timeZone: timezone }); } catch { throw new WorkspaceHttpError(400, "Invalid timezone"); }
        const currency = text(input.currency, "currency", 3); if (!/^[A-Z]{3}$/.test(currency)) throw new WorkspaceHttpError(400, "Use a three-letter currency code");
        if (!Array.isArray(input.constraints) || input.constraints.length > 100) throw new WorkspaceHttpError(400, "Invalid constraints"); const constraints = input.constraints.map(v => text(v, "constraint", 2000));
        const preferences = object(input.notificationPreferences); fields(preferences, ["progress", "blockers", "completion"]); if ([preferences.progress, preferences.blockers, preferences.completion].some(v => typeof v !== "boolean")) throw new WorkspaceHttpError(400, "Invalid notifications");
        const limits = object(input.limits); fields(limits, ["purchaseMinor", "modelMinor"]); const purchaseMinor = limits.purchaseMinor === null ? null : integer(limits.purchaseMinor, "purchase limit"); const modelMinor = limits.modelMinor === null ? null : integer(limits.modelMinor, "model limit");
        const backupRetention = integer(input.backupRetention, "backup retention"); if (backupRetention < 1 || backupRetention > 365) throw new WorkspaceHttpError(400, "Backup retention must be 1–365");
        const updated = store.transaction(() => {
          const knowledge = required(options.artifacts, "Business profile");
          const authority = options.business.coordinator.ownerAuthority(OWNER, "chat", randomUUID(), "Update business timezone, currency and explicit standing rules from owner settings");
          knowledge.saveProfile({ expectedVersion: knowledge.profile().version, facts: [{ key: "timezone", value: timezone, scope: "business" }, { key: "currency", value: currency, scope: "business" }, { key: "standingRules", value: constraints, scope: "business" }] }, authority);
          const current = store.settings();
          const result = store.updateSettings(current.version, { ...current.value, timezone, currency, constraints, notificationPreferences: { progress: preferences.progress as boolean, blockers: preferences.blockers as boolean, completion: preferences.completion as boolean }, limits: { purchaseMinor, modelMinor, currency }, backupRetention });
          store.recordActivity("settings.updated", { version: result.version }); return result;
        });
        json(res, updated); return true;
      }
      if (path === "/api/owner/backup" && method === "POST") { fields(input, []); json(res, await required(options.operations, "Backup").backup()); return true; }
      if (path === "/api/owner/export" && method === "POST") { fields(input, []); download(res, await required(options.operations, "Export").export()); return true; }
      throw new WorkspaceHttpError(404, "Workspace endpoint not found");
    } catch (error) {
      if (!res.headersSent) {
        const missingRecord = error instanceof Error && (error.message === "Artifact not found" || error.message === "Source not found");
        const status = error instanceof WorkspaceHttpError ? error.status : missingRecord ? 404 : error instanceof Error && /conflict|revision|changed/i.test(error.message) ? 409 : 500;
        json(res, { error: status === 500 ? "Workspace operation failed. Inspect activity or retry after correcting the source." : (error as Error).message }, status);
      } else res.end();
    }
    return true;
  };
}
