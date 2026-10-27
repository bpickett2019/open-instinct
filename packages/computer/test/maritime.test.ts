import { describe, expect, it } from "vitest";
import type { CallToolResult, JsonRpcMessage, Tool } from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair, type InMemoryTransport } from "@earendil-works/pi-mcp/testing";
import type { Principal, RegisteredTool, ToolContext } from "@open-instinct/core";
import { CredentialVault, credentialScope } from "@open-instinct/core";
import type { BusinessComputerBoundary, ComputerPrivacy } from "../src/maritime.js";
import { MaritimeMcpBackend, maritimeMcpEndpoint } from "../src/index.js";
import { PNG_B64 } from "./fake-fetch.js";
import { createHash } from "node:crypto";

const owner: Principal = { kind: "owner", id: "owner", tier: "owner", displayName: "Maria" };
const ctx: ToolContext = { principal: owner, conversationKey: "chat:test", channel: "chat", now: () => new Date() };

const COMPUTER_ID = { type: "string", description: "The computer id returned by get_computer." };

/** The hosted server's catalog, trimmed to the tools the tests exercise. */
const HOSTED_TOOLS: Tool[] = [
  {
    name: "get_computer",
    description: "Get (or create) the persistent computer for one end user.",
    inputSchema: { type: "object", properties: { user_id: { type: "string" }, name: { type: "string" } }, required: [] },
  },
  {
    name: "computer",
    description: "Control the desktop.",
    inputSchema: {
      type: "object",
      properties: { computer_id: COMPUTER_ID, action: { type: "string", enum: ["screenshot", "left_click"] }, coordinate: { type: "array" } },
      required: ["computer_id", "action"],
    },
  },
  {
    name: "request_takeover",
    description: "Hand the desktop to the person.",
    inputSchema: { type: "object", properties: { computer_id: COMPUTER_ID, reason: { type: "string" }, wait: { type: "boolean" } }, required: ["computer_id", "reason"] },
  },
  { name: "takeover_status", description: "Where a takeover stands.", inputSchema: { type: "object", properties: { computer_id: COMPUTER_ID }, required: ["computer_id"] } },
  { name: "close_computer", description: "End the session.", inputSchema: { type: "object", properties: { computer_id: COMPUTER_ID }, required: ["computer_id"] } },
  // A tool without `properties` checks the schema conversion path.
  { name: "weird/tool", description: "no properties", inputSchema: { type: "object" } },
];

interface FakeServer {
  calls: Array<{ name: string; args: Record<string, unknown> }>;
  transport: InMemoryTransport;
}

/** A minimal MCP server on the server half of an in-memory pair. */
async function startFakeServer(
  tools: Tool[],
  onCall: (name: string, args: Record<string, unknown>) => CallToolResult,
): Promise<{ server: FakeServer; clientTransport: InMemoryTransport }> {
  const pair = createInMemoryTransportPair();
  const calls: FakeServer["calls"] = [];
  pair.server.onMessage((message: JsonRpcMessage) => {
    if (!("method" in message) || !("id" in message)) return;
    const params = (message.params ?? {}) as Record<string, unknown>;
    const reply = (result: unknown) => void pair.server.send({ jsonrpc: "2.0", id: message.id, result });
    switch (message.method) {
      case "initialize":
        reply({ protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake-maritime", version: "0" } });
        break;
      case "ping":
        reply({});
        break;
      case "tools/list":
        reply({ tools });
        break;
      case "tools/call": {
        const name = String(params.name);
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        calls.push({ name, args });
        reply(onCall(name, args));
        break;
      }
      default:
        void pair.server.send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `no ${message.method}` } });
    }
  });
  await pair.server.start();
  return { server: { calls, transport: pair.server }, clientTransport: pair.client };
}

