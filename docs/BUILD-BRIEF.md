# Build brief (for implementers)

Read docs/ARCHITECTURE.md, docs/PERMISSIONS.md, docs/PROTOCOL.md and packages/core/src/types.ts first.
This file holds the exact library facts you need so you do not have to rediscover them.

## Toolchain

- Node >=22.22.3 is required, including deployment images. Use the repository pin: `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use`.
- pnpm 10.6.1 (`corepack enable`). Root: `pnpm install`, `pnpm -r build`, `pnpm -r test`, `pnpm -r typecheck`.
- TypeScript strict ESM (`"type": "module"`, NodeNext). Import local files with `.js` extensions.
- Tests: vitest in `packages/<name>/test/*.test.ts`.
- Node has global `fetch`, `crypto.subtle` and native `node:sqlite`. Business state uses SQLite on a supported local persistent filesystem; personal state retains existing JSON stores.

## Pi (the agent runtime) : versions 1.0.1, scope `@earendil-works`

VERIFIED 2026-10-03 by running code (see scratch probe): the main entry of `@earendil-works/pi-ai` does NOT export `getModel`/`streamSimple`/`completeSimple`. Those live in the deprecated `@earendil-works/pi-ai/compat` entry. The v1 API is a `Models` collection:

```ts
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall, Type } from "@earendil-works/pi-ai";   // Type = TypeBox re-export
import { builtinModels } from "@earendil-works/pi-ai/providers/all";                                              // 42 providers incl. anthropic
import { Agent, type AgentTool, type AgentMessage, type StreamFn } from "@earendil-works/pi-agent-core";

const models = builtinModels();                                  // createModels() alone is EMPTY (0 providers)
const model = models.getModel("anthropic", "claude-fable-5-1");  // Model<Api> | undefined; ids verified live: claude-fable-5-1 (1M ctx), claude-opus-5-5, claude-sonnet-5-5, claude-haiku-4-5
const streamFn: StreamFn = models.streamSimple.bind(models);     // reads ANTHROPIC_API_KEY from env through the provider's auth
const agent = new Agent({
  initialState: { systemPrompt, model, tools, thinkingLevel: "medium", messages: [] },
  streamFn,
  beforeToolCall: async ({ toolCall, args }) => allowed ? undefined : { block: true, reason: "..." },
  afterToolCall: async (ctx) => undefined,
  toolExecution: "sequential",
});
agent.subscribe((ev) => { /* agent_start | message_update (ev.assistantMessageEvent.type === "text_delta") | message_end (ev.message.role === "assistant" -> final text blocks) | tool_execution_start | tool_execution_end | agent_end */ });
await agent.prompt("text"); await agent.waitForIdle();
// agent.state.messages roles after one tool turn: system,user,assistant,toolResult,assistant  (the leading system message is created from systemPrompt+tools; keep it when persisting)
agent.steer({ role: "user", content: "...", timestamp: Date.now() });    // mid-run
agent.followUp({ role: "user", content: "...", timestamp: Date.now() });  // after the run

// Tests: no network
const faux = fauxProvider({ models: [{ id: "faux-1" }] });
const testModels = createModels(); testModels.setProvider(faux.provider);
faux.setResponses([ fauxAssistantMessage([fauxToolCall("memory_write", { text: "likes window seats" })]), fauxAssistantMessage("Noted.") ]);
new Agent({ initialState: { model: faux.getModel(), ... }, streamFn: testModels.streamSimple.bind(testModels) });
```

The resolveModel helper in core should therefore return `{ model, streamFn }` built from one shared `builtinModels()` instance (or accept a `Models` instance for tests); `models.completeSimple(model, { systemPrompt, messages }, { maxTokens })` is the one-shot call.

AgentTool shape:
```ts
const t: AgentTool<typeof params> = { name, label, description, parameters: Type.Object({...}),
  execute: async (toolCallId, params, signal, onUpdate) => ({ content: [{ type: "text", text }], details: {} }) };
```
Tool names: `[A-Za-z0-9_-]{1,64}`. Thrown errors become `isError` tool results.

Sessions and compaction (pi-coding-agent):
```ts
import { SessionManager, convertToLlm, estimateTokens, compact, loadSkillsFromDir, formatSkillsForPrompt,
         createReadTool, createWriteTool, createEditTool, createBashTool, createLsTool, createGrepTool } from "@earendil-works/pi-coding-agent";
const sm = SessionManager.open("/data/sessions/<key>.jsonl");   // or SessionManager.create(cwd, sessionDir)
sm.appendMessage(msg); const { messages } = sm.buildSessionContext();
const tools = [createReadTool(workspace), createWriteTool(workspace), createEditTool(workspace), createBashTool(workspace), createLsTool(workspace), createGrepTool(workspace)];
const { skills } = loadSkillsFromDir({ dir: "/app/skills", sourceInfo: ... }); // or loadSkills({ cwd, agentDir, skillPaths, includeDefaults:false })
```
If the SessionManager API fights you, persist `agent.state.messages` as JSONL yourself; that is acceptable.

