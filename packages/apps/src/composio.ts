import type { RegisteredTool, StateDir } from "@open-instinct/core";
import { Composio } from "@composio/core";
import { McpClient, StreamableHttpTransport } from "@earendil-works/pi-mcp";
import { wrapMcpTools, type McpToolSource } from "./wrap.js";
import { GoogleProviderError, googleToolkit, type GoogleTransport } from "./google-transport.js";

interface ComposioRestResponse {
  items?: Array<{ id: string; toolkit: { slug: string }; user_id?: string; status: string; is_disabled?: boolean }>;
  next_cursor?: string | null; revoke_job_id?: string; session_id?: string;
  config?: { user_id: string; connected_accounts?: Record<string, string> };
  result_type?: string; status?: number; data?: unknown;
  success?: boolean;
}

/** File under the StateDir that remembers the Composio session for this owner. */
export const APPS_STATE_FILE = "apps.json";

/**
 * The toolkit list that means "every toolkit Composio has". `COMPOSIO_TOOLKITS=all`
 * (or `*`) normalizes to `["*"]`. The session is then created without an allowlist,
 * so COMPOSIO_SEARCH_TOOLS and COMPOSIO_MANAGE_CONNECTIONS can reach any app the
 * owner names at runtime.
 */
export const ALL_TOOLKITS = "*";

/**
 * How the Tool Router exposes tools over MCP.
 * `direct` lists every allowed app tool (GMAIL_SEND_EMAIL, ...) so the policy
 * guard can tag each one. `router` lists only the meta tools (search, multi
 * execute, manage connections), which all map to `apps.use` + `trust.manage`.
 * The all-toolkits list always runs as `router`: Composio cannot list every tool
 * of every app directly.
 */
export type ComposioSessionMode = "direct" | "router";

/**
 * OpenAI-style chat completions APIs reject a request that carries more tools than
 * this ("Invalid 'tools': array too long"). The Maritime LLM proxy is one of them.
 */
export const OPENAI_COMPLETIONS_TOOL_LIMIT = 128;

/**
 * The session mode for this agent. `COMPOSIO_MODE=direct|router` wins. Unset, it is
 * `router` for a model served through an OpenAI-style chat completions API (the
 * Maritime LLM proxy among them), because direct Gmail plus Calendar alone lists
 * about a hundred tools and the agent's own tools push the request past
 * OPENAI_COMPLETIONS_TOOL_LIMIT, so every reply would fail. Any other model gets
 * `direct`, which lets the guard tag each app action.
 */
export function composioModeFor(
  env: { COMPOSIO_MODE?: string | undefined },
  modelApi: string | undefined,
): { mode: ComposioSessionMode; reason: string } {
  const raw = env.COMPOSIO_MODE?.trim().toLowerCase();
  if (raw === "direct" || raw === "router") return { mode: raw, reason: "COMPOSIO_MODE" };
  const ignored = raw ? `COMPOSIO_MODE=${env.COMPOSIO_MODE?.trim()} is not direct or router; ` : "";
  if (modelApi === "openai-completions") {
    return { mode: "router", reason: `${ignored}the model's chat completions API accepts at most ${OPENAI_COMPLETIONS_TOOL_LIMIT} tools` };
  }
  return { mode: "direct", reason: `${ignored}default` };
}

/**
 * Toolkits Composio refused because the project has no auth config for them. A
 * project without, say, a Google Contacts auth config answers session create with a
 * 400 ("... require auth configs but none exist") that names the toolkits. Only
 * names from `requested` count, matched as whole words. Empty for any other error.
 */
export function toolkitsWithoutAuthConfig(err: unknown, requested: string[]): string[] {
  const status = (err as { status?: unknown } | null)?.status;
  if (status !== undefined && status !== 400) return [];
  const text = errorText(err).toLowerCase();
  if (!/auth[\s_-]*configs?\b/.test(text)) return [];
  return requested.filter((slug) => new RegExp(`(^|[^a-z0-9_])${escapeRegExp(slug)}($|[^a-z0-9_])`).test(text));
}

export interface ComposioAppsOptions {
  apiKey: string;
  /** Composio user id. One per owner; the Maritime externalId or Inkbox handle works well. */
  userId: string;
  /** Toolkit slugs, or `["all"]` / `["*"]` for every toolkit. */
  toolkits: string[];
  state: StateDir;
  logger?: (m: string) => void;
  /** Default `direct`. Ignored (treated as `router`) when toolkits is the all list. */
  mode?: ComposioSessionMode;
  /** Test seams. Production code leaves this out. */
  adapters?: {
    createComposio?: (apiKey: string) => ComposioClientLike;
    connectMcp?: (mcp: McpEndpoint) => Promise<McpToolSource>;
    fetchImpl?: typeof fetch;
  };
}