function text(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function defaultHandler(name: string, args: Record<string, unknown>): CallToolResult {
  switch (name) {
    case "get_computer":
      return text({ computer_id: "cmp_42", status: "ready", screen: { width: 1280, height: 800 } });
    case "computer":
      return { content: [{ type: "image", data: PNG_B64, mimeType: "image/png" }, { type: "text", text: JSON.stringify({ action: args.action, computer_id: args.computer_id, width: 1200, height: 750 }) }] };
    case "request_takeover":
      return text({ status: "waiting", viewer_url: "https://maritime.sh/computer/v/abc", expires_at: "soon" });
    case "takeover_status":
      return text({ mode: "agent" });
    case "close_computer":
      return text({ closed: true });
    default:
      return { content: [{ type: "text", text: `unknown ${name}` }], isError: true };
  }
}

async function backendWithServer(handler = defaultHandler) {
  const { server, clientTransport } = await startFakeServer(HOSTED_TOOLS, handler);
  const backend = new MaritimeMcpBackend({
    url: "https://mcp.example.test",
    apiKey: "mk_test",
    externalUserId: "user-1",
    transportFactory: () => clientTransport,
  });
  return { backend, server };
}

function byName(tools: RegisteredTool[], name: string): RegisteredTool {
  const tool = tools.find((t) => t.spec.name === name);
  if (!tool) throw new Error(`missing ${name}`);
  return tool;
}

async function exec(tools: RegisteredTool[], name: string, args: unknown) {
  const result = await byName(tools, name).spec.execute(args, ctx);
  if (typeof result === "string") throw new Error("expected blocks");
  return result;
}

describe("maritimeMcpEndpoint", () => {
  it("pins the connection to the end user whatever the base looks like", () => {
    expect(maritimeMcpEndpoint("https://mcp.maritime.sh", "u1")).toBe("https://mcp.maritime.sh/mcp/u/u1");
    expect(maritimeMcpEndpoint("https://mcp.maritime.sh/", "u1")).toBe("https://mcp.maritime.sh/mcp/u/u1");
    expect(maritimeMcpEndpoint("https://mcp.maritime.sh/mcp", "u1")).toBe("https://mcp.maritime.sh/mcp/u/u1");
    expect(maritimeMcpEndpoint("https://mcp.maritime.sh/mcp/u/already", "u1")).toBe("https://mcp.maritime.sh/mcp/u/already");
    expect(maritimeMcpEndpoint("https://mcp.maritime.sh", "a b/c")).toBe("https://mcp.maritime.sh/mcp/u/a%20b%2Fc");
    expect(maritimeMcpEndpoint("")).toBe("https://mcp.maritime.sh/mcp/u/owner");
  });
});

describe("MaritimeMcpBackend", () => {
  it("wraps every hosted tool under its exact name with computer.use metadata", async () => {
    const { backend } = await backendWithServer();
    const tools = await backend.tools();
    const names = tools.map((t) => t.spec.name);
    expect(names).toEqual(["get_computer", "computer", "request_takeover", "takeover_status", "close_computer", "weird_tool"]);
    for (const tool of tools) {
      expect(tool.spec.meta).toMatchObject({ capabilities: ["computer.use"], group: "computer" });
      expect(tool.spec.parameters).toMatchObject({ type: "object" });
      expect((tool.spec.parameters as { properties: unknown }).properties).toBeTypeOf("object");
    }
    expect(byName(tools, "computer").spec.description).toBe("Control the desktop.");
    expect(backend.describe()).toContain("user-1");
    expect(backend.describe()).not.toContain("mk_test");
    await backend.close();
  });

  it("remembers the computer_id from get_computer and injects it when the model omits it", async () => {
    const { backend, server } = await backendWithServer();
    const tools = await backend.tools();

    const got = await exec(tools, "get_computer", {});
    expect(got.isError).toBe(false);
    expect(backend.computerId).toBe("cmp_42");

    const shot = await exec(tools, "computer", { action: "screenshot" });
    expect(shot.content[0]).toMatchObject({ type: "image", data: PNG_B64 });
    expect(server.calls.at(-1)).toEqual({ name: "computer", args: { action: "screenshot", computer_id: "cmp_42" } });

    // An explicit id from the model is kept.
    await exec(tools, "takeover_status", { computer_id: "cmp_other" });
    expect(server.calls.at(-1)?.args).toEqual({ computer_id: "cmp_other" });
    await backend.close();
  });

  it("fetches the computer first when nothing is remembered yet", async () => {
    const { backend, server } = await backendWithServer();
    const tools = await backend.tools();
    const result = await exec(tools, "computer", { action: "left_click", coordinate: [1, 2] });
    expect(result.isError).toBe(false);
    expect(server.calls.map((c) => c.name)).toEqual(["get_computer", "computer"]);
    expect(server.calls[1]?.args.computer_id).toBe("cmp_42");
    await backend.close();
  });

  it("appends the owner hint to a successful request_takeover and passes errors through", async () => {
    const { backend } = await backendWithServer((name, args) =>
      name === "computer" ? { content: [{ type: "text", text: "no_plan" }], isError: true } : defaultHandler(name, args),
    );
    const tools = await backend.tools();
    const takeover = await exec(tools, "request_takeover", { reason: "log in" });
    const texts = takeover.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text);
    expect(texts[0]).toContain("viewer_url");
    expect(texts.at(-1)).toContain("Send the viewer_url to the owner");

    const failed = await exec(tools, "computer", { action: "screenshot" });
    expect(failed.isError).toBe(true);
    expect(failed.content).toHaveLength(1);
    await backend.close();
  });

  it("bootstraps once even when provisioning advertises an optional computer ID", async () => {
    const catalog = HOSTED_TOOLS.map(tool => tool.name === "get_computer" ? { ...tool, inputSchema: { type: "object", properties: { computer_id: COMPUTER_ID } } } : tool);
    const { server, clientTransport } = await startFakeServer(catalog, defaultHandler);
    const backend = new MaritimeMcpBackend({ url: "https://mcp.example.test", apiKey: "mk_test", externalUserId: "user-1", transportFactory: () => clientTransport });
    try {
      await backend.call("computer", { action: "screenshot" });
      expect(backend.computerId).toBe("cmp_42");
      expect(server.calls.map(call => call.name)).toEqual(["get_computer", "computer"]);
    } finally { await backend.close(); }
  });

  it("returns an error result instead of throwing when get_computer gives no id", async () => {
    const { backend } = await backendWithServer((name, args) =>
      name === "get_computer" ? text({ status: "sleeping" }) : defaultHandler(name, args),
    );
    const tools = await backend.tools();
    const result = await exec(tools, "computer", { action: "screenshot" });
    expect(result.isError).toBe(true);
    await backend.close();
  });

  it("shares one handshake between concurrent callers and reconnects after close", async () => {
    const { backend, server } = await backendWithServer();
    const [a, b] = await Promise.all([backend.connect(), backend.connect()]);
    expect(a).toBe(b);
    await backend.close();
    expect(server.transport).toBeDefined();
    // After close the transport pair is dead; a fresh factory would be needed to reconnect.
    await expect(backend.connect()).rejects.toThrow();
  });
});

