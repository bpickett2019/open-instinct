import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import type { CallToolResult, Tool } from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import { BusinessStore, ToolRegistry, type ToolContext } from "@open-instinct/core";
import { MaritimeMcpBackend, type ComputerPrivacy } from "@open-instinct/computer";
import { BusinessCoordinator } from "../src/business-coordinator.js";
import { BusinessKnowledge } from "../src/business-knowledge.js";
import { createHostedArtifactTools } from "../src/business-hosted-artifacts.js";
import { MAX_UPLOAD_BYTES } from "../src/business-extraction.js";

const principal = { kind: "owner" as const, id: "owner", tier: "owner" as const, displayName: "Synthetic owner" };
const args = { path: "/data/output.txt", filename: "output.txt", mimeType: "text/plain", expectedText: ["Inspection", "42.00"] };
const content = "Inspection\nTotal: 42.00\n";
const catalog: Tool[] = [
  { name: "get_computer", inputSchema: { type: "object", properties: {} } },
  { name: "read_file", inputSchema: { type: "object", properties: { computer_id: { type: "string" }, path: { type: "string" } }, required: ["computer_id", "path"] } },
];
let root: string, store: BusinessStore, coordinator: BusinessCoordinator, knowledge: BusinessKnowledge;
let closeProvider: (() => Promise<void>) | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hosted-artifact-"));
  store = new BusinessStore(join(root, "private"));
  coordinator = new BusinessCoordinator(store);
  knowledge = new BusinessKnowledge(store);
});
afterEach(async () => { await closeProvider?.(); closeProvider = undefined; await knowledge.close(); await coordinator.close(); store.close(); rmSync(root, { recursive: true, force: true }); });

// Synthetic MCP protocol only; no shell, desktop application or live provider is run.
async function fixture(response: unknown = { path: args.path, encoding: "utf8", content }, tools = catalog) {
  const pair = createInMemoryTransportPair();
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  let privacy: ComputerPrivacy = { takeover: false, credentialEntry: false };
  let leased = false;
  let pauseOnRead = false;
  pair.server.onMessage(message => {
    if (!("method" in message) || !("id" in message)) return;
    const params = (message.params ?? {}) as Record<string, unknown>;
    let result: unknown;
    if (message.method === "initialize") result = { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "synthetic-artifact-provider", version: "1" } };
    else if (message.method === "tools/list") result = { tools };
    else if (message.method === "tools/call") {
      expect(leased).toBe(true);
      const name = String(params.name), request = (params.arguments ?? {}) as Record<string, unknown>;
      calls.push({ name, args: request });
      if (name === "read_file" && pauseOnRead) coordinator.control(principal, "workspace", "pause");
      result = name === "get_computer" ? { content: [{ type: "text", text: JSON.stringify({ computer_id: "synthetic-computer", status: "ready" }) }] }
        : response && typeof response === "object" && "isError" in response ? response
        : { content: [{ type: "text", text: typeof response === "string" ? response : JSON.stringify(response) }] } satisfies CallToolResult;
    } else result = {};
    void pair.server.send({ jsonrpc: "2.0", id: message.id, result });
  });
  await pair.server.start();
  const ownerRef = coordinator.ownerAuthority(principal, "chat", "synthetic-owner-instruction", "Prepare checked output");
  const task = coordinator.admitTask({ channel: "chat", conversationKey: "chat:owner", replyRef: {}, requester: "owner", audience: "owner" }, ownerRef, { objective: "Import checked output", doneCriteria: ["Registered extracted document"] }, "hosted-import");
  const run = coordinator.claimRun(task.id)!;
  const backend = new MaritimeMcpBackend({ url: "https://mcp.synthetic.test", apiKey: "synthetic", externalUserId: store.settings().value.workspaceId, transportFactory: () => pair.client,
    business: { workspaceId: store.settings().value.workspaceId, privacy: () => privacy, setPrivacy: value => { privacy = value; }, notifyTakeover: async () => { throw new Error("No takeover request expected"); },
      withLease: (ctx, invoke) => coordinator.withComputerLease(ctx.taskRun!, async () => { leased = true; try { return await invoke(); } finally { leased = false; } }),
    },
  });
  closeProvider = async () => { await backend.close(); await pair.server.close(); };
  const ctx: ToolContext = { principal, channel: "chat", conversationKey: "chat:owner", now: () => new Date(), taskRun: run, businessDispatch: coordinator, nextBusinessStep: id => id };
  const registry = new ToolRegistry();
  const registered = createHostedArtifactTools({ knowledge, backend: () => backend });
  registry.registerMany(registered);
  const tool = registry.bind(ctx)[0]!;
  return { calls, ctx, spec: registered[0]!.spec, run: (input: unknown = args) => tool.execute("synthetic-import-step", input, new AbortController().signal), setPrivacy: (value: ComputerPrivacy) => { privacy = value; }, pauseOnRead: () => { pauseOnRead = true; }, task };
}

