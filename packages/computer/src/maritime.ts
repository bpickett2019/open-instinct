/**
 * Hosted desktop through the Maritime Computers MCP server.
 *
 * Used when the agent runs outside a Maritime desktop VM (self-hosted, local dev, or a VM
 * created without `desktop: true`). Maritime keeps one persistent Linux desktop per end user
 * behind `https://mcp.maritime.sh/mcp/u/{externalUserId}`; the connection is pinned to that
 * user so `get_computer` needs no `user_id`. Tools are registered under the exact names the
 * server uses, so a prompt written for the hosted product works unchanged.
 */
import {
  McpClient,
  StreamableHttpTransport,
  type CallToolResult,
  type McpTransport,
  type Tool,
} from "@earendil-works/pi-mcp";
import type { CredentialResolver, Json, RegisteredTool, ToolContext, ToolMeta, ToolResultLike } from "@open-instinct/core";
import { errorResult, findStringField, isRecord, mcpResultToToolResult } from "./result.js";
import { mcpSchemaToTypeBox, sanitizeToolName, schemaHasProperty } from "./schema.js";
import { credentialScope, defineTool, jsonValue, redactSensitive, textResult } from "@open-instinct/core";
import { Type } from "typebox";
import type { ComputerBackend, Logger } from "./types.js";
import { createHash } from "node:crypto";

export const DEFAULT_MARITIME_MCP_URL = "https://mcp.maritime.sh";
/** `get_computer` can take 60 s on first use while the desktop is created; waking takes a few seconds. */
export const MARITIME_REQUEST_TIMEOUT_MS = 180_000;
/** Pinned connections default to this end user id when the deployment gives none. */
export const DEFAULT_EXTERNAL_USER_ID = "owner";

const META: ToolMeta = { capabilities: ["computer.use"], group: "computer" };

interface ComputerProof {
  receipt: Json;
  evidenceRefs: string[];
  verified: boolean;
}

interface BoundComputerProof {
  tool: string;
  argumentsHash: string;
  conversationKey: string;
  taskId?: string;
  runId?: string;
  proof: ComputerProof;
}

/**
 * Build the pinned endpoint from a base URL. Accepts a bare origin, a URL ending in `/mcp`,
 * or an already pinned URL (used as is).
 */
export function maritimeMcpEndpoint(base: string, externalUserId: string = DEFAULT_EXTERNAL_USER_ID): string {
  const trimmed = (base || DEFAULT_MARITIME_MCP_URL).replace(/\/+$/, "");
  if (/\/mcp\/u\/[^/]+$/.test(trimmed)) return trimmed;
  const root = trimmed.endsWith("/mcp") ? trimmed.slice(0, -"/mcp".length) : trimmed;
  return `${root}/mcp/u/${encodeURIComponent(externalUserId)}`;
}

export interface ComputerPrivacy {
  takeover: boolean;
  credentialEntry: boolean;
}

export interface BusinessComputerBoundary {
  workspaceId: string;
  withLease<T>(ctx: ToolContext, invoke: () => Promise<T>): Promise<T>;
  privacy(): ComputerPrivacy;
  setPrivacy(value: ComputerPrivacy): void;
  notifyTakeover(ctx: ToolContext, viewerUrl: string): Promise<void>;
}

export interface MaritimeMcpBackendOptions {
  /** Base URL (`https://mcp.maritime.sh`) or a full pinned endpoint. */
  url: string;
  /** Maritime API key with the `computers` scope. Sent as a Bearer header, never logged. */
  apiKey: string;
  externalUserId?: string;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  logger?: Logger;
  /** Test seam: supply the client-side transport instead of Streamable HTTP. */
  transportFactory?: () => McpTransport;
  credentials?: CredentialResolver;
  business?: BusinessComputerBoundary;
}

export class MaritimeMcpBackend implements ComputerBackend {
  readonly kind = "maritime" as const;
  readonly endpoint: string;
  readonly externalUserId: string;
  /** The computer id learned from `get_computer`, injected into later calls when the model omits it. */
  computerId: string | undefined;

  private readonly apiKey: string;
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly log: Logger;
  private readonly transportFactory: (() => McpTransport) | undefined;
  private client: McpClient | undefined;
  private connecting: Promise<McpClient> | undefined;
  private toolList: Tool[] | undefined;
  private readonly credentials: CredentialResolver | undefined;
  private readonly business: BusinessComputerBoundary | undefined;
  private credentialEntry = false;
  private readonly proofs = new WeakMap<object, BoundComputerProof>();