export interface McpEndpoint {
  url: string;
  headers?: Record<string, string>;
}

/** Shape of what we persist in apps.json. `toolkits` is `["*"]` in all mode. */
export interface AppsState {
  sessionId: string;
  userId: string;
  toolkits: string[];
  mode: ComposioSessionMode;
  createdAt: string;
}

export interface ToolkitStatus {
  slug: string;
  connected: boolean;
}

/** The parts of a Composio Tool Router session this package uses. */
export interface ComposioSessionLike {
  sessionId: string;
  mcp: McpEndpoint;
  authorize(toolkit: string): Promise<{ redirectUrl?: string | null }>;
  toolkits(options?: { toolkits?: string[]; isConnected?: boolean; limit?: number; cursor?: string }): Promise<{
    items: Array<{ slug: string; isNoAuth?: boolean; connection?: { isActive: boolean } }>;
    nextCursor?: string | null;
  }>;
}

export interface ComposioClientLike {
  sessions: {
    create(userId: string, config: SessionCreateConfig): Promise<ComposioSessionLike>;
    use(id: string, options: { mcp: true }): Promise<ComposioSessionLike>;
  };
}

/** Session create config. `toolkits` is left out in all mode: no allowlist means every toolkit. */
export interface SessionCreateConfig {
  toolkits?: string[];
  manageConnections: { enable: boolean };
  mcp: true;
  sessionPreset?: "direct_tools";
  connectedAccounts?: Record<string, string>;
  workbench?: { enable: boolean };
}

/** Pages of connected toolkits fetched in all mode before giving up. */
const MAX_CONNECTED_PAGES = 20;
/** Composio's connected-accounts endpoint rejects a limit above 50 with a 400. */
const CONNECTED_PAGE_SIZE = 50;

export class ComposioApps {
  private readonly opts: ComposioAppsOptions;
  private readonly composio: ComposioClientLike;
  private session?: ComposioSessionLike;
  private client?: McpToolSource;
  private connecting?: Promise<void>;
  private cachedTools?: RegisteredTool[];
  private readonly businessClients = new Map<string, Promise<McpToolSource>>();
  /** Toolkits dropped this run because the Composio project has no auth config for them. */
  private readonly boundSessions = new Map<string, Promise<string>>();
  private readonly unavailable = new Set<string>();

  constructor(opts: ComposioAppsOptions) {
    if (!opts.apiKey) throw new Error("ComposioApps needs an apiKey (COMPOSIO_API_KEY)");
    if (!opts.userId) throw new Error("ComposioApps needs a userId");
    this.opts = opts;
    const create = opts.adapters?.createComposio ?? defaultCreateComposio;
    this.composio = create(opts.apiKey);
  }

  /** The mode the session really runs in: `router` whenever every toolkit is allowed. */
  get mode(): ComposioSessionMode {
    if (this.allToolkits) return "router";
    return this.opts.mode ?? "direct";
  }

  /** True when the toolkit list is `all` / `*`: no allowlist, any app by name. */
  get allToolkits(): boolean {
    return wantsAllToolkits(this.opts.toolkits);
  }

  /** Normalized toolkit slugs, or `["*"]` in all mode. Leaves out toolkits Composio refused for lack of an auth config. */
  get toolkitSlugs(): string[] {
    return normalizeToolkits(this.opts.toolkits).filter((t) => !this.unavailable.has(t));
  }

  /** Configured toolkits left out of the session because the Composio project has no auth config for them. */
  get unavailableToolkits(): string[] {
    return [...this.unavailable].sort();
  }

  get sessionId(): string | undefined {
    return this.session?.sessionId;
  }

  /** Private REST boundary. Never return raw account records, which may contain tokens. */
  private async api(path: string, init: RequestInit = {}): Promise<ComposioRestResponse> {
    const response = await (this.opts.adapters?.fetchImpl ?? fetch)(`https://backend.composio.dev/api/v3${path}`, {
      ...init, redirect: "error", headers: { "x-api-key": this.opts.apiKey, "content-type": "application/json" },
    });
    if (!response.ok) throw new Error(`Composio request failed (${response.status})`);
    if (response.status === 204) return {};
    const data: unknown = await response.json();
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid Composio response");
    return data as ComposioRestResponse;
  }

