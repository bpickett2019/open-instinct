import { createHash } from "node:crypto";
import { Type, type Static } from "typebox";
import type { BusinessAction, BusinessConnection, BusinessStore, Json, RegisteredTool, ToolContext, ToolMeta, Capability } from "@open-instinct/core";
import { defineTool } from "@open-instinct/core";
import { ComposioApps } from "./composio.js";
import { GoogleWorkspace, type MailInput, type PreparedMail, type CalendarInput } from "./google-workspace.js";
import { GmailIntake } from "./gmail-intake.js";
import { GoogleProviderError } from "./google-transport.js";

type OperationInput = MailInput & PreparedMail & CalendarInput & { id: string; etag: string; calendarId: string; attachmentId: string; filename?: string; mimeType?: string; artifactIds?: string[]; query?: Record<string, string>; timeMin: string; timeMax: string; timeZone: string };
interface OperationArgs { operation: string; input: OperationInput }
const listQueryKeys: Record<string, readonly string[]> = {
  events: ["timeMin", "timeMax", "timeZone", "singleEvents", "orderBy", "showDeleted", "maxResults", "pageToken"],
  messages: ["q", "maxResults", "pageToken", "includeSpamTrash", "labelIds"],
  threads: ["q", "maxResults", "pageToken", "includeSpamTrash", "labelIds"],
};
function validateListInput(operation: string, input: object): void {
  const allowed = listQueryKeys[operation];
  if (!allowed) return;
  if (Object.keys(input).some(key => key !== "query" && !(operation === "events" && key === "calendarId"))) {
    throw new Error(`${operation} filters belong inside input.query, using native camelCase names and string values; other input fields are not supported`);
  }
  const query: unknown = Reflect.get(input, "query");
  if (query === undefined) return;
  if (!query || typeof query !== "object" || Array.isArray(query)) throw new Error("input.query must be an object of string values");
  for (const [key, value] of Object.entries(query)) {
    if (!allowed.includes(key) || typeof value !== "string" || /[\r\n\0]/.test(value)) throw new Error(`Invalid ${operation} input.query field: ${key}; use native camelCase names and string values`);
    if (["singleEvents", "showDeleted", "includeSpamTrash"].includes(key) && value !== "true" && value !== "false") throw new Error(`${key} must be the string "true" or "false"`);
  }
}
const googleInput = Type.Object({
  query: Type.Optional(Type.Object({
    timeMin: Type.Optional(Type.String({ description: "Calendar lower bound, RFC3339 with offset, e.g. 2026-10-25T00:00:00-07:00." })),
    timeMax: Type.Optional(Type.String({ description: "Calendar exclusive upper bound, RFC3339 with offset." })),
    timeZone: Type.Optional(Type.String({ description: "Calendar IANA time zone, e.g. America/Los_Angeles." })),
    singleEvents: Type.Optional(Type.Union([Type.Literal("true"), Type.Literal("false")], { description: "Use the string true to expand recurring Calendar events." })),
    orderBy: Type.Optional(Type.Union([Type.Literal("startTime"), Type.Literal("updated")])),
    showDeleted: Type.Optional(Type.Union([Type.Literal("true"), Type.Literal("false")])),
    maxResults: Type.Optional(Type.String()),
    pageToken: Type.Optional(Type.String({ description: "Continue with nextPageToken and the same filters until no token remains." })),
    q: Type.Optional(Type.String({ description: "Gmail search, for messages/threads only." })),
    includeSpamTrash: Type.Optional(Type.Union([Type.Literal("true"), Type.Literal("false")])),
    labelIds: Type.Optional(Type.String()),
  }, { additionalProperties: false, description: "All events/messages/threads filters go here, not alongside query. All values are strings." })),
  id: Type.Optional(Type.String()), calendarId: Type.Optional(Type.String()),
  messageId: Type.Optional(Type.String()), attachmentId: Type.Optional(Type.String()),
  filename: Type.Optional(Type.String()), mimeType: Type.Optional(Type.String()),
  to: Type.Optional(Type.Array(Type.String())), cc: Type.Optional(Type.Array(Type.String())), bcc: Type.Optional(Type.Array(Type.String())),
  subject: Type.Optional(Type.String()), text: Type.Optional(Type.String()), html: Type.Optional(Type.String()),
  threadId: Type.Optional(Type.String()), inReplyTo: Type.Optional(Type.String()), references: Type.Optional(Type.Array(Type.String())),
  attachments: Type.Optional(Type.Array(Type.Object({ filename: Type.String(), contentType: Type.String(), content: Type.String(), sha256: Type.String() }))),
  artifactIds: Type.Optional(Type.Array(Type.String())),
  summary: Type.Optional(Type.String()), description: Type.Optional(Type.String()), location: Type.Optional(Type.String()),
  start: Type.Optional(Type.Object({ dateTime: Type.String(), timeZone: Type.String() })),
  end: Type.Optional(Type.Object({ dateTime: Type.String(), timeZone: Type.String() })),
  attendees: Type.Optional(Type.Array(Type.Object({ email: Type.String() }))),
  sendUpdates: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("externalOnly"), Type.Literal("none")])),
  etag: Type.Optional(Type.String()),
  timeMin: Type.Optional(Type.String({ description: "Top-level only for freebusy. For events, use input.query.timeMin." })),
  timeMax: Type.Optional(Type.String({ description: "Top-level only for freebusy. For events, use input.query.timeMax." })),
  timeZone: Type.Optional(Type.String({ description: "Top-level only for freebusy. For events, use input.query.timeZone." })),
}, { additionalProperties: false });
function operationArgs(value: unknown, prepared = false): OperationArgs {
  if (!value || typeof value !== "object" || !("operation" in value) || typeof value.operation !== "string" || !("input" in value) || !value.input || typeof value.input !== "object" || Array.isArray(value.input)) throw new Error("Invalid Google operation");
  const input = value.input;
  const required: Record<string, string[]> = { send: prepared ? ["raw", "messageId"] : ["subject", "text"], message: ["id"], thread: ["id"], attachment: ["messageId", "attachmentId"], event: ["id"], update: ["id", "etag", "summary", "sendUpdates"], cancel: ["id", "etag", "sendUpdates"], insert: ["summary", "sendUpdates"], freebusy: ["timeMin", "timeMax", "timeZone"] };
  if (!["profile", "labels", "messages", "message", "thread", "threads", "attachment", "calendars", "calendar", "events", "event", "freebusy", "send", "insert", "update", "cancel"].includes(value.operation)) throw new Error("Unsupported Google operation");
  validateListInput(value.operation, input);
  for (const key of required[value.operation] ?? []) if (typeof Reflect.get(input, key) !== "string") throw new Error(`Missing ${key}`);
  if (!prepared && value.operation === "send" && (!("to" in input) || !Array.isArray(input.to) || !input.to.every((v: unknown) => typeof v === "string"))) throw new Error("Recipients required");
  if (["insert", "update"].includes(value.operation)) {
    for (const key of ["start", "end"]) {
      const time: unknown = Reflect.get(input, key);
      if (!time || typeof time !== "object" || !("dateTime" in time) || typeof time.dateTime !== "string" || !("timeZone" in time) || typeof time.timeZone !== "string") throw new Error("Calendar time required");
    }
    const attendees: unknown = Reflect.get(input, "attendees");
    if (!Array.isArray(attendees) || !attendees.every((a: unknown) => !!a && typeof a === "object" && "email" in a && typeof a.email === "string")) throw new Error("Attendees required");
  }
  return value as OperationArgs;
}