  constructor(opts: MaritimeMcpBackendOptions) {
    if (opts.business && opts.externalUserId !== opts.business.workspaceId) throw new Error("Business computer must bind its workspace identity");
    if (opts.business && /\/mcp\/u\/[^/]+\/?$/.test(opts.url) && decodeURIComponent(new URL(opts.url).pathname.split("/").filter(Boolean).at(-1)!) !== opts.business.workspaceId) throw new Error("Pinned computer endpoint belongs to another workspace");
    this.credentials = opts.credentials;
    this.business = opts.business;
    this.externalUserId = opts.externalUserId ?? DEFAULT_EXTERNAL_USER_ID;
    this.endpoint = maritimeMcpEndpoint(opts.url, this.externalUserId);
    this.apiKey = opts.apiKey;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? MARITIME_REQUEST_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl;
    this.log = opts.logger ?? (() => {});
    this.transportFactory = opts.transportFactory;
  }

  describe(): string {
    return `Maritime hosted computer for end user "${this.externalUserId}" (${this.endpoint})`;
  }

  /** Connect once; concurrent callers share the same handshake. */
  connect(): Promise<McpClient> {
    if (this.client) return Promise.resolve(this.client);
    if (!this.connecting) {
      this.connecting = this.openClient().then(
        (client) => {
          this.client = client;
          return client;
        },
        (err) => {
          this.connecting = undefined;
          throw err;
        },
      );
    }
    return this.connecting;
  }

  private async openClient(): Promise<McpClient> {
    const client = new McpClient({
      name: "open-instinct",
      version: "0.1.0",
      requestTimeoutMs: this.requestTimeoutMs,
    });
    client.onClose(() => {
      // Let the next call reconnect instead of failing on a dead session.
      if (this.client === client) {
        this.client = undefined;
        this.connecting = undefined;
      }
    });
    const transport =
      this.transportFactory?.() ??
      new StreamableHttpTransport({
        url: this.endpoint,
        headers: { Authorization: `Bearer ${this.apiKey}` },
        ...(this.fetchImpl ? { fetch: this.fetchImpl } : {}),
      });
    await client.connect(transport);
    this.log(`connected to Maritime Computers MCP (${client.serverInfo?.name ?? "server"})`);
    return client;
  }

  async listTools(): Promise<Tool[]> {
    if (this.toolList) return this.toolList;
    const client = await this.connect();
    this.toolList = await client.listTools({ timeoutMs: this.requestTimeoutMs });
    return this.toolList;
  }