  async accounts(): Promise<Array<{ id: string; toolkit: string; active: boolean }>> {
    const accounts: Array<{ id: string; toolkit: string; active: boolean }> = [];
    let cursor: string | undefined;
    do {
      const query = new URLSearchParams({ user_ids: this.opts.userId, limit: "50" });
      if (cursor) query.set("cursor", cursor);
      const page = await this.api(`/connected_accounts?${query}`);
      if (!Array.isArray(page.items)) throw new Error("Invalid connected account response");
      for (const item of page.items) {
        if (item.user_id && item.user_id !== this.opts.userId) throw new Error("Connected account workspace mismatch");
        if (typeof item.id !== "string" || typeof item.toolkit?.slug !== "string") throw new Error("Invalid connected account");
        accounts.push({ id: item.id, toolkit: item.toolkit.slug, active: item.status === "ACTIVE" && item.is_disabled !== true });
      }
      if (page.next_cursor === cursor && cursor) throw new Error("Repeated account cursor");
      cursor = page.next_cursor || undefined;
    } while (cursor);
    return accounts;
  }

  async revokeAccount(accountId: string): Promise<{ jobId: string | null }> {
    const data = await this.api(`/connected_accounts/${encodeURIComponent(accountId)}?revoke_on_delete=true`, { method: "DELETE" });
    if (data.success !== true) throw new Error("Connected account deletion was not accepted");
    this.boundSessions.delete(accountId);
    return { jobId: typeof data.revoke_job_id === "string" ? data.revoke_job_id : null };
  }

  googleTransport(toolkit: "gmail" | "googlecalendar", accountId: string, assertActive: () => void, signal?: AbortSignal): GoogleTransport {
    return { request: async (input) => {
      if (googleToolkit(input) !== toolkit) throw new Error("Google account toolkit mismatch");
      signal?.throwIfAborted(); assertActive();
      const accounts = await this.accounts();
      if (!accounts.some((a) => a.id === accountId && a.toolkit === toolkit && a.active)) throw new GoogleProviderError(401);
      let pending = this.boundSessions.get(accountId);
      if (!pending) {
        pending = this.api("/tool_router/session", { method: "POST", body: JSON.stringify({
          user_id: this.opts.userId, toolkits: { enable: [toolkit] }, connected_accounts: { [toolkit]: accountId },
          manage_connections: { enable: false }, workbench: { enable: false }, proxy_execute: { enable: true },
        }) }).then((session) => {
          if (session.config?.user_id !== this.opts.userId || session.config?.connected_accounts?.[toolkit] !== accountId || typeof session.session_id !== "string") throw new Error("Proxy session account binding mismatch");
          return session.session_id as string;
        });
        this.boundSessions.set(accountId, pending);
        pending.catch(() => this.boundSessions.delete(accountId));
      }
      const sessionId = await pending;
      signal?.throwIfAborted(); assertActive();
      const parameters = Object.entries(input.query ?? {}).map(([name, value]) => ({ name, value, type: "query" }));
      if (input.ifMatch) parameters.push({ name: "If-Match", value: input.ifMatch, type: "header" });
      const result = await this.api(`/tool_router/session/${encodeURIComponent(sessionId)}/proxy_execute`, {
        method: "POST", ...(signal ? { signal } : {}), body: JSON.stringify({ toolkit_slug: toolkit, endpoint: input.endpoint, method: input.method,
          ...(input.body ? { body: input.body } : {}), parameters }),
      });
      if (result.result_type !== "completed") throw new Error(result.result_type === "input_required" ? "Provider requires owner input" : "Provider proxy blocked");
      if (typeof result.status !== "number" || !Number.isInteger(result.status) || result.status < 100 || result.status > 599) throw new Error("Invalid proxy status");
      return { status: result.status, data: result.data };
    } };
  }

  /** Reuse the stored session when it still matches; otherwise create one and save it. Then open MCP. */
  async connect(): Promise<void> {
    if (this.client) return;
    if (!this.connecting) {
      this.connecting = this.doConnect().finally(() => {
        this.connecting = undefined;
      });
    }
    await this.connecting;
  }

  private async doConnect(): Promise<void> {
    const session = await this.openSession();
    this.session = session;
    const connectMcp = this.opts.adapters?.connectMcp ?? defaultConnectMcp;
    this.client = await connectMcp(session.mcp);
    this.cachedTools = undefined;
    this.log(`composio: MCP connected for session ${session.sessionId}`);
  }

