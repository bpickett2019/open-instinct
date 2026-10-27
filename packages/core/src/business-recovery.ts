import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { BUSINESS_SCHEMA_VERSION, BusinessStore } from "./business-store.js";
import { acquireBusinessLock, privateBusinessPath } from "./business-lock.js";
import type { BusinessConnection, BusinessSettings, Json } from "./business-types.js";

interface ArtifactEntry { id: string; storageKey: string; sha256: string; size: number; deleted: boolean }
export interface BusinessBackupManifest {
  format: "open-instinct-business-backup";
  version: 1;
  id: string;
  workspaceId: string;
  createdAt: number;
  retention: number;
  database: { sha256: string; size: number };
  artifacts: ArtifactEntry[];
}
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const MAX_EXPORT_BYTES = 256 * 1024 * 1024;
const RESTORE_NOTE = "Restored snapshot may predate external effects. Reconcile provider history since the snapshot before any new work; never replay prior dispatches.";

function digest(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function regular(path: string): void {
  privateBusinessPath(path);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Recovery requires a regular file");
}
function syncFile(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function save(path: string, bytes: string | Uint8Array): void {
  writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
  syncFile(path);
}
function directory(path: string): void {
  privateBusinessPath(path);
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) throw new Error("Recovery directory must be private (0700)");
  } else mkdirSync(path, { recursive: true, mode: 0o700 });
}
function artifact(value: unknown, id?: string): ArtifactEntry {
  if (!value || typeof value !== "object") throw new Error("Invalid artifact manifest");
  const v = value as ArtifactEntry;
  const keyId = id ?? v.id;
  if (typeof keyId !== "string" || !UUID.test(keyId) || v.storageKey !== `${keyId}.bin` || !HASH.test(v.sha256) || !Number.isSafeInteger(v.size) || v.size < 0 || v.size > 20 * 1024 * 1024 || typeof v.deleted !== "boolean") throw new Error("Invalid artifact manifest");
  return { id: keyId, storageKey: v.storageKey, sha256: v.sha256, size: v.size, deleted: v.deleted };
}
function artifacts(store: BusinessStore): ArtifactEntry[] {
  return store.list<unknown>("artifact").map(row => artifact(row.value, row.id));
}
function artifactBytes(root: string, item: ArtifactEntry): Buffer {
  const path = join(root, "artifacts", item.storageKey);
  regular(path);
  if (lstatSync(path).size !== item.size) throw new Error(`Artifact size mismatch: ${item.id}`);
  const bytes = readFileSync(path);
  if (digest(bytes) !== item.sha256) throw new Error(`Artifact hash mismatch: ${item.id}`);
  return bytes;
}
function settingsAt(root: string): BusinessSettings {
  const path = join(root, "business.sqlite");
  regular(path);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const version = Number(db.prepare("PRAGMA user_version").get()?.user_version);
    if (!Number.isInteger(version) || version < 1 || version > BUSINESS_SCHEMA_VERSION || db.prepare("PRAGMA quick_check").get()?.quick_check !== "ok") throw new Error("Unsupported or corrupt business database");
    const row = db.prepare("SELECT payload FROM settings WHERE id=1").get();
    if (!row || typeof row.payload !== "string") throw new Error("Missing business settings");
    const value = JSON.parse(row.payload) as BusinessSettings;
    if (!UUID.test(value.workspaceId) || typeof value.stopped !== "boolean") throw new Error("Invalid business settings");
    return value;
  } finally { db.close(); }
}
function separate(root: string, target: string): void {
  const rel = relative(resolve(root), resolve(target));
  if (!rel || !(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))) throw new Error("Recovery destination must be outside business state");
}