export interface ProviderArtifacts {
  ingestAttachment(input: { filename: string; mimeType: string; bytes: Uint8Array; accountId: string; messageId: string; attachmentId: string; taskId?: string }): Promise<unknown>;
  download(id: string): Promise<{ filename: string; mimeType: string; bytes: Uint8Array }>;
}
export function createBusinessProviders(options: { apps: ComposioApps; store: BusinessStore; artifacts?: ProviderArtifacts; ownerNotice?: (id: string, text: string) => Promise<void> }) { return new BusinessProviders(options.apps, options.store, options.artifacts, options.ownerNotice); }
export class BusinessProviders {
  constructor(private readonly apps: ComposioApps, private readonly store: BusinessStore, private readonly artifacts?: ProviderArtifacts, private readonly ownerNotice?: (id: string, text: string) => Promise<void>) {}
  googleForAccount(accountId: string): GoogleWorkspace {
    const connection = this.store.get<BusinessConnection>("connection", accountId);
    if (!connection || !["gmail", "googlecalendar"].includes(connection.value.toolkit)) throw new Error("Google account not found");
    const bound = this.bound(connection.value.toolkit as "gmail" | "googlecalendar");
    if (bound.connection.accountId !== accountId) throw new Error("Account substitution denied");
    return bound.google;
  }
  intake(accountId: string): GmailIntake { return new GmailIntake(this.store, this.googleForAccount(accountId), accountId); }
  private pinTask(ctx: ToolContext, connection: { id: string; accountId: string }, toolkit: string): void {
    if (!ctx.taskRun) throw new Error("Task-bound operation required");
    const id = `task-account:${ctx.taskRun.taskId}:${toolkit}`;
    const pinned = this.store.get<{ accountId: string }>("cursor", id);
    if (pinned && pinned.value.accountId !== connection.accountId) throw new Error("Historical task account substitution denied");
    if (!pinned) this.store.put("cursor", id, { accountId: connection.accountId }, null);
  }
  private async disable(id: string): Promise<void> {
    const current = this.store.get<BusinessConnection>("connection", id);
    if (!current || current.value.status !== "connected") return;
    this.store.put("connection", id, { ...current.value, status: "disabled", epoch: current.value.epoch + 1 }, current.version);
    const noticeId = `connection-disabled:${id}:${current.value.epoch}`;
    const text = `${current.value.toolkit} connection is unavailable. Dependent work is blocked. Reconnect from Connections.`;
    this.store.appendMessage({ id: noticeId, channel: "system", thread: "owner", role: "notice", text, taskId: null, artifactIds: [], at: this.store.now() });
    await this.ownerNotice?.(noticeId, text);
  }
  private async catalog() {
    const entries: Array<{ tool: RegisteredTool; connection: { id: string; version: number; epoch: number; accountId: string } }> = [];
    for (const saved of this.store.list<BusinessConnection>("connection").filter((c) => c.value.status === "connected")) {
      for (const tool of await this.apps.concreteTools(saved.value.toolkit, saved.value.accountId)) {
        entries.push({ tool, connection: { id: saved.id, version: saved.version, epoch: saved.value.epoch, accountId: saved.value.accountId } });
      }
    }
    return entries;
  }
  readonly connections = {
    list: async (): Promise<Array<BusinessConnection & { version: number }>> => {
      const accounts = await this.apps.accounts();
      for (const saved of this.store.list<BusinessConnection>("connection")) {
        if (saved.value.status === "connected" && !accounts.some((a) => a.id === saved.value.accountId && a.active && a.toolkit === saved.value.toolkit)) {
          await this.disable(saved.id);
        }
      }
      for (const account of accounts.filter((a) => a.active)) {
        const saved = this.store.get<BusinessConnection>("connection", account.id);
        if (saved?.value.status === "connected") continue;
        const historical = this.store.list<BusinessConnection>("connection").filter((c) => c.value.toolkit === account.toolkit);
        const intent = this.store.get<{ pending: boolean }>("cursor", `connect:${account.toolkit}`);
        if (intent && !intent.value.pending) continue;
        if (saved?.value.revocation === "requested") continue;
        if (saved && (!intent?.value.pending || saved.value.toolkit !== account.toolkit)) continue;
        if (!intent?.value.pending && !this.apps.toolkitSlugs.includes(account.toolkit)) continue;
        if (accounts.filter((candidate) => candidate.active && candidate.toolkit === account.toolkit).length > 1) throw new Error(`Multiple ${account.toolkit} accounts: select one active account in the provider dashboard before connecting`);
        if (historical.length && (!intent?.value.pending || historical.some((c) => c.value.status === "connected"))) continue;
        const assertAdmission = () => {
          if (this.store.get("cursor", `connect:${account.toolkit}`)?.version !== intent?.version ||
              this.store.get("connection", account.id)?.version !== saved?.version) throw new Error("Connection authority changed during verification");
        };
        let identity = account.id;
        if (account.toolkit === "gmail" || account.toolkit === "googlecalendar") {
          const google = new GoogleWorkspace(this.apps.googleTransport(account.toolkit, account.id, assertAdmission));
          const profile = account.toolkit === "gmail" ? await google.profile() : await google.calendar("primary");
          const providerIdentity = account.toolkit === "gmail" ? profile.emailAddress : profile.id;
          if (typeof providerIdentity !== "string" || !providerIdentity) throw new Error("Provider identity unavailable");
          identity = providerIdentity;
        }
        if (saved && saved.value.identity !== identity) throw new Error("Reconnected account identity changed; historical bindings cannot be replaced");
        const connection: BusinessConnection = { id: account.id, toolkit: account.toolkit, accountId: account.id, identity, scopes: saved?.value.scopes ?? [], status: "connected", epoch: saved ? saved.value.epoch + 1 : 0, connectedBy: "owner", verifiedAt: this.store.now(), revocation: "none", revokeJobId: null };
        this.store.transaction(() => {
          assertAdmission();
          this.store.put("connection", account.id, connection, saved?.version ?? null);
          if (intent) this.store.put("cursor", intent.id, { pending: false }, intent.version);
        });
      }
      return this.store.list<BusinessConnection>("connection").map((c) => ({ ...c.value, version: c.version }));
    },
    connect: async (toolkit: string): Promise<{ url: string | null }> => {
      if (!/^[a-z][a-z0-9_]*$/.test(toolkit)) throw new Error("Invalid toolkit");
      const id = `connect:${toolkit}`;
      const prior = this.store.get("cursor", id);
      const reservation = this.store.put("cursor", id, { pending: false, cancelled: false }, prior?.version ?? null);
      const url = await this.apps.businessConnectLink(toolkit) ?? null;
      this.store.put("cursor", id, { pending: true, cancelled: false }, reservation.version);
      return { url };
    },
    disconnect: async (id: string, expectedVersion?: number): Promise<BusinessConnection> => {
      const saved = this.store.get<BusinessConnection>("connection", id);
      if (!saved) throw new Error("Connection not found");
      if (expectedVersion !== undefined && saved.version !== expectedVersion) throw new Error("Connection version conflict");
      const disabled = this.store.transaction(() => {
        const id = `connect:${saved.value.toolkit}`;
        const intent = this.store.get("cursor", id);
        this.store.put("cursor", id, { pending: false, cancelled: true }, intent?.version ?? null);
        return this.store.put("connection", saved.id, { ...saved.value, status: "disabled" as const, epoch: saved.value.epoch + 1, revocation: "requested" as const, revokeJobId: null }, saved.version);
      });
      try {
        const result = await this.apps.revokeAccount(saved.value.accountId);
        return this.store.put("connection", id, { ...disabled.value, revokeJobId: result.jobId }, disabled.version).value;
      } catch {
        return this.store.put("connection", id, { ...disabled.value, revocation: "failed" as const }, disabled.version).value;
      }
    },
  };
  private bound(toolkit: "gmail" | "googlecalendar", fence?: () => void, signal?: AbortSignal) {
    const connection = this.store.list<BusinessConnection>("connection").find((c) => c.value.toolkit === toolkit && c.value.status === "connected");
    if (!connection) throw new Error(`${toolkit} connection required`);
    const assertActive = () => {
      signal?.throwIfAborted(); fence?.();
      const current = this.store.get<BusinessConnection>("connection", connection.id);
      if (!current || current.value.status !== "connected" || current.value.epoch !== connection.value.epoch || current.value.accountId !== connection.value.accountId) throw new Error("Connection disabled or replaced");
    };
    const transport = this.apps.googleTransport(toolkit, connection.value.accountId, assertActive, signal);
    return { connection: { id: connection.id, version: connection.version, epoch: connection.value.epoch, accountId: connection.value.accountId },
      google: new GoogleWorkspace({ request: async (input) => {
        let response: { status: number; data: unknown };
        try { response = await transport.request(input); }
        catch (error) { if (error instanceof GoogleProviderError && error.status === 401) await this.disable(connection.id); throw error; }
        if (response.status === 401) await this.disable(connection.id);
        return response;
      } }), identity: connection.value.identity };
  }
  async tools(): Promise<RegisteredTool[]> {
    const task = (ctx: ToolContext) => { if (!ctx.taskRun) throw new Error("Task-bound operation required"); };
    const parameters = Type.Object({ operation: Type.String(), input: googleInput });
    const tools: RegisteredTool[] = [defineTool({
      name: "business_google", label: "Google Workspace", description: "Typed Gmail and Calendar operations. operation: profile, labels, messages, message, thread, threads, attachment, calendars, calendar, events, event, freebusy, send, insert, update, cancel. For events/messages/threads put ALL filters in input.query using native camelCase keys and STRING values. Example events input: {\"query\":{\"timeMin\":\"2026-10-25T00:00:00-07:00\",\"timeMax\":\"2026-10-26T00:00:00-07:00\",\"timeZone\":\"America/Los_Angeles\",\"singleEvents\":\"true\",\"orderBy\":\"startTime\"}}. Resolve today/tomorrow in the owner's local timezone, not UTC. Follow nextPageToken with the same filters before claiming a complete or empty schedule. Sends use to/subject/text, optional cc/bcc/html/threadId/inReplyTo/references/attachments. Calendar writes use summary/start/end/attendees/sendUpdates; updates/cancel require id and current etag. Only freebusy uses top-level timeMin/timeMax/timeZone. calendarId is the bound calendar identity.",
      parameters, meta: { capabilities: ["apps.use"], group: "apps", execution: "operation", describe: () => "Google Workspace operation" },
      // Pi otherwise converts primitive types and drops optional nulls before execute.
      // A discarded date bound can turn an intended day read into an unfiltered read.
      prepareArguments: value => { operationArgs(value); return value as Static<typeof parameters>; },
      prepareBusiness: async (value: unknown, ctx) => {
        const args = operationArgs(value);
        task(ctx);
        const operation = String(args.operation);
        const calendar = ["calendars", "calendar", "events", "event", "freebusy", "insert", "update", "cancel"].includes(operation);
        const bound = this.bound(calendar ? "googlecalendar" : "gmail");
        this.pinTask(ctx, bound.connection, calendar ? "googlecalendar" : "gmail");
        if (operation === "send") {
          const profile = await bound.google.profile();
          if (profile.emailAddress !== bound.identity) throw new Error("Mailbox identity changed");
        }
        const key = `${ctx.taskRun!.taskId}:${operation}:${bound.connection.accountId}`;
        let input: unknown = args.input;
        if (operation === "send") {
          const attachments = [...(args.input.attachments ?? [])];
          for (const id of args.input.artifactIds ?? []) {
            if (!this.artifacts || typeof id !== "string") throw new Error("Artifact store required");
            const file = await this.artifacts.download(id);
            const bytes = Buffer.from(file.bytes);
            attachments.push({ filename: file.filename, contentType: file.mimeType, content: bytes.toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex") });
          }
          const taskRecord = this.store.task(ctx.taskRun!.taskId);
          if (!taskRecord) throw new Error("Task not found");
          input = await bound.google.prepareMail({ ...args.input, attachments, from: bound.identity }, key, taskRecord.createdAt);
        }
        if (["insert", "update"].includes(operation)) {
          const prepared = bound.google.prepareEvent(args.input, key);
          input = { ...prepared, ...(operation === "update" ? { id: args.input.id, etag: args.input.etag } : {}) };
        }
        if (calendar) input = { ...(input as Record<string, unknown>), calendarId: bound.identity };
        const effect = ["send", "insert", "update", "cancel", "attachment"].includes(operation) ? "write" : "read";
        const capability: Capability = calendar ? operation === "freebusy" ? "calendar.freebusy" : effect === "write" ? "calendar.write" : "calendar.read" : operation === "send" ? "email.send" : "email.read";
        const resolvedMeta: ToolMeta = { capabilities: [capability], group: "apps", execution: "operation", effect, describe: () => `Google ${operation}` };
        return { args: { operation, input } as Json, connection: bound.connection, resolvedTool: `business_google_${operation}`, resolvedMeta };
      },
      execute: async (value: unknown, ctx, signal) => {
        const args = operationArgs(value, true);
        task(ctx);
        const { operation, input: i } = args;
        const calendar = ["calendars", "calendar", "events", "event", "freebusy", "insert", "update", "cancel"].includes(operation);
        const bound = this.bound(calendar ? "googlecalendar" : "gmail", ctx.assertBusinessDispatch, signal);
        this.assertInvocation(ctx, bound.connection);
        const g = bound.google;
        let result: unknown;
        switch (operation) {
          case "profile": result = await g.profile(); break;
          case "labels": result = await g.labels(); break;
          case "messages": result = await g.messages(i.query); break;
          case "message": result = await g.message(i.id); break;
          case "thread": result = await g.thread(i.id); break;
          case "threads": result = await g.threads(i.query); break;
          case "attachment": {
            if (!this.artifacts) throw new Error("Artifact store required for attachment ingestion");
            const bytes = await g.attachment(i.messageId, i.attachmentId);
            result = await this.artifacts.ingestAttachment({ filename: i.filename ?? "attachment", mimeType: i.mimeType ?? "application/octet-stream", bytes,
              accountId: this.bound("gmail").connection.accountId, messageId: i.messageId, attachmentId: i.attachmentId, taskId: ctx.taskRun!.taskId });
            break;
          }
          case "send": result = await g.send(i); break;
          case "calendars": result = await g.calendars(); break;
          case "calendar": result = await g.calendar(i.calendarId); break;
          case "events": result = await g.events(i.calendarId, i.query); break;
          case "event": result = await g.event(i.calendarId, i.id); break;
          case "freebusy": result = await g.freebusy(i.calendarId, i.timeMin, i.timeMax, i.timeZone); break;
          case "insert": { const { calendarId, ...event } = i; result = await g.insert(calendarId, event); break; }
          case "update": { const { calendarId, id, etag, ...event } = i; result = await g.update(calendarId, id, etag, event); break; }
          case "cancel": result = await g.cancel(i.calendarId, i.id, i.etag, i.sendUpdates); break;
          default: throw new Error("Unsupported Google operation");
        }
        if (["send", "insert", "update", "cancel"].includes(operation)) {
          const id = result && typeof result === "object" && "id" in result && typeof result.id === "string" ? result.id : null;
          const etag = result && typeof result === "object" && "etag" in result && typeof result.etag === "string" ? result.etag : null;
          ctx.recordBusinessReceipt?.({ id, etag, operation });
        }
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      },
      verify: async (args: unknown, result, ctx) => this.verify(operationArgs(args, true), typeof result === "string" ? null : result.details, ctx.businessConnection?.accountId),
    })];
    tools.push(defineTool({
      name: "business_apps_catalog", label: "Connected app catalog", description: "Search concrete connected-app operations and their exact input schemas. Discovery never invokes an operation.",
      parameters: Type.Object({ query: Type.String() }), meta: { capabilities: ["apps.use"], group: "apps", effect: "read", execution: "operation" },
      execute: async (args: { query: string }, ctx) => {
        task(ctx);
        if (!ctx.businessInvocation) throw new Error("Catalog access requires final task dispatch");
        const query = args.query.toLowerCase();
        const entries = (await this.catalog()).filter(({ tool }) => `${tool.spec.name} ${tool.spec.description}`.toLowerCase().includes(query)).slice(0, 20);
        return JSON.stringify(entries.map(({ tool }) => ({ name: tool.spec.name, description: tool.spec.description, parameters: tool.spec.parameters })));
      },
    }), defineTool({
      name: "business_app", label: "Concrete app operation", description: "Execute one concrete operation discovered with business_apps_catalog. Router, remote code, proxy, multi-execute and raw Google equivalents are unsupported. A successful result is an unverified provider receipt, not proof of the business outcome.",
      parameters: Type.Object({ tool: Type.String(), input: Type.Record(Type.String(), Type.Unknown()) }),
      meta: { capabilities: ["apps.use"], group: "apps", execution: "operation" },
      prepareBusiness: async (args: { tool: string; input: Record<string, unknown> }, ctx) => {
        task(ctx);
        const entry = (await this.catalog()).find((e) => e.tool.spec.name === args.tool);
        if (!entry) throw new Error("Unsupported concrete app operation");
        this.pinTask(ctx, entry.connection, args.tool.split("_")[1] ?? args.tool);
        const resolvedMeta: ToolMeta = { ...entry.tool.spec.meta, execution: "operation", describe: () => `Connected app ${entry.tool.spec.name}` };
        if (entry.tool.spec.meta.amountUsd) {
          const extract = entry.tool.spec.meta.amountUsd;
          resolvedMeta.amountUsd = (value) => value && typeof value === "object" && "input" in value ? extract(value.input) : undefined;
        }
        return { args: args as Json, connection: entry.connection, resolvedTool: entry.tool.spec.name, resolvedMeta };
      },
      execute: async (args: { tool: string; input: Record<string, unknown> }, ctx, signal) => {
        task(ctx);
        const entry = (await this.catalog()).find((e) => e.tool.spec.name === args.tool);
        if (!entry) throw new Error("Connected operation unavailable");
        const accounts = await this.apps.accounts();
        if (!accounts.some((a) => a.id === entry.connection.accountId && a.active)) throw new Error("Connected account disabled");
        this.assertInvocation(ctx, entry.connection);
        signal?.throwIfAborted(); ctx.assertBusinessDispatch?.();
        return entry.tool.spec.execute(args.input, ctx, signal);
      },
    }));
    return tools;
  }
  private assertInvocation(ctx: ToolContext, connection: NonNullable<ToolContext["businessConnection"]>): void {
    const expected = ctx.businessConnection;
    const current = this.store.get<BusinessConnection>("connection", connection.id);
    if (!ctx.businessInvocation || !ctx.taskRun || !ctx.assertBusinessDispatch || !expected || expected.id !== connection.id || expected.version !== connection.version || expected.epoch !== connection.epoch || expected.accountId !== connection.accountId || !current || current.version !== connection.version || current.value.epoch !== connection.epoch || current.value.status !== "connected") throw new Error("Concrete provider dispatch binding changed");
    ctx.assertBusinessDispatch();
  }
  private async verify(args: OperationArgs, receipt: unknown, accountId: string | undefined) {
    if (!accountId) throw new Error("Outcome verification requires the dispatched account identity");
    const google = this.googleForAccount(accountId);
    const i = args.input;
    let verified = false; let ref: string | null = null;
    if (args.operation === "send") {
      const providerId = receipt && typeof receipt === "object" && "id" in receipt && typeof receipt.id === "string" ? receipt.id : undefined;
      const result = await google.verifyMail(i, providerId);
      verified = result.verified; ref = result.id ? `gmail:${result.id}` : null;
    } else if (["insert", "update", "cancel"].includes(args.operation)) {
      verified = await google.verifyEvent(i.calendarId, i.id, args.operation === "cancel" ? null : i as CalendarInput);
      ref = `calendar:${i.calendarId}:${i.id}`;
    } else if (receipt !== null && receipt !== undefined) {
      verified = true;
      ref = `google-read:${createHash("sha256").update(JSON.stringify({ args, receipt })).digest("hex")}`;
    }
    return { verified, receipt: (receipt ?? {}) as Json, evidenceRefs: verified && ref ? [ref] : [] };
  }
  async reconcile(action: BusinessAction) {
    if (action.tool !== "business_google") return { verified: false, receipt: action.receipt, evidenceRefs: action.evidenceRefs };
    const current = action.connection && this.store.get<BusinessConnection>("connection", action.connection.id);
    if (!current || current.value.accountId !== action.connection?.accountId || current.value.status !== "connected") return { verified: false, receipt: action.receipt, evidenceRefs: action.evidenceRefs };
    return this.verify(operationArgs(action.arguments, true), action.receipt, action.connection?.accountId);
  }
}