describe("hosted document artifact transfer", () => {
  it("runs the real registered wrapper and dispatcher, preserving bytes and source without transfer payload in action history", async () => {
    const f = await fixture();
    const result = await f.run();
    const artifact = knowledge.list()[0]!;
    expect(artifact).toMatchObject({ extraction: "ready", authority: "evidence", source: "generated" });
    expect((await knowledge.download(artifact.id)).bytes).toEqual(Buffer.from(content));
    expect(knowledge.source(artifact.id).value.sourceLocator).toBe(`task:${f.task.id}:hosted-file:${encodeURIComponent(args.path)}`);
    expect(f.calls.map(call => call.name)).toEqual(["get_computer", "read_file"]);
    expect(f.calls[1]!.args).toEqual({ path: args.path, computer_id: "synthetic-computer" });
    expect(JSON.stringify(result)).not.toContain(content);
    expect(JSON.stringify(result)).not.toContain(args.path);
    const actions = store.actions(f.task.id);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ status: "verified" });
    expect(JSON.stringify(actions)).not.toContain(content);
    expect(JSON.stringify(actions)).toContain("document-readback");
  });

  it("imports actual XLSX bytes over explicit base64 and checks extracted text and totals", async () => {
    const workbook = new ExcelJS.Workbook(), sheet = workbook.addWorksheet("Quote");
    sheet.addRow(["Inspection", "42.00"]);
    const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
    const mimeType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const f = await fixture({ path: "/data/quote.xlsx", encoding: "base64", data: bytes.toString("base64"), bytes: bytes.length, sha256, mime: mimeType });
    await f.run({ ...args, path: "/data/quote.xlsx", filename: "quote.xlsx", mimeType });
    const artifact = knowledge.list()[0]!;
    expect(artifact).toMatchObject({ sha256, extraction: "ready" });
    expect((await knowledge.download(artifact.id)).bytes).toEqual(bytes);
    expect(knowledge.search("Inspection")).not.toHaveLength(0);
  });

  it.each([
    ["malformed base64", { encoding: "base64", data: "%%%=" }],
    ["noncanonical base64", { encoding: "base64", data: "Zh==" }],
    ["absent encoding", { content }],
    ["ambiguous fields", { encoding: "utf8", content, data: content }],
    ["path mismatch", { encoding: "utf8", content, path: "/data/other.txt" }],
    ["byte mismatch", { encoding: "utf8", content, bytes: 1 }],
    ["hash mismatch", { encoding: "utf8", content, sha256: "a".repeat(64) }],
    ["unsupported hash", { encoding: "utf8", content, hash: "unknown" }],
    ["MIME mismatch", { encoding: "utf8", content, mime: "application/pdf" }],
    ["truncated file", { encoding: "utf8", content, truncated: true }],
    ["private envelope", { encoding: "utf8", content, private: true }],
    ["provider error", { isError: true, content: [{ type: "text", text: "private provider error" }] }],
    ["plain text", content],
    ["privacy note", "Screenshots and provider echoes withheld"],
  ])("fails closed for %s without an artifact", async (_name, response) => {
    const f = await fixture(response);
    await expect(f.run()).rejects.toThrow(/blocked/);
    expect(knowledge.list()).toEqual([]);
  });

  it.each(["takeover", "credentialEntry"] as const)("preserves provider %s privacy boundary", async key => {
    const f = await fixture(); f.setPrivacy({ takeover: key === "takeover", credentialEntry: key === "credentialEntry" });
    await expect(f.run()).rejects.toThrow(/blocked/);
    expect(knowledge.list()).toEqual([]);
    if (key === "takeover") expect(f.calls).toEqual([]);
  });

  it("rejects oversized transfer before registration", async () => {
    const f = await fixture({ encoding: "base64", data: "A".repeat(Math.ceil(MAX_UPLOAD_BYTES / 3) * 4 + 4) });
    await expect(f.run()).rejects.toThrow(/oversized|20 MiB/);
    expect(knowledge.list()).toEqual([]);
  });

  it("does not convert a primitive transfer into verified document evidence when extracted totals mismatch", async () => {
    const f = await fixture();
    await expect(f.run({ ...args, expectedText: ["999.00"] })).rejects.toThrow(/content validation failed/);
    expect(knowledge.list()[0]).toMatchObject({ extraction: "failed" });
    expect(JSON.stringify(store.actions(f.task.id))).toContain("primitive-only");
    expect(JSON.stringify(store.actions(f.task.id))).not.toContain("document-readback");
  });

  it("checks the final fence after provider read, before registering anything", async () => {
    const f = await fixture(); f.pauseOnRead();
    await expect(f.run()).rejects.toThrow();
    expect(knowledge.list()).toEqual([]);
  });

  it("rejects direct calls, identity injection and traversal before transfer", async () => {
    const f = await fixture();
    await expect(f.spec.execute(args, f.ctx)).rejects.toThrow(/final owner-scoped task/);
    for (const input of [{ ...args, taskId: f.task.id }, { ...args, workspaceId: "other" }, { ...args, path: "/data/../private" }, { ...args, filename: "../output.txt" }]) {
      await expect(f.spec.execute(input, { ...f.ctx, businessInvocation: true, assertBusinessDispatch: () => coordinator.assertActive(f.ctx.taskRun!) })).rejects.toThrow(/blocked/);
    }
    expect(f.calls).toEqual([]);
  });

  it("does not accept fabricated artifact evidence or a missing hosted backend", async () => {
    const f = await fixture();
    const ctx = { ...f.ctx, businessInvocation: true, assertBusinessDispatch: () => coordinator.assertActive(f.ctx.taskRun!) };
    const fake = { content: [{ type: "text" as const, text: JSON.stringify({ artifactId: "model-selected", sha256: "a".repeat(64) }) }] };
    expect(await f.spec.verify!(args, fake, ctx)).toMatchObject({ verified: false, evidenceRefs: [] });
    const unavailable = createHostedArtifactTools({ knowledge, backend: () => undefined })[0]!.spec;
    await expect(unavailable.execute(args, ctx)).rejects.toThrow(/backend unavailable/);
    expect(f.calls).toEqual([]);
  });

  it.each([
    { tools: catalog.filter(tool => tool.name !== "read_file") },
    { tools: [catalog[0]!, { name: "read_file", inputSchema: { type: "object", properties: { filename: { type: "string" } }, required: ["filename"] } }] as Tool[] },
  ])("blocks when discovered read_file contract is unavailable", async ({ tools }) => {
    const f = await fixture(undefined, tools);
    await expect(f.run()).rejects.toThrow(/contract unavailable|input schema/);
    expect(f.calls).toEqual([]);
  });
});