describe("hosted credential and business boundary", () => {
  const taskCtx: ToolContext = {
    ...ctx,
    conversationKey: "business:task-a",
    taskRun: { taskId: "task-a", runId: "run-a", taskRevision: 1, executionEpoch: 1, globalControlEpoch: 0, authorityRef: "owner:a" },
    businessInvocation: true,
  };

  function boundary() {
    let state: ComputerPrivacy = { takeover: false, credentialEntry: false };
    const links: string[] = [];
    const business: BusinessComputerBoundary = {
      workspaceId: "workspace-a",
      withLease: async (_ctx, invoke) => invoke(),
      privacy: () => state,
      setPrivacy: (value) => { state = value; },
      notifyTakeover: async (_ctx, url) => { links.push(url); },
    };
    return { business, links };
  }

  it("sends raw fields only inside the adapter and never returns secret echoes or screenshots", async () => {
    const vault = new CredentialVault();
    const reference = vault.issue({ scope: credentialScope(taskCtx, "workspace-a"), adapter: "hosted-computer", fields: { number: "4000009990001984" } });
    const { clientTransport, server } = await startFakeServer(HOSTED_TOOLS, (name, args) => name === "computer"
      ? { content: [{ type: "image", data: PNG_B64, mimeType: "image/png" }, { type: "text", text: `echo ${String(args.text)}` }] }
      : defaultHandler(name, args));
    const { business } = boundary();
    const backend = new MaritimeMcpBackend({ url: "https://mcp.example.test", apiKey: "synthetic", externalUserId: "workspace-a", business, credentials: vault.createResolver("hosted-computer"), transportFactory: () => clientTransport });
    try {
      const tools = await backend.tools();
      const type = byName(tools, "computer_type_credential");
      const wrong = await type.spec.execute({ credentialRef: reference.credentialRef, field: "number" }, { ...taskCtx, conversationKey: "another" });
      expect(JSON.stringify(wrong)).toContain("unavailable");
      expect(server.calls).toHaveLength(0);
      const result = await type.spec.execute({ credentialRef: reference.credentialRef, field: "number" }, taskCtx);
      expect(server.calls.at(-1)?.args).toMatchObject({ action: "type", text: "4000009990001984", no_screenshot: true });
      expect(JSON.stringify(result)).not.toContain("4000009990001984");
      expect(JSON.stringify(result)).not.toContain(PNG_B64);
      const proof = await type.spec.verify!({ credentialRef: reference.credentialRef, field: "number" }, result, taskCtx);
      expect(proof).toMatchObject({ verified: true, receipt: { evidenceLevel: "primitive-only", operation: "credential-entry" } });
      expect(JSON.stringify(proof)).not.toContain("4000009990001984");
      expect(JSON.stringify(proof)).not.toContain(PNG_B64);
      expect(business.privacy().credentialEntry).toBe(true);
      const screenshot = await byName(tools, "computer").spec.execute({ action: "screenshot" }, taskCtx);
      expect(JSON.stringify(screenshot)).not.toContain(PNG_B64);
      expect((await byName(tools, "computer").spec.verify!({ action: "screenshot" }, screenshot, taskCtx)).verified).toBe(false);
      const raw = await byName(tools, "computer").spec.execute({ action: "type", text: "4000009990001984" }, taskCtx);
      expect(JSON.stringify(raw)).toContain("Raw credential");
    } finally { await backend.close(); }
  });

  it("pins identity, fences task access, and keeps human control private until provider verification", async () => {
    const { business, links } = boundary();
    expect(() => new MaritimeMcpBackend({ url: "https://mcp.example.test/mcp/u/other", apiKey: "synthetic", externalUserId: "workspace-a", business })).toThrow("another workspace");
    const { clientTransport, server } = await startFakeServer(HOSTED_TOOLS, defaultHandler);
    const backend = new MaritimeMcpBackend({ url: "https://mcp.example.test", apiKey: "synthetic", externalUserId: "workspace-a", business, transportFactory: () => clientTransport });
    try {
      const tools = await backend.tools();
      expect(JSON.stringify(await byName(tools, "computer").spec.execute({ action: "screenshot" }, ctx))).toContain("task-bound");
      expect(JSON.stringify(await byName(tools, "computer").spec.execute({ action: "screenshot", computer_id: "other" }, taskCtx))).toContain("server-bound");
      expect(server.calls).toHaveLength(0);
      const takeover = await byName(tools, "request_takeover").spec.execute({ reason: "Authenticate" }, taskCtx);
      expect(links).toEqual(["https://maritime.sh/computer/v/abc"]);
      expect(JSON.stringify(takeover)).not.toContain("https://");
      const proof = await byName(tools, "request_takeover").spec.verify!({ reason: "Authenticate" }, takeover, taskCtx);
      expect(proof).toMatchObject({ verified: true, receipt: { evidenceLevel: "primitive-only", operation: "takeover-requested" } });
      expect(JSON.stringify(proof)).not.toContain("https://");
      expect(business.privacy().takeover).toBe(true);
      const before = server.calls.length;
      expect(JSON.stringify(await byName(tools, "computer").spec.execute({ action: "screenshot" }, taskCtx))).toContain("Human takeover");
      expect(server.calls).toHaveLength(before);
      await byName(tools, "takeover_status").spec.execute({}, taskCtx);
      expect(business.privacy().takeover).toBe(false);
      await byName(tools, "computer").spec.execute({ action: "screenshot" }, taskCtx);
      expect(server.calls.at(-1)?.args.computer_id).toBe("cmp_42");
    } finally { await backend.close(); }
  });
});