  /**
   * Call a hosted tool. Fills in `computer_id` from memory (fetching it with `get_computer`
   * when nothing is remembered yet) and remembers the id `get_computer` returns.
   */
  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal, fence?: () => void): Promise<CallToolResult> {
    const client = await this.connect();
    const tool = (await this.listTools()).find((t) => t.name === name);
    const params = { ...args };
    if (name !== "get_computer" && tool && schemaHasProperty(tool.inputSchema, "computer_id") && typeof params.computer_id !== "string") {
      params.computer_id = await this.ensureComputerId(signal, fence);
    }
    signal?.throwIfAborted(); fence?.();
    const result = await client.callTool(name, params, { signal, timeoutMs: this.requestTimeoutMs });
    if (name === "get_computer" && result.isError !== true) {
      const id = findStringField(result, "computer_id");
      if (id) this.computerId = id;
    }
    return result;
  }

  private async ensureComputerId(signal?: AbortSignal, fence?: () => void): Promise<string> {
    if (this.computerId) return this.computerId;
    const result = await this.call("get_computer", {}, signal, fence);
    if (!this.computerId) {
      throw new Error("get_computer did not return a computer_id; the Maritime key may lack the computers scope");
    }
    void result;
    return this.computerId;
  }

  async tools(): Promise<RegisteredTool[]> {
    const tools = await this.listTools();
    const registered = tools.map((tool) => this.wrap(tool));
    if (this.credentials && tools.some((tool) => tool.name === "computer")) registered.push(this.credentialTool());
    return registered;
  }

  private wrap(tool: Tool): RegisteredTool {
    const name = sanitizeToolName(tool.name);
    const hint = TOOL_HINTS[tool.name];
    const schema = structuredClone(tool.inputSchema);
    if (this.business && isRecord(schema.properties)) {
      for (const key of ["computer_id", "user_id", "external_user_id"]) delete schema.properties[key];
      if (Array.isArray(schema.required)) schema.required = schema.required.filter((key) => !["computer_id", "user_id", "external_user_id"].includes(key));
    }
    return defineTool({
      name,
      label: tool.title ?? tool.name,
      description: tool.description ?? tool.name,
      parameters: mcpSchemaToTypeBox(schema),
      meta: { ...META, describe: (args) => describeCall(tool.name, args) },
      prepareBusiness: async args => { jsonValue(args); return { args, resolvedTool: name, resolvedMeta: { ...META, effect: ["read_file", "takeover_status"].includes(tool.name) || tool.name === "computer" && isRecord(args) && args.action === "screenshot" ? "read" : "write" } }; },
      verify: async (args, value, ctx) => this.proofFor(tool.name, args, value, ctx),
      execute: async (args, ctx, signal): Promise<ToolResultLike> => {
        const invoke = async (): Promise<ToolResultLike> => {
          const privacy = this.business?.privacy();
          if (privacy?.takeover && tool.name !== "takeover_status") return errorResult("Human takeover is active. Only takeover_status is available.");
          const params = isRecord(args) ? args : {};
          if (this.business && ("computer_id" in params || "user_id" in params || "external_user_id" in params)) return errorResult("Computer identity is server-bound; omit identity arguments.");
          if (this.credentials && JSON.stringify(this.credentials.redact(params)) !== JSON.stringify(params)) return errorResult("Raw credential values are forbidden. Use computer_type_credential or owner takeover.");
          if (tool.name === "request_takeover" && this.business) this.business.setPrivacy({ takeover: true, credentialEntry: true });
          try {
            const result = await this.call(tool.name, params, signal, ctx.assertBusinessDispatch);
            if (this.business && tool.name === "request_takeover") {
              const failed = result.isError || takeoverFailed(result);
              const url = findStringField(result, "viewer_url");
              if (url && !failed) await this.business.notifyTakeover(ctx, url);
              const value = failed
                ? errorResult("Provider takeover request failed. Stop and resolve the provider blocker; no automatic retry.")
                : textResult("Provider takeover requested. The owner receives the private viewer link separately. Wait for provider verification with takeover_status.");
              return !failed && (url || findStringField(result, "status") === "waiting" || findStringField(result, "mode") === "human")
                ? this.rememberProof(value, ctx, tool.name, params, { evidenceLevel: "primitive-only", operation: "takeover-requested" })
                : value;
            }
            if (this.business && tool.name === "takeover_status") {
              const mode = findStringField(result, "mode");
              const failed = takeoverFailed(result);
              if (mode === "agent" && !result.isError && !failed) this.business.setPrivacy({ ...this.business.privacy(), takeover: false });
              const value = result.isError || failed ? errorResult("Provider takeover failed; do not repeat this step.") : textResult(`Provider takeover mode: ${mode ?? "unknown"}.`);
              return !result.isError && !failed && (mode === "agent" || mode === "human")
                ? this.rememberProof(value, ctx, tool.name, params, { evidenceLevel: "primitive-only", operation: "takeover-status", mode })
                : value;
            }
            if (this.credentialEntry || this.business?.privacy().credentialEntry) {
              const value = result.isError ? errorResult("Computer action failed in a credential-sensitive session; details and screenshots withheld.") : textResult("Computer action returned in a credential-sensitive session. Screenshots and provider echoes withheld; this is not verified outcome evidence.");
              const id = tool.name === "get_computer" ? findStringField(result, "computer_id") : undefined;
              return !result.isError && id && id === this.computerId
                ? this.rememberProof(value, ctx, tool.name, params, { evidenceLevel: "primitive-only", operation: "provision-readback" })
                : value;
            }
            const value = mcpResultToToolResult(result, result.isError ? undefined : hint);
            const safe = this.credentials ? this.credentials.redact(value) : this.business ? redactSensitive(value) : value;
            if (result.isError || (tool.name !== "read_file" && tool.name !== "write_file" && takeoverFailed(result))) return safe;
            if (tool.name === "get_computer") {
              const id = findStringField(result, "computer_id");
              if (id && id === this.computerId) return this.rememberProof(safe, ctx, tool.name, params, { evidenceLevel: "primitive-only", operation: "provision-readback" });
            }
            if (tool.name === "write_file" && typeof params.path === "string" && typeof params.content === "string" && params.encoding === undefined && (await this.listTools()).some((candidate) => candidate.name === "read_file")) {
              const providerId = findStringField(result, "request_id") ?? findStringField(result, "operation_id");
              ctx.recordBusinessReceipt?.({ tool: "write_file", evidenceLevel: "receipt-only", providerReturned: true, workspaceId: this.externalUserId, path: params.path, ...(this.computerId ? { computerId: this.computerId } : {}), ...(providerId ? { providerId } : {}) });
              const readback = await this.call("read_file", { path: params.path }, signal);
              const content = findStringField(readback, "content");
              const returnedPath = findStringField(readback, "path");
              const encoding = findStringField(readback, "encoding");
              if (!readback.isError && content === params.content && (returnedPath === undefined || returnedPath === params.path) && (encoding === undefined || encoding === "utf8" || encoding === "utf-8")) {
                return this.rememberProof(safe, ctx, tool.name, params, { evidenceLevel: "readback", operation: "file-write-readback", path: params.path, sha256: createHash("sha256").update(content, "utf8").digest("hex"), bytes: Buffer.byteLength(content, "utf8") });
              }
              return textResult("File write returned, but exact UTF-8 readback did not verify the requested bytes. Reconcile before repeating the write.");
            }
            if (tool.name === "read_file" && typeof params.path === "string") {
              const content = findStringField(result, "content");
              const returnedPath = findStringField(result, "path");
              const encoding = findStringField(result, "encoding");
              if (content !== undefined && (returnedPath === undefined || returnedPath === params.path) && (encoding === undefined || encoding === "utf8" || encoding === "utf-8")) {
                return this.rememberProof(safe, ctx, tool.name, params, { evidenceLevel: "readback", operation: "file-read", path: params.path, sha256: createHash("sha256").update(content, "utf8").digest("hex"), bytes: Buffer.byteLength(content, "utf8") });
              }
            }
            if (tool.name === "computer" && typeof value !== "string") {
              const images = value.content.filter((block) => block.type === "image");
              if (images.length && images.every((image) => image.type === "image" && /^(?:image\/png|image\/jpeg|image\/webp)$/.test(image.mimeType) && /^[A-Za-z0-9+/]+={0,2}$/.test(image.data))) {
                const observations = images.map((image) => {
                  const bytes = Buffer.from(image.data, "base64");
                  return { mimeType: image.mimeType, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
                });
                if (observations.every((image) => image.bytes > 0)) return this.rememberProof(safe, ctx, tool.name, params, { evidenceLevel: "observation", operation: "screen-readback", observations });
              }
            }
            return safe;
          } catch {
            // SDK errors can echo typed secrets or sensitive takeover URLs.
            if (this.business) throw new Error(`Maritime ${tool.name} outcome is unknown; reconcile before retrying. Provider details withheld.`);
            return errorResult(`Maritime computer call ${tool.name} failed. Provider details withheld.`);
          }
        };
        if (!this.business) return invoke();
        if (!ctx.taskRun || !ctx.businessInvocation || ctx.principal.kind !== "owner" || ctx.principal.tier !== "owner") return errorResult("Business computer actions require task-bound owner authority.");
        return this.business.withLease(ctx, invoke);
      },
    });
  }

  private credentialTool(): RegisteredTool {
    return defineTool({
      name: "computer_type_credential",
      label: "Type a credential reference",
      description: "Type one field from an opaque credential reference into the focused hosted-computer field. Never supply raw secrets. Screenshots and provider echoes are withheld after credential entry. Confirm the checkout origin and field focus before using this tool.",
      parameters: Type.Object({ credentialRef: Type.String(), field: Type.String() }),
      meta: { ...META, describe: () => "type credential reference" },
      verify: async (args, value, ctx) => this.proofFor("computer_type_credential", args, value, ctx),
      execute: async (args, ctx, signal) => {
        const invoke = async (): Promise<ToolResultLike> => {
          if (this.business?.privacy().takeover) return errorResult("Human takeover is active.");
          let text: string;
          try {
            text = this.credentials!.resolve(args.credentialRef, args.field, credentialScope(ctx, this.externalUserId));
          } catch {
            return errorResult("Credential entry unavailable for this scope. No secret details disclosed; use owner takeover.");
          }
          if (!this.business) this.credentialEntry = true;
          if (this.business) this.business.setPrivacy({ ...this.business.privacy(), credentialEntry: true });
          try {
            const result = await this.call("computer", { action: "type", text, no_screenshot: true }, signal, ctx.assertBusinessDispatch);
            const value = result.isError ? errorResult("Credential entry failed. Details withheld; do not blindly repeat.") : textResult("Credential field entered. Provider response and screenshot withheld. This does not prove purchase completion.");
            return !result.isError && !takeoverFailed(result)
              ? this.rememberProof(value, ctx, "computer_type_credential", args, { evidenceLevel: "primitive-only", operation: "credential-entry" })
              : value;
          } catch {
            if (this.business) throw new Error("Credential entry outcome is unknown; reconcile before retrying. Provider details withheld.");
            return errorResult("Credential entry outcome is uncertain. No secret details disclosed; use owner takeover.");
          }
        };
        if (!this.business) return invoke();
        if (!ctx.taskRun || !ctx.businessInvocation || ctx.principal.kind !== "owner" || ctx.principal.tier !== "owner") return errorResult("Credential entry requires task-bound owner authority.");
        return this.business.withLease(ctx, invoke);
      },
    });
  }

  private rememberProof(value: ToolResultLike, ctx: ToolContext, tool: string, args: unknown, detail: Record<string, Json>): ToolResultLike {
    if (typeof value === "string" || !this.computerId) return value;
    const receipt = { ...detail, workspaceId: this.externalUserId, computerId: this.computerId };
    const digest = createHash("sha256").update(JSON.stringify(receipt)).digest("hex");
    this.proofs.set(value, {
      tool,
      argumentsHash: createHash("sha256").update(JSON.stringify(args)).digest("hex"),
      conversationKey: ctx.conversationKey,
      ...(ctx.taskRun ? { taskId: ctx.taskRun.taskId, runId: ctx.taskRun.runId } : {}),
      proof: { receipt, evidenceRefs: [`computer:${this.externalUserId}:${digest}`], verified: true },
    });
    return value;
  }

  private proofFor(tool: string, args: unknown, value: ToolResultLike, ctx: ToolContext): ComputerProof {
    const bound = typeof value === "string" ? undefined : this.proofs.get(value);
    if (bound && bound.tool === tool && bound.conversationKey === ctx.conversationKey && bound.taskId === ctx.taskRun?.taskId && bound.runId === ctx.taskRun?.runId && bound.argumentsHash === createHash("sha256").update(JSON.stringify(args)).digest("hex")) return bound.proof;
    return { receipt: { tool, evidenceLevel: "receipt-only" }, evidenceRefs: [], verified: false };
  }

  async close(): Promise<void> {
    const client = this.client ?? (this.connecting ? await this.connecting.catch(() => undefined) : undefined);
    this.client = undefined;
    this.connecting = undefined;
    this.toolList = undefined;
    await client?.close();
  }
}