/** SQLite VACUUM INTO includes WAL commits in one consistent snapshot. */
export function createBusinessBackup(store: BusinessStore, options: { destination: string; retention: number }): BusinessBackupManifest {
  if (!Number.isSafeInteger(options.retention) || options.retention < 1 || options.retention > 1000) throw new Error("Explicit backup retention must be 1..1000 snapshots");
  const destination = privateBusinessPath(options.destination);
  separate(store.root, destination);
  directory(destination);
  const id = randomUUID();
  const stage = join(destination, `.incomplete-${id}`);
  const final = join(destination, id);
  directory(stage);
  try {
    const settings = store.settings();
    if (settings.value.backupRetention !== options.retention) store.updateSettings(settings.version, { ...settings.value, backupRetention: options.retention });
    const createdAt = store.now();
    const source = new DatabaseSync(store.dbPath, { readOnly: true });
    try { source.prepare("VACUUM INTO ?").run(join(stage, "business.sqlite")); } finally { source.close(); }
    chmodSync(join(stage, "business.sqlite"), 0o600);
    const workspaceId = settingsAt(stage).workspaceId;
    const snapshot = new DatabaseSync(join(stage, "business.sqlite"), { readOnly: true });
    let entries: ArtifactEntry[];
    try {
      entries = snapshot.prepare("SELECT id,payload FROM records WHERE kind='artifact' ORDER BY updated_at,id").all().map(row => artifact(JSON.parse(String(row.payload)), String(row.id)));
    } finally { snapshot.close(); }
    directory(join(stage, "artifacts"));
    for (const item of entries) save(join(stage, "artifacts", item.storageKey), artifactBytes(store.root, item));
    const bytes = readFileSync(join(stage, "business.sqlite"));
    const manifest: BusinessBackupManifest = { format: "open-instinct-business-backup", version: 1, id, workspaceId, createdAt, retention: options.retention, database: { sha256: digest(bytes), size: bytes.length }, artifacts: entries };
    syncFile(join(stage, "business.sqlite"));
    save(join(stage, "manifest.json"), JSON.stringify(manifest, null, 2));
    renameSync(stage, final);
    // Prune only validated snapshots for this workspace. Never touch unrelated files.
    const prior: Array<{ path: string; manifest: BusinessBackupManifest }> = [];
    for (const name of readdirSync(destination)) {
      if (!UUID.test(name)) continue;
      const path = join(destination, name);
      if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) continue;
      let candidate: BusinessBackupManifest;
      try { candidate = readManifest(path); } catch { continue; }
      if (candidate.workspaceId === workspaceId) prior.push({ path, manifest: candidate });
    }
    prior.sort((a, b) => Number(b.path === final) - Number(a.path === final) || b.manifest.createdAt - a.manifest.createdAt || b.manifest.id.localeCompare(a.manifest.id));
    for (const old of prior.slice(options.retention)) if (old.path !== final) rmSync(old.path, { recursive: true });
    store.recordActivity("backup.created", { id, createdAt, retention: options.retention });
    return manifest;
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}

function readManifest(source: string): BusinessBackupManifest {
  regular(join(source, "manifest.json"));
  if (lstatSync(join(source, "manifest.json")).size > 16 * 1024 * 1024) throw new Error("Backup manifest too large");
  const m = JSON.parse(readFileSync(join(source, "manifest.json"), "utf8")) as BusinessBackupManifest;
  if (m.format !== "open-instinct-business-backup" || m.version !== 1 || !UUID.test(m.id) || !UUID.test(m.workspaceId) || !Number.isSafeInteger(m.createdAt) || m.createdAt < 0 || !Number.isSafeInteger(m.retention) || m.retention < 1 || !m.database || !HASH.test(m.database.sha256) || !Number.isSafeInteger(m.database.size) || m.database.size <= 0 || !Array.isArray(m.artifacts)) throw new Error("Invalid backup manifest");
  m.artifacts = m.artifacts.map(item => artifact(item));
  if (new Set(m.artifacts.map(item => item.id)).size !== m.artifacts.length) throw new Error("Duplicate backup artifacts");
  return m;
}