  private async openSession(): Promise<ComposioSessionLike> {
    const saved = this.opts.state.readJson<AppsState | undefined>(APPS_STATE_FILE, undefined);
    if (saved && sessionMatches(saved, this.opts.userId, this.toolkitSlugs, this.mode)) {
      try {
        const session = await this.composio.sessions.use(saved.sessionId, { mcp: true });
        this.log(`composio: reusing session ${saved.sessionId}`);
        return session;
      } catch (err) {
        this.log(`composio: stored session unusable (${messageOf(err)}); creating a new one`);
      }
    } else if (saved) {
      this.log("composio: stored session config differs; creating a new one");
    }
    const config: SessionCreateConfig = {
      manageConnections: { enable: true },
      mcp: true,
    };
    if (this.allToolkits) {
      // No allowlist: the meta tools can search, run and connect any toolkit. The
      // direct preset needs a toolkit filter, so all mode is always router mode.
      if (this.opts.mode === "direct") this.log("composio: all toolkits requested; using router mode");
    } else {
      config.toolkits = this.toolkitSlugs;
      // direct_tools lists each app tool so the guard sees GMAIL_SEND_EMAIL, not a generic executor.
      if (this.mode === "direct") config.sessionPreset = "direct_tools";
    }
    const session = await this.createSession(config);
    const state: AppsState = {
      sessionId: session.sessionId,
      userId: this.opts.userId,
      toolkits: this.toolkitSlugs,
      mode: this.mode,
      createdAt: new Date().toISOString(),
    };
    this.opts.state.writeJson(APPS_STATE_FILE, state);
    this.log(`composio: created session ${session.sessionId}${this.allToolkits ? " (all toolkits)" : ""}`);
    return session;
  }

  /**
   * Create the session. When Composio refuses some toolkits for lack of an auth
   * config, drop those and retry once, so one missing config (Google Contacts in a
   * new project, typically) does not switch off every app. Any other error, or a
   * refusal that names every toolkit, is thrown as before.
   */
  private async createSession(config: SessionCreateConfig): Promise<ComposioSessionLike> {
    try {
      return await this.composio.sessions.create(this.opts.userId, config);
    } catch (err) {
      const requested = config.toolkits ?? [];
      const missing = toolkitsWithoutAuthConfig(err, requested);
      const rest = requested.filter((t) => !missing.includes(t));
      if (missing.length === 0 || rest.length === 0) throw err;
      for (const t of missing) this.unavailable.add(t);
      this.log(
        `composio: this Composio project has no auth config for ${missing.join(", ")}; starting with ${rest.join(", ")} only. ` +
          "Create the missing auth config in the Composio dashboard and restart the agent to add it.",
      );
      return await this.composio.sessions.create(this.opts.userId, { ...config, toolkits: rest });
    }
  }

  /** Every MCP tool wrapped as a RegisteredTool. Cached after the first call. */
  async tools(opts: { refresh?: boolean } = {}): Promise<RegisteredTool[]> {
    await this.connect();
    if (!this.cachedTools || opts.refresh) {
      this.cachedTools = await wrapMcpTools(this.requireClient());
      this.log(`composio: ${this.cachedTools.length} app tools`);
    }
    return this.cachedTools;
  }

  /** OAuth link the owner opens to connect a toolkit. Undefined when the toolkit needs no auth. */
  async connectLink(toolkit: string): Promise<string | undefined> {
    await this.connect();
    const req = await this.requireSession().authorize(toolkit.trim().toLowerCase());
    return req.redirectUrl ?? undefined;
  }

  async businessConnectLink(toolkit: string): Promise<string | undefined> {
    const session = await this.composio.sessions.create(this.opts.userId, {
      toolkits: [toolkit], manageConnections: { enable: true }, workbench: { enable: false }, mcp: true, sessionPreset: "direct_tools",
    });
    return (await session.authorize(toolkit)).redirectUrl ?? undefined;
  }

  /**
   * Connection state of each configured toolkit. Toolkits missing from the response
   * count as not connected. In all mode there is no configured list, so this returns
   * the toolkits that hold an active connection, each marked connected.
   */
  async connectedToolkits(): Promise<ToolkitStatus[]> {
    await this.connect();
    if (this.allToolkits) return this.activeConnections();
    const wanted = this.toolkitSlugs;
    const res = await this.requireSession().toolkits({ toolkits: wanted, limit: Math.max(wanted.length, 1) });
    const found = new Map<string, boolean>();
    for (const item of res.items) {
      found.set(item.slug.toLowerCase(), item.isNoAuth === true || item.connection?.isActive === true);
    }
    return wanted.map((slug) => ({ slug, connected: found.get(slug) ?? false }));
  }