/** Short reminders appended to successful results where the model tends to stall. */
const TOOL_HINTS: Record<string, string> = {
  request_takeover:
    "Send the viewer_url to the owner in one short message on their channel and say what to do there. " +
    "Then poll takeover_status or retry your next action. If success is false, stop and tell the owner.",
};

function describeCall(name: string, args: unknown): string {
  if (!isRecord(args)) return name;
  if (name === "computer" && typeof args.action === "string") {
    const at = Array.isArray(args.coordinate) ? ` at ${args.coordinate.join(",")}` : "";
    return `${args.action}${at}`;
  }
  if (name === "computer_batch" && Array.isArray(args.actions)) return `batch of ${args.actions.length}`;
  if (name === "run_shell" && typeof args.command === "string") return `shell: ${args.command.slice(0, 60)}`;
  if ((name === "read_file" || name === "write_file") && typeof args.path === "string") return `${name} ${args.path}`;
  if (name === "request_takeover" && typeof args.reason === "string") return `takeover: ${args.reason}`;
  return name;
}

export function takeoverFailed(value: unknown): boolean {
  if (typeof value === "string") {
    try { return takeoverFailed(JSON.parse(value)); } catch { return false; }
  }
  if (Array.isArray(value)) return value.some(takeoverFailed);
  if (!isRecord(value)) return false;
  if (value.success === false || value.status === "failed") return true;
  return Object.values(value).some(takeoverFailed);
}