MCP client (pi-mcp):
```ts
import { McpClient, StdioTransport, StreamableHttpTransport, toLlmContent } from "@earendil-works/pi-mcp";
const client = new McpClient({ name: "open-instinct", version: "0.1.0" });
await client.connect(new StdioTransport({ command: "maritime-computer-mcp", args: [] }));            // in-VM desktop
await client.connect(new StreamableHttpTransport({ url, headers: { Authorization: `Bearer ${key}` } })); // hosted
const tools = await client.listTools(); const r = await client.callTool(name, args, { signal }); toLlmContent(r);
```
Wrap MCP tools as AgentTools exactly as pi-mcp's README shows (Type.Unsafe({...inputSchema, type:"object", properties: inputSchema.properties ?? {}})).

## Inkbox : `@inkbox/sdk` 0.7.13 (Node >= 22). REST base `https://inkbox.ai/api/v1`, header `X-API-Key`.

```ts
import { Inkbox, verifyWebhook } from "@inkbox/sdk";
const inkbox = new Inkbox({ apiKey });                              // admin key: org-wide; identity key: one identity
const id = await inkbox.createIdentity("maria-instinct", { displayName: "Maria's Instinct", imessageEnabled: true, phoneNumber: { type: "local", incomingCallAction: "auto_reject" } });
const identity = await inkbox.getIdentity(handle);
await identity.sendIMessage({ conversationId, text, replyToMessageId?, sendStyle?, mediaUrls?, idempotencyKey? });  // or { to: "+1..." } on a dedicated line
await identity.sendIMessageTyping(conversationId); await identity.sendIMessageReaction({ ... }); await identity.markIMessageConversationRead(conversationId);
await identity.sendText({ to, text }); await identity.sendEmail({ to: [..], subject, bodyText, bodyHtml?, inReplyToMessageId? });
await identity.a2aEnable(); const a2a = await identity.a2aClient(); const card = await a2a.fetchCard(`https://inkbox.ai/a2a/${peer}/card`);
const res = await a2a.send(card, { text, contextId? }); // res.kind === "task" → res.task.id / contextId
await identity.a2aReply(taskId, { intent: "complete" | "progress" | "ask_caller" | "fail", text? , parts? });
await identity.a2aAddContactRule({ handle: peer, action: "allow", direction: "both" });   // admin key needed
const sub = await inkbox.webhooks.subscriptions.create({ agentIdentityId: id.id, url, eventTypes: ["imessage.received","imessage.reaction_received","text.received","message.received","a2a.task.created","a2a.task.message"] }); // sub.signingKey shown once
verifyWebhook({ payload: rawBodyBuffer, headers: req.headers, secret: signingKey }); // HMAC-SHA256 over `${X-Inkbox-Request-ID}.${X-Inkbox-Timestamp}.${rawBody}`, header X-Inkbox-Signature: sha256=<hex>
```
Webhook envelope: `{ id: "evt_...", event_type, timestamp, data: { message|reaction|..., contacts: [], agent_identities: [] } }`.
`imessage.received` → `data.message.{id, conversation_id, remote_number, content, is_group, participants, media, reply_to_message_id}`.
`message.received` (mail) → `data.message.{id, thread_id, from_address, subject, body, email_address}`.
`text.received` → `data.message.{id, conversation_key?, remote_phone_number|remote_number, text|content}` (read defensively).
`a2a.task.created` / `a2a.task.message` → `data.{task_id, context_id, state, caller:{handle, identity_id, organization_id}, message_id, parts:[{text}|{data}]}`.
Router: `GET /api/v1/imessage/triage-number` → `{ number, connect_command: "connect @handle", sms_link, connect_qr_png_data_url }`. Humans text `connect @handle` to that number. Fetch it at runtime; never hardcode it.
Identity-scoped key: `POST /api/v1/api-keys { label, scoped_identity_id }` with the admin key; shown once. Signing key per identity: `POST /api/v1/identities/{handle}/signing-key` (shown once).
Agent self-signup (no org): `POST /api/v1/agent-signup/ { human_email, message, agent_handle? }` → provisional identity + API key; human gets a 6-digit code; `POST /api/v1/agent-signup/verify`.
Mail send REST: `POST /api/v1/mailboxes/{email}/messages { recipients:{to:[...]}, subject, body_text, body_html?, in_reply_to_message_id? }`.
A2A worker REST: `GET /api/v1/identities/{handle}/a2a/tasks?state=submitted`, `GET .../tasks/{id}`, `POST .../tasks/{id}/reply { intent, parts }`.
A2A caller JSON-RPC: `POST https://inkbox.ai/a2a/{peer}` headers `X-API-Key` (identity key), `A2A-Version: 1.0`; method `SendMessage` params `{ message: { messageId, role: "ROLE_USER", parts: [{text},{data}], contextId?, taskId? }, configuration: { returnImmediately: true } }`.