/** Operator only. Never expose this or deletion as a worker tool. */
export function restoreBusinessBackup(options: { source: string; destination: string }): { workspaceId: string; snapshotAt: number; stopped: true; replacedDirectory: string | null } {
  const source = privateBusinessPath(options.source);
  const destination = privateBusinessPath(options.destination);
  separate(source, destination);
  separate(destination, source);
  const release = acquireBusinessLock(destination);
  const stage = join(dirname(destination), `.${basename(destination)}-restore-${randomUUID()}`);
  let replacedDirectory: string | null = null;
  try {
    const manifest = readManifest(source);
    if (existsSync(destination)) {
      if (!lstatSync(destination).isDirectory()) throw new Error("Restore destination is not a directory");
      if (readdirSync(destination).length) {
        const previous = settingsAt(destination);
        if (!previous.stopped) throw new Error("Restore requires a fresh or durably stopped directory");
        if (previous.workspaceId !== manifest.workspaceId) throw new Error("Restore cannot replace a different workspace");
      }
    }
    regular(join(source, "business.sqlite"));
    const database = readFileSync(join(source, "business.sqlite"));
    if (database.length !== manifest.database.size || digest(database) !== manifest.database.sha256) throw new Error("Backup database hash mismatch");
    directory(stage);
    save(join(stage, "business.sqlite"), database);
    directory(join(stage, "artifacts"));
    for (const item of manifest.artifacts) save(join(stage, "artifacts", item.storageKey), artifactBytes(source, item));
    const restored = new BusinessStore(stage);
    try {
      const current = restored.settings();
      if (current.value.workspaceId !== manifest.workspaceId) throw new Error("Backup workspace identity mismatch");
      const declared = new Map(manifest.artifacts.map(item => [item.id, JSON.stringify(item)]));
      const actual = artifacts(restored);
      if (actual.length !== declared.size || actual.some(item => declared.get(item.id) !== JSON.stringify(item))) throw new Error("Snapshot artifact manifest mismatch");
      restored.transaction(() => {
        restored.updateSettings(current.version, { ...current.value, stopped: true, globalControlEpoch: current.value.globalControlEpoch + 1 });
        for (const task of restored.tasks()) {
          if (["completed", "cancelled", "failed"].includes(task.status)) continue;
          restored.updateTask({ ...task, status: "blocked", version: task.version + 1, executionEpoch: task.executionEpoch + 1, runId: null, nextWake: null, blocker: RESTORE_NOTE, updatedAt: restored.now() }, task.version);
        }
        for (const action of restored.actions()) {
          if (!["dispatching", "accepted", "unknown", "prepared"].includes(action.status)) continue;
          restored.updateAction({ ...action, status: action.status === "prepared" ? "cancelled" : "unknown", version: action.version + 1, error: RESTORE_NOTE, updatedAt: restored.now() }, action.version);
        }
        for (const wait of restored.waits()) if (wait.status === "waiting") restored.putWait({ ...wait, status: "cancelled" }, "waiting");
        for (const kind of ["authority", "routine", "commitment"] as const) {
          for (const row of restored.list<Record<string, Json>>(kind)) restored.put(kind, row.id, { ...row.value, enabled: false, status: "cancelled", cancellationReason: RESTORE_NOTE }, row.version);
        }
        for (const row of restored.list<BusinessConnection>("connection")) restored.put("connection", row.id, { ...row.value, status: "disabled", epoch: row.value.epoch + 1, verifiedAt: null }, row.version);
        for (const row of restored.list<Record<string, Json>>("notification")) {
          if (["accepted", "delivered", "failed", "cancelled"].includes(String(row.value.status))) continue;
          restored.put("notification", row.id, { ...row.value, status: "unknown", note: RESTORE_NOTE }, row.version);
        }
        const prior = restored.get("cursor", "restore-investigation");
        restored.put("cursor", "restore-investigation", { snapshotAt: manifest.createdAt, restoredAt: restored.now(), status: "required", note: RESTORE_NOTE }, prior?.version ?? null);
        restored.recordActivity("workspace.restored", { snapshotAt: manifest.createdAt, backupId: manifest.id, note: RESTORE_NOTE });
      });
    } finally { restored.close(); }
    syncFile(join(stage, "business.sqlite"));
    if (existsSync(destination)) {
      replacedDirectory = `${destination}.pre-restore-${randomUUID()}`;
      renameSync(destination, replacedDirectory);
    }
    try { renameSync(stage, destination); } catch (error) {
      if (replacedDirectory) renameSync(replacedDirectory, destination);
      throw error;
    }
    return { workspaceId: manifest.workspaceId, snapshotAt: manifest.createdAt, stopped: true, replacedDirectory };
  } finally {
    rmSync(stage, { recursive: true, force: true });
    release();
  }
}