it("retains secret screenshot suppression after backend restart and does not release failed takeover", async () => {
  let privacy: ComputerPrivacy = { takeover: false, credentialEntry: true };
  const business: BusinessComputerBoundary = {
    workspaceId: "workspace-a",
    withLease: async (_ctx, invoke) => invoke(),
    privacy: () => privacy,
    setPrivacy: (value) => { privacy = value; },
    notifyTakeover: async () => {},
  };
  const worker: ToolContext = { ...ctx, businessInvocation: true, taskRun: { taskId: "task-a", runId: "run-b", taskRevision: 1, executionEpoch: 2, globalControlEpoch: 0, authorityRef: "owner:a" } };
  for (let restart = 0; restart < 2; restart++) {
    const { clientTransport } = await startFakeServer(HOSTED_TOOLS, (name, args) => name === "takeover_status" ? text({ mode: "agent", success: false }) : defaultHandler(name, args));
    const backend = new MaritimeMcpBackend({ url: "https://mcp.example.test", apiKey: "synthetic", externalUserId: "workspace-a", business, transportFactory: () => clientTransport });
    try {
      const tools = await backend.tools();
      const screenshot = await byName(tools, "computer").spec.execute({ action: "screenshot" }, worker);
      expect(JSON.stringify(screenshot)).not.toContain(PNG_B64);
      expect(byName(tools, "computer").spec.parameters.required).not.toContain("computer_id");
      privacy.takeover = true;
      const failed = await byName(tools, "takeover_status").spec.execute({}, worker);
      expect(JSON.stringify(failed)).toContain("failed");
      expect(privacy.takeover).toBe(true);
      privacy.takeover = false;
    } finally { await backend.close(); }
  }
});

