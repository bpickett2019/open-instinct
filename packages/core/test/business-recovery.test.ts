import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BusinessStore, businessHash } from "../src/business-store.js";
import { buildBusinessExport, createBusinessBackup, deleteBusinessWorkspace, restoreBusinessBackup } from "../src/business-recovery.js";
import type { BusinessAction, BusinessTask } from "../src/business-types.js";

const roots: string[] = [];
const stores: BusinessStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "business-recovery-"))); roots.push(root);
  const store = new BusinessStore(join(root, "business"), () => 1000); stores.push(store);
  const task: BusinessTask = {
    id: randomUUID(), workspaceId: store.settings().value.workspaceId, objective: "Send the sourced proposal", doneCriteria: ["Verified message"],
    origin: { channel: "chat", conversationKey: "chat:owner", replyRef: {}, requester: "owner", audience: "owner" }, authorityRef: "owner-authority", sourceRefs: [],
    version: 1, status: "running", executionEpoch: 1, runId: "run", checkpoint: null, result: null, evidenceRefs: [], blocker: null, nextWake: null,
    dispatches: 1, noProgress: 0, createdAt: 1000, updatedAt: 1000,
  };
  store.insertTask(task, "request");
  store.put("authority", "owner-authority", { id: "owner-authority", enabled: true, kind: "owner", sourceId: "owner-request", scope: "Send the sourced proposal", version: 1 }, null);
  store.put("routine", "daily", { enabled: true }, null);
  store.put("commitment", "chase", { status: "active" }, null);
  store.put("connection", "gmail", { id: "gmail", toolkit: "gmail", accountId: "account", identity: "owner@example.test", scopes: [], status: "connected", epoch: 1, connectedBy: "owner", verifiedAt: 1000, revocation: "none", revokeJobId: null }, null);
  const args = { recipient: "customer@example.test", body: "A sourced proposal" };
  const action: BusinessAction = { id: randomUUID(), taskId: task.id, taskRevision: 1, version: 1, stepId: "send", tool: "gmail_send", arguments: args, argsHash: businessHash(args), sourceRevisions: {}, effectful: true, status: "dispatching", runId: "run", receipt: null, evidenceRefs: [], error: null, createdAt: 1000, updatedAt: 1000 };
  store.insertAction(action);
  const fileId = randomUUID(); const bytes = Buffer.from("Original business source");
  mkdirSync(join(store.root, "artifacts"), { mode: 0o700 });
  writeFileSync(join(store.root, "artifacts", `${fileId}.bin`), bytes, { mode: 0o600 });
  store.put("artifact", fileId, { storageKey: `${fileId}.bin`, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), deleted: false }, null);
  return { root, store, task, action, fileId, bytes, backup: join(root, "backups") };
}