  private async activeConnections(): Promise<ToolkitStatus[]> {
    const session = this.requireSession();
    const slugs = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_CONNECTED_PAGES; page += 1) {
      const res = await session.toolkits({ isConnected: true, limit: CONNECTED_PAGE_SIZE, ...(cursor ? { cursor } : {}) });
      for (const item of res.items) {
        if (item.connection?.isActive === true) slugs.add(item.slug.toLowerCase());
      }
      if (!res.nextCursor) break;
      cursor = res.nextCursor;
    }
    return [...slugs].sort().map((slug) => ({ slug, connected: true }));
  }

  async concreteTools(toolkit: string, accountId: string): Promise<RegisteredTool[]> {
    if (["gmail", "googlecalendar", "composio"].includes(toolkit)) return [];
    let pending = this.businessClients.get(accountId);
    if (!pending) {
      pending = this.composio.sessions.create(this.opts.userId, {
        toolkits: [toolkit], connectedAccounts: { [toolkit]: accountId }, sessionPreset: "direct_tools",
        workbench: { enable: false }, manageConnections: { enable: false }, mcp: true,
      }).then((session) => (this.opts.adapters?.connectMcp ?? defaultConnectMcp)(session.mcp));
      this.businessClients.set(accountId, pending);
      pending.catch(() => this.businessClients.delete(accountId));
    }
    const client = await pending;
    return (await wrapMcpTools(client)).filter((tool) => tool.spec.name.startsWith(`app_${toolkit}_`) && !/proxy|execute_code|remote_bash|workbench|multi_execute/i.test(tool.spec.name));
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.cachedTools = undefined;
    if (client) await client.close();
    await Promise.all([...this.businessClients.values()].map(async (pending) => (await pending).close()));
    this.businessClients.clear();
  }

  private requireClient(): McpToolSource {
    if (!this.client) throw new Error("ComposioApps is not connected");
    return this.client;
  }

  private requireSession(): ComposioSessionLike {
    if (!this.session) throw new Error("ComposioApps is not connected");
    return this.session;
  }

  private log(m: string): void {
    this.opts.logger?.(m);
  }
}

/** True when the list names every toolkit: any entry is `all` or `*`. */
export function wantsAllToolkits(toolkits: string[]): boolean {
  return toolkits.some((t) => {
    const v = t.trim().toLowerCase();
    return v === "all" || v === ALL_TOOLKITS;
  });
}

/** Lowercase, trim, dedupe and sort. `all` or `*` anywhere in the list collapses it to `["*"]`. */
export function normalizeToolkits(toolkits: string[]): string[] {
  if (wantsAllToolkits(toolkits)) return [ALL_TOOLKITS];
  return [...new Set(toolkits.map((t) => t.trim().toLowerCase()).filter(Boolean))].sort();
}

function sessionMatches(saved: AppsState, userId: string, toolkits: string[], mode: ComposioSessionMode): boolean {
  if (!saved.sessionId || saved.userId !== userId) return false;
  if ((saved.mode ?? "router") !== mode) return false;
  const a = normalizeToolkits(saved.toolkits ?? []);
  return a.length === toolkits.length && a.every((t, i) => t === toolkits[i]);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The error message plus any response body the SDK attached (`APIError.error`). */
function errorText(err: unknown): string {
  const parts = [messageOf(err)];
  const body = (err as { error?: unknown } | null)?.error;
  if (body !== undefined) {
    try {
      parts.push(typeof body === "string" ? body : JSON.stringify(body));
    } catch {
      // An unserializable body adds nothing.
    }
  }
  return parts.join(" ");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function defaultCreateComposio(apiKey: string): ComposioClientLike {
  // The SDK's Session type is wider than ComposioSessionLike; the structural subset is all we call.
  // SDK telemetry re-sends SIGTERM and can interrupt the controller's durable shutdown.
  return new Composio({ apiKey, allowTracking: false });
}

async function defaultConnectMcp(mcp: McpEndpoint): Promise<McpToolSource> {
  const client = new McpClient({ name: "open-instinct-apps", version: "0.1.0" });
  await client.connect(new StreamableHttpTransport({ url: mcp.url, headers: mcp.headers ?? {} }));
  return client;
}