## Maritime : hosting, desktop, SDK

BYO container contract: bind `0.0.0.0:$PORT` (Maritime injects PORT, currently 18789; default 8080 locally), `GET /health` → 200 JSON, `POST /chat` body `{ message, source?, conversation_id? }` → `{ response }` within 30 s, persist under `/data`, image must have `python3` on PATH, optional `GET /schedules` → array of `{ id, nextRunAt?, cron?, tz?, prompt?, enabled }`.
Agents reach the platform with env `MARITIME_AGENT_ID`, `MARITIME_BACKEND_URL`, `MARITIME_INTERNAL_TOKEN` (an opaque bearer; never log it); push schedules with `POST $MARITIME_BACKEND_URL/api/agents/internal/schedules` headers `X-Maritime-Agent-Id`, `Authorization: Bearer $MARITIME_INTERNAL_TOKEN`, body `{ schedules: [...] }`.
In-VM desktop (agent created with `desktop: true`): `maritime-computer-mcp` on PATH is a stdio MCP server exposing `computer`, `computer_batch`, `request_takeover` (+ `run_shell` when `DESKTOPD_ALLOW_SHELL=1`); desktopd REST on `http://127.0.0.1:5911` (`GET /health`, `POST /action {action, coordinate, text, ...}`, `POST /batch {actions}`, `POST /takeover {reason}`, `GET /takeover/wait?timeout=`, `GET /fs/read?path=`, `POST /fs/write`). Detect with a GET /health.
Hosted Computers MCP: `https://mcp.maritime.sh/mcp/u/{externalUserId}` with `Authorization: Bearer mk_...` (key needs the `computers` scope); tools `get_computer {user_id?}`, `computer {computer_id, action, ...}`, `computer_batch`, `run_shell`, `read_file`, `write_file`, `request_takeover {computer_id, reason, wait?}`, `takeover_status`, `close_computer`. Screenshots are 1200 px wide; coordinates are pixels of the last screenshot.
Control plane: `https://api.maritime.sh`, `Authorization: Bearer mk_...`. `maritime-sdk` 0.9.0: `new Maritime({ apiKey })`, `maritime.agents.create({ name, externalId, imageName, instructions, env: [{key,value,secret}], idleTtlSeconds })` (the SDK type lacks `desktop`, `exposedPort`, `healthCheckPath`, `framework`, `useMaritimeLlm`: POST `/api/agents` directly with camelCase JSON `{ name, framework: "custom", imageName, exposedPort: 8080, healthCheckPath: "/health", desktop: true, externalId, initialEnvVars: [{key, value, isSecret}], idleTtlSeconds, instructions }` when you need them), `maritime.agents.chat(id, message, { conversationId })`, `maritime.agents.list({ externalId })`, `maritime.keys.create({ name, scopes })`. Creating an agent debits the wallet. The agent's own exposed port is private; only `/chat` through the API reaches it.

## Composio : `@composio/core` 0.22.0

```ts
import { Composio } from "@composio/core";
const composio = new Composio({ apiKey });
const session = await composio.sessions.create(userId, { toolkits: ["gmail","googlecalendar","googlecontacts"], manageConnections: { enable: true }, mcp: true });
session.mcp.url; session.mcp.headers;      // connect with pi-mcp StreamableHttpTransport({ url, headers })
const tools = await session.toolkits({ isConnected: true }); await session.authorize("gmail"); // returns a redirect URL for the user
const r = await session.execute("GMAIL_FETCH_EMAILS", { max_results: 5 });
```
Meta tools in the session: `COMPOSIO_SEARCH_TOOLS`, `COMPOSIO_MANAGE_CONNECTIONS` (gives OAuth links), `COMPOSIO_MULTI_EXECUTE_TOOL`. Keep the session id per user in state and reuse with `composio.sessions.use(id, { mcp: true })`.

## Conventions

- Prose in docs and prompts: short sentences, plain academic tone, no em-dashes, no AI self-praise.
- Every side effect goes through the policy guard and the audit log.
- Never log secrets. Never put API keys in prompts.
- Keep functions small and typed. Export types from `core`.