describe("business recovery", () => {
  it("restores a WAL snapshot and original artifacts in stopped investigation mode, never queued", () => {
    const f = fixture();
    const manifest = createBusinessBackup(f.store, { destination: f.backup, retention: 2 });
    f.store.appendMessage({ id: "later", role: "notice", text: "Not in snapshot", channel: "chat", thread: "chat:owner", taskId: null, artifactIds: [], at: 2000 });
    const destination = join(f.root, "restored");
    const result = restoreBusinessBackup({ source: join(f.backup, manifest.id), destination });
    expect(result.stopped).toBe(true);
    const restored = new BusinessStore(destination); stores.push(restored);
    expect(restored.settings().value.stopped).toBe(true);
    expect(restored.settings().value.globalControlEpoch).toBeGreaterThan(0);
    expect(restored.task(f.task.id)?.status).toBe("blocked");
    expect(restored.task(f.task.id)?.runId).toBeNull();
    expect(restored.action(f.action.id)?.status).toBe("unknown");
    expect(restored.get<{ enabled: boolean }>("authority", "owner-authority")?.value.enabled).toBe(false);
    expect(restored.get<{ status: string }>("connection", "gmail")?.value.status).toBe("disabled");
    expect(restored.get("cursor", "restore-investigation")).toBeDefined();
    expect(restored.messages()).toHaveLength(0);
    expect(readFileSync(join(destination, "artifacts", `${f.fileId}.bin`))).toEqual(f.bytes);
  });

  it("refuses a running destination and a stopped-but-different workspace", () => {
    const f = fixture(); const manifest = createBusinessBackup(f.store, { destination: f.backup, retention: 2 });
    const source = join(f.backup, manifest.id);
    expect(() => restoreBusinessBackup({ source, destination: f.store.root })).toThrow(/owned/);
    f.store.close();
    expect(() => restoreBusinessBackup({ source, destination: f.store.root })).toThrow(/stopped/);
    const other = new BusinessStore(join(f.root, "other"));
    const settings = other.settings(); other.updateSettings(settings.version, { ...settings.value, stopped: true }); other.close();
    expect(() => restoreBusinessBackup({ source, destination: join(f.root, "other") })).toThrow(/different workspace/);
  });

  it("replaces an offline stopped directory while retaining the previous state", () => {
    const f = fixture(); const manifest = createBusinessBackup(f.store, { destination: f.backup, retention: 2 });
    const settings = f.store.settings(); f.store.updateSettings(settings.version, { ...settings.value, stopped: true }); f.store.close();
    const result = restoreBusinessBackup({ source: join(f.backup, manifest.id), destination: f.store.root });
    expect(result.replacedDirectory).not.toBeNull();
    expect(existsSync(join(result.replacedDirectory!, "business.sqlite"))).toBe(true);
    const restored = new BusinessStore(f.store.root); stores.push(restored);
    expect(restored.settings().value.stopped).toBe(true);
  });

  it.each(["database", "artifact", "traversal", "symlink", "missing-manifest", "unknown-schema", "missing-artifact"])("rejects %s corruption without installing partial state", kind => {
    const f = fixture(); const manifest = createBusinessBackup(f.store, { destination: f.backup, retention: 2 });
    const source = join(f.backup, manifest.id); const destination = join(f.root, "restored");
    if (kind === "database") writeFileSync(join(source, "business.sqlite"), "corrupt");
    if (kind === "artifact") writeFileSync(join(source, "artifacts", `${f.fileId}.bin`), "changed");
    if (kind === "traversal") { manifest.artifacts[0]!.storageKey = "../../outside"; writeFileSync(join(source, "manifest.json"), JSON.stringify(manifest)); }
    if (kind === "symlink") { rmSync(join(source, "artifacts", `${f.fileId}.bin`)); symlinkSync(join(f.store.root, "artifacts", `${f.fileId}.bin`), join(source, "artifacts", `${f.fileId}.bin`)); }
    if (kind === "missing-manifest") rmSync(join(source, "manifest.json"));
    if (kind === "missing-artifact") rmSync(join(source, "artifacts", `${f.fileId}.bin`));
    if (kind === "unknown-schema") {
      const db = new DatabaseSync(join(source, "business.sqlite"));
      db.exec("PRAGMA user_version=999"); db.close();
      const bytes = readFileSync(join(source, "business.sqlite"));
      manifest.database = { size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
      writeFileSync(join(source, "manifest.json"), JSON.stringify(manifest));
    }
    expect(() => restoreBusinessBackup({ source, destination })).toThrow();
    expect(existsSync(destination)).toBe(false);
  });

  it("requires explicit valid retention and prunes only completed snapshots for this workspace", () => {
    const f = fixture();
    expect(() => createBusinessBackup(f.store, { destination: f.backup, retention: 0 })).toThrow(/retention/);
    const first = createBusinessBackup(f.store, { destination: f.backup, retention: 1 });
    writeFileSync(join(f.backup, "unrelated.txt"), "keep");
    const second = createBusinessBackup(f.store, { destination: f.backup, retention: 1 });
    expect(existsSync(join(f.backup, first.id))).toBe(false);
    expect(existsSync(join(f.backup, second.id))).toBe(true);
    expect(readFileSync(join(f.backup, "unrelated.txt"), "utf8")).toBe("keep");
    expect(readdirSync(f.backup).filter(name => name === first.id || name === second.id)).toEqual([second.id]);
  });

  it("exports actual business files and history but not credential stores or structured secrets", () => {
    const f = fixture();
    mkdirSync(join(f.store.root, "secrets")); writeFileSync(join(f.store.root, "secrets", "credentials.json"), JSON.stringify({ token: "do-not-export" }));
    f.store.put("profile", "current", { name: "Synthetic business", accessToken: "private-oauth-value" }, null);
    f.store.appendMessage({ id: "notice", role: "notice", text: "Done", channel: "chat", thread: "chat:owner", taskId: f.task.id, artifactIds: [f.fileId], at: 1000 });
    const exported = buildBusinessExport(f.store);
    const text = Buffer.from(exported.bytes).toString("utf8");
    expect(text).not.toContain("do-not-export"); expect(text).not.toContain("private-oauth-value");
    const data = JSON.parse(text);
    expect(data.messages[0].text).toBe("Done");
    expect(Buffer.from(data.files[0].content, "base64")).toEqual(f.bytes);
    expect(data.tasks[0].id).toBe(f.task.id);
  });

  it("requires stop, exact owner workspace ID and upstream disconnect requests before deletion", () => {
    const f = fixture(); const id = f.store.settings().value.workspaceId;
    f.store.close();
    expect(() => deleteBusinessWorkspace({ directory: f.store.root, confirmWorkspaceId: id })).toThrow(/stop/);
    const store = new BusinessStore(f.store.root); stores.push(store);
    const settings = store.settings(); store.updateSettings(settings.version, { ...settings.value, stopped: true }); store.close();
    expect(() => deleteBusinessWorkspace({ directory: f.store.root, confirmWorkspaceId: "wrong" })).toThrow(/confirmation/);
    expect(() => deleteBusinessWorkspace({ directory: f.store.root, confirmWorkspaceId: id })).toThrow(/Disconnect/);
    const stopped = new BusinessStore(f.store.root); stores.push(stopped);
    const connection = stopped.get<Record<string, unknown>>("connection", "gmail")!;
    stopped.put("connection", "gmail", { ...connection.value, status: "disabled", revocation: "requested" }, connection.version); stopped.close();
    deleteBusinessWorkspace({ directory: f.store.root, confirmWorkspaceId: id });
    expect(existsSync(f.store.root)).toBe(false);
  });
});