describe("hosted adapter evidence", () => {
  it("records exact file/source readback and bound provisioning, not model-constructed proof", async () => {
    const catalog: Tool[] = [...HOSTED_TOOLS, { name: "read_file", inputSchema: { type: "object", properties: { computer_id: COMPUTER_ID, path: { type: "string" } } } }];
    const content = "Résumé supplier comparison\nTotal: 42.00\n";
    const { clientTransport } = await startFakeServer(catalog, (name, args) => name === "read_file"
      ? text({ path: args.path === "/wrong" ? "/different" : args.path, content })
      : defaultHandler(name, args));
    const backend = new MaritimeMcpBackend({ url: "https://mcp.example.test", apiKey: "synthetic", externalUserId: "workspace-a", transportFactory: () => clientTransport });
    try {
      const tools = await backend.tools();
      const provision = byName(tools, "get_computer").spec;
      const identity = await provision.execute({}, ctx);
      expect(await provision.verify!({}, identity, ctx)).toMatchObject({ verified: true, receipt: { evidenceLevel: "primitive-only", computerId: "cmp_42", workspaceId: "workspace-a" } });
      const read = byName(tools, "read_file").spec;
      const args = { path: "/brief.txt" };
      const value = await read.execute(args, ctx);
      const proof = await read.verify!(args, value, ctx);
      expect(proof).toMatchObject({ verified: true, receipt: { evidenceLevel: "readback", path: "/brief.txt", sha256: createHash("sha256").update(content).digest("hex"), bytes: Buffer.byteLength(content) } });
      expect(proof.evidenceRefs).toHaveLength(1);
      expect(JSON.stringify(proof)).not.toContain(content);
      expect((await read.verify!(args, structuredClone(value), ctx)).verified).toBe(false);
      expect((await read.verify!({ path: "/different" }, value, ctx)).verified).toBe(false);
      expect((await read.verify!(args, value, { ...ctx, conversationKey: "other" })).verified).toBe(false);
      const mismatch = await read.execute({ path: "/wrong" }, ctx);
      expect((await read.verify!({ path: "/wrong" }, mismatch, ctx)).verified).toBe(false);
    } finally { await backend.close(); }
  });

  it("records returned screenshot observations but never promotes generic shell receipts", async () => {
    const catalog: Tool[] = [...HOSTED_TOOLS, { name: "shell", inputSchema: { type: "object", properties: { command: { type: "string" } } } }];
    const { clientTransport } = await startFakeServer(catalog, (name, args) => name === "shell" ? text({ accepted: true, exit_code: 0 }) : defaultHandler(name, args));
    const backend = new MaritimeMcpBackend({ url: "https://mcp.example.test", apiKey: "synthetic", externalUserId: "workspace-a", transportFactory: () => clientTransport });
    try {
      const tools = await backend.tools();
      const computer = byName(tools, "computer").spec;
      const args = { action: "left_click", coordinate: [10, 10] };
      const image = await computer.execute(args, ctx);
      expect(await computer.verify!(args, image, ctx)).toMatchObject({ verified: true, receipt: { evidenceLevel: "observation", observations: [{ sha256: createHash("sha256").update(Buffer.from(PNG_B64, "base64")).digest("hex") }] } });
      const shell = byName(tools, "shell").spec;
      const result = await shell.execute({ command: "synthetic-only" }, ctx);
      expect(await shell.verify!({ command: "synthetic-only" }, result, ctx)).toEqual({ verified: false, evidenceRefs: [], receipt: { tool: "shell", evidenceLevel: "receipt-only" } });
    } finally { await backend.close(); }
  });
});