const SECRET_KEY = /(?:password|secret|api.?key|access.?token|refresh.?token|authorization|cookie|card.?number|cvv|cvc|client.?secret|takeover.?url|session.?token)|^(?:token|key|credential|credentials|session|headers|env|pan)$/i;
function withoutCredentials(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutCredentials);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => !SECRET_KEY.test(key)).map(([key, item]) => [key, withoutCredentials(item)]));
  if (typeof value === "string") return value.replace(/Bearer\s+[^\s"<>]+/gi, "Bearer [redacted]").replace(/([?&](?:token|key|secret|code)=)[^&#\s]*/gi, "$1[redacted]");
  return value;
}

/** Credential stores, environment, browser sessions and raw SQLite are never exported. */
export function buildBusinessExport(store: BusinessStore): { bytes: Uint8Array; filename: string; mimeType: string } {
  const data = store.transaction(() => {
    const messages = [];
    let after = 0;
    for (;;) {
      const page = store.messages(after, 200);
      messages.push(...page);
      if (page.length < 200) break;
      after = page[page.length - 1]!.cursor;
    }
    return { format: "open-instinct-business-export", version: 1, createdAt: store.now(), settings: store.settings().value, profile: store.list("profile"), knowledge: store.list("knowledge"), artifacts: store.list("artifact"), tasks: store.tasks(), actions: store.actions(), messages };
  });
  const entries = data.artifacts.map(row => artifact(row.value, row.id)).filter(item => !item.deleted);
  if (entries.reduce((size, item) => size + item.size, 0) > MAX_EXPORT_BYTES / 2) throw new Error("Business export exceeds 128 MiB of artifacts; use private operator backup");
  const payload = { ...withoutCredentials(data) as object, files: entries.map(item => ({ id: item.id, sha256: item.sha256, encoding: "base64", content: artifactBytes(store.root, item).toString("base64") })), retentionNotice: "Deleted originals and action evidence may remain in private backups and third-party providers. Export includes active artifact contents, which may contain private owner-supplied data." };
  const bytes = Buffer.from(JSON.stringify(payload, null, 2));
  if (bytes.length > MAX_EXPORT_BYTES) throw new Error("Business export exceeds 256 MiB");
  return { bytes, filename: `business-export-${data.createdAt}.json`, mimeType: "application/json" };
}
export function exportBusinessWorkspace(store: BusinessStore, options: { destination: string }): { filename: string; size: number } {
  const file = privateBusinessPath(options.destination);
  separate(store.root, file);
  directory(dirname(file));
  const output = buildBusinessExport(store);
  save(file, output.bytes);
  return { filename: file, size: output.bytes.length };
}

export function deleteBusinessWorkspace(options: { directory: string; confirmWorkspaceId: string }): void {
  const root = privateBusinessPath(options.directory);
  const release = acquireBusinessLock(root);
  try {
    const settings = settingsAt(root);
    if (!settings.stopped || settings.workspaceId !== options.confirmWorkspaceId) throw new Error("Deletion requires durable stop and exact workspace ID confirmation");
    const db = new DatabaseSync(join(root, "business.sqlite"), { readOnly: true });
    try {
      for (const row of db.prepare("SELECT payload FROM records WHERE kind='connection'").all()) {
        const connection = JSON.parse(String(row.payload)) as BusinessConnection;
        if (connection.status !== "disabled" || connection.revocation !== "requested") throw new Error("Disconnect every provider and request upstream revocation before deletion");
      }
    } finally { db.close(); }
    rmSync(root, { recursive: true });
  } finally { release(); }
}