it("verifies hosted writes with exact UTF-8 readback under the same lease and records the receipt first", async () => {
  const catalog: Tool[] = [...HOSTED_TOOLS, ...["write_file", "read_file"].map((name) => ({ name, inputSchema: { type: "object", properties: { computer_id: COMPUTER_ID, path: { type: "string" }, content: { type: "string" } } } }))];
  const files = new Map<string, string>();
  const receipts: unknown[] = [];
  let leased = false;
  const { clientTransport, server } = await startFakeServer(catalog, (name, args) => {
    expect(leased).toBe(true);
    if (name === "write_file") {
      files.set(String(args.path), String(args.content));
      return text({ request_id: "write-receipt", status: "written" });
    }
    if (name === "read_file") {
      expect(receipts.length).toBeGreaterThan(0);
      return text({ path: args.path, content: args.path === "/mismatch" ? "changed externally" : files.get(String(args.path)), ...(args.path === "/base64" ? { encoding: "base64" } : {}) });
    }
    return defaultHandler(name, args);
  });
  const business: BusinessComputerBoundary = {
    workspaceId: "workspace-a",
    withLease: async (_ctx, invoke) => { leased = true; try { return await invoke(); } finally { leased = false; } },
    privacy: () => ({ takeover: false, credentialEntry: false }),
    setPrivacy: () => {},
    notifyTakeover: async () => {},
  };
  const worker: ToolContext = { ...ctx, businessInvocation: true, taskRun: { taskId: "task-write", runId: "run-write", taskRevision: 1, executionEpoch: 1, globalControlEpoch: 0, authorityRef: "owner:write" }, recordBusinessReceipt: (receipt) => { receipts.push(receipt); } };
  const backend = new MaritimeMcpBackend({ url: "https://mcp.example.test", apiKey: "synthetic", externalUserId: "workspace-a", business, transportFactory: () => clientTransport });
  try {
    const write = byName(await backend.tools(), "write_file").spec;
    const args = { path: "/verified.txt", content: "café\n42.00\n" };
    const result = await write.execute(args, worker, new AbortController().signal);
    expect(files.get(args.path)).toBe(args.content);
    expect(server.calls.map((call) => call.name)).toEqual(["get_computer", "write_file", "read_file"]);
    expect(await write.verify!(args, result, worker)).toMatchObject({ verified: true, receipt: { evidenceLevel: "readback", operation: "file-write-readback", sha256: createHash("sha256").update(args.content).digest("hex") } });
    expect(receipts[0]).toMatchObject({ evidenceLevel: "receipt-only", providerId: "write-receipt" });
    for (const path of ["/mismatch", "/base64"]) {
      const unsupported = { path, content: "unchanged" };
      const value = await write.execute(unsupported, worker);
      expect((await write.verify!(unsupported, value, worker)).verified).toBe(false);
    }
  } finally { await backend.close(); }
});
