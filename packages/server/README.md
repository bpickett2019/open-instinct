# @open-instinct/server

The agent process. One container, one person. It wires the core runtime to the
optional pieces (Inkbox, computer, apps, trusted network), serves Maritime's BYO
contract over HTTP, and takes Inkbox webhooks directly when self-hosted.

```
POST /chat  ─┐
             ├─> boot(): state, config, policy, approvals, audit, scheduler, contacts, memory
webhooks ────┘      └─> AgentRuntime (Pi) ── tools: core · messaging · files · computer · apps · network
                                └─> outbox: InkboxChannel (iMessage/SMS/email/A2A) or ConsoleOutbox
```

## The BYO contract

Maritime runs any image that follows these rules. This server follows them.

| Rule | Where |
|---|---|
| Bind `0.0.0.0:$PORT` when `PORT` is injected (Maritime sets 18789); loopback for a bare local run | `src/main.ts`, `src/bind.ts` |
| `GET /health` returns 200 JSON | `src/http.ts` |
| `POST /chat { message, source?, conversation_id? }` returns `{ response }` within 30 s | `src/http.ts`, reply budget in `AgentRuntime` |
| State persists under `/data` | `INSTINCT_DATA_DIR`, `resolveDataDir` |
| `python3` on PATH | `deploy/Dockerfile.agent` |
| Optional `GET /schedules` for proactive wakes | `src/http.ts`, `Scheduler.toMaritimeSchedules()` |

Long work: `/chat` waits up to `INSTINCT_REPLY_BUDGET_MS` (default 20 s). If the
model is still working, the response is a one-line acknowledgement and the final
text is sent through the outbox when the run finishes. Nothing is lost.

## Routes

| Method | Path | Auth | Behaviour |
|---|---|---|---|
| GET | `/health` | open | `{ ok: true }` |
| GET | `/` or `/status` | token | agent name, handle, model, conversations, busy, computer kind, connected apps, uptime, `pendingReplies` per chat conversation, `payments.connected` when Link is configured |
| GET | `/schedules` | token | the schedule list in Maritime's shape |
| GET | `/oauth/link/start` | token | `{ url }`: a fresh Link authorize URL; the server keeps the PKCE verifier. 404 without payments. Used by `instinct payments connect` |
| GET | `/payments/status` | token | `{ connected }`. 404 without payments. Used by `instinct payments status` |
| POST | `/chat` | token | Four cases, in this order. (1) `message` starts with `@@instinct-event@@` and the event is `{ type: "link.oauth_callback", code, state }`: the Link wallet handshake is completed, `response` is `""`. (2) The event is `{ type: "system.task", id, prompt, name?, quiet? }`: a task from whoever operates the agent (a front door that wants research done before the first text, a one-off reminder). It runs as the owner on `system:<id>` past the HTTP budget; the result is texted to the owner unless `quiet` is true, and `response` is `""` with `conversationKey` set. A runtime without `runSystemTask` answers `blocked`. (3) Any other envelope is an Inkbox event relayed by the gateway: parsed, handled, reply sent through Inkbox, `response` is `""`. (4) `source` is `"scheduled"`: a Maritime schedule wake, see below. (5) Otherwise the owner is talking on `chat:<conversation_id ?? "default">` and the reply comes back in `response`; replies the runtime finished after an earlier ack on that conversation come back in `pending`. |
| GET | `/oauth/link/callback?code&state` | open | Stripe Link redirects the owner here after they approve the wallet. Completes `wallet.handleCallback` and renders a small "Connected" page. 404 page when payments are not configured, 400 page on a missing code/state, a Link `error`, or a state mismatch. |
| POST | `/webhooks/inkbox` | signature | Raw body. Verifies `X-Inkbox-Signature` (HMAC-SHA256 over `request_id.timestamp.body`, 5 min window). 503 when no signing key is configured, 401 when invalid, else 204 at once and the event is handled in the background. |

Bodies are capped at 1 MiB (413). Bad JSON is 400. Unknown paths are 404. Errors
are JSON and never crash the process.

### Who may call /chat

`/chat`, `/status` and `/schedules` are the owner's surface: a plain message there runs
with the full owner tool set (bash, files, computer, apps, purchases), and an envelope is
trusted as a verified Inkbox event. So they are guarded twice.

1. **Token.** With `INSTINCT_CHAT_TOKEN` set (or `chatToken` passed to `createHttpServer`),
   every call must carry `Authorization: Bearer <token>` or `X-Instinct-Token: <token>`,
   compared in constant time, or it gets `401` before the body is read. Envelopes without
   the token are rejected the same way, so nobody can forge an iMessage "from" the owner's
   number. `/health`, `/webhooks/inkbox` (signed) and `/oauth/link/callback` (state-bound,
   browser redirect) never need it.
2. **Bind address.** Without a token the network is the guard. `main.ts` listens on
   `127.0.0.1` unless `PORT` or a `MARITIME_*` variable says this is a container
   (`INSTINCT_BIND` overrides). Inside a Maritime VM the port is private and only
   Maritime's own authenticated API reaches `/chat`, which is why Maritime's relay works
   without the token (Maritime cannot add our header). `deploy/docker-compose.yml`
   publishes `127.0.0.1:8080`. A warning is logged when the server binds beyond loopback
   with no token.

The Inkbox tunnel never exposes this surface. With `INSTINCT_TUNNEL=1` the server starts a
second, loopback-only listener (`listenTunnelServer`, `tunnelOnly: true`) that answers
`GET /health` and `POST /webhooks/inkbox` and returns `404` for everything else, and points
the tunnel at that. The public `https://<handle>.inkboxwire.com` URL therefore reaches
signed webhooks only. CLI and gateway code that runs its own tunnel should do the same.

### Schedule wakes

Schedules are pushed to Maritime with their prompt, and Maritime wakes a sleeping VM by
posting that prompt to `/chat` with `source: "scheduled"`. The server does not treat this as
the owner typing. It finds the entry (its id anywhere in the message, else an exact prompt
match), checks it is still due (`nextRunAt` within 90 s of now), calls
`scheduler.markRan` and then `runtime.runScheduled(entry)`, which runs the job as the owner
on `scheduled:<id>` and texts the owner the result. The HTTP response is
`{ response: "", acked: true, conversationKey: "scheduled:<id>" }`. Because the in-process
timer also marks an entry before firing it, whichever of the two sees the entry first runs
it and the other acks with `blocked: "already ran"`; a prompt that matches no entry acks with
`blocked: "unknown schedule"` and runs nothing.

## Environment

Only `server`, `gateway` and `cli` read `process.env`. Full list with comments:
[`deploy/.env.example`](../../deploy/.env.example). The ones that change what boots:

| Variable | Effect |
|---|---|
| `INSTINCT_DATA_DIR` | state root; default `/data` if it exists, else `./.instinct` |
| `INSTINCT_MODEL` | `provider/model`; default `anthropic/claude-fable-5-1`; `openai-compatible/<id>` uses `OPENAI_BASE_URL` |
| `INSTINCT_OWNER_NAME/PHONE/EMAIL/TIMEZONE`, `INSTINCT_AGENT_NAME` | seed `config.json` on first boot |
| `INKBOX_API_KEY` + `INKBOX_AGENT_HANDLE` (+ `INKBOX_IDENTITY_ID`) | outbox becomes Inkbox; messaging tools and A2A appear |
| `INKBOX_SIGNING_KEY` | webhook verification (also read from `<data>/secrets/webhook.json`) |
| `INKBOX_ADMIN_API_KEY` | invitations and contact rules; with the tunnel, auto-subscribes the webhook |
| `INSTINCT_TUNNEL=1` | open an Inkbox tunnel to a loopback webhook-only listener and print its public URL |
| `INSTINCT_CHAT_TOKEN` | bearer token for `/chat`, `/status`, `/schedules` (see "Who may call /chat") |
| `INSTINCT_BIND` | bind address override; default loopback, or `0.0.0.0` when `PORT` or `MARITIME_*` is set |
| `INSTINCT_PUBLIC_URL` | this agent's public URL, used to build the Link callback URL |
| `INSTINCT_COMPUTER` | `auto`, `desktopd`, `maritime`, `none` |
| `MARITIME_DESKTOP=1` | injected by Maritime when the VM has a desktop; `auto` then waits up to 60 s for desktopd to start instead of giving up on the first refused probe |
| `MARITIME_API_KEY`, `MARITIME_COMPUTERS_MCP_URL` | hosted computer when no in-VM desktop |
| `COMPOSIO_API_KEY`, `COMPOSIO_TOOLKITS` | Gmail, Calendar, Contacts and more through Composio; the key alone turns apps on |
| `LINK_CLIENT_ID`, `LINK_CLIENT_SECRET`, `STRIPE_PUBLISHABLE_KEY` | all three together turn on payments (Stripe Link agent wallet, `@open-instinct/payments`) |
| `LINK_REDIRECT_URI` | where Link sends the owner back; default `INSTINCT_PUBLIC_URL` + `/oauth/link/callback`, else `http://127.0.0.1:$PORT/oauth/link/callback` |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, ... | provider keys, looked up from the env the server was given (`apiKeyFor`), never from `process.env` behind its back |
| `BRAVE_SEARCH_API_KEY` | better `web_search`; DuckDuckGo otherwise |
| `INSTINCT_SKILLS_DIR` | SKILL.md folder; default `<repo>/skills` |
| `MARITIME_AGENT_ID`, `MARITIME_BACKEND_URL`, `MARITIME_INTERNAL_TOKEN` | injected by Maritime; schedules are pushed to the platform on boot and when they change |
| `PORT` | listen port, default 8080 (Maritime injects 18789; the image sets none) |

Without any Inkbox variables the agent still runs. Replies are printed and kept in
a `ConsoleOutbox`, which is how local development and the smoke test work.

The `chat` channel has no wire of its own: it is the dashboard or CLI waiting on the
HTTP response. Whatever the transport, replies the runtime finishes after `/chat` already
acked are held per conversation (`ConsoleOutbox.chat`, or `ChatAwareOutbox` wrapped around
the Inkbox channel) and handed back as `pending` on the next `/chat` for that conversation.
`GET /status` lists them under `pendingReplies`.

## ChatGPT subscription authentication

The existing Pi runtime can use `openai-codex/<id>` with an eligible ChatGPT subscription,
including Pro. This is Codex subscription access, not paid OpenAI API billing.
Authenticate as the service user against the server's actual persistent data directory:

```bash
instinct auth login --device --data-dir /data
instinct auth status --data-dir /data
instinct auth models --data-dir /data
```

For a local browser use `auth login` without `--device`. Open the printed URL; the
loopback callback completes without typing. A terminal offers hidden manual-code or
redirect-URL input if needed. Device mode prints a verification URI and user code,
then waits for approval. Ctrl-C aborts either flow.

Choose a full ID from `auth models`, set `INSTINCT_MODEL` (or `config.json`
`model.primary`), and restart this server with the same data directory. Login never
switches models or changes configuration. `openai-codex` uses only the private OAuth
store at `<dataDir>/model-auth/auth.json` (0600, parent 0700), never global Codex
credentials or `OPENAI_API_KEY`. There is no paid API fallback. Other providers and
services still need their own credentials.

Status describes locally stored authentication, not live entitlement. The model list
is the installed catalog; neither command sends a model request. OpenAI controls
subscription eligibility, model access, and rate/usage limits. Logout with
`instinct auth logout --data-dir /data`, then restart running servers to clear cached
credentials. This removes only this local login, not global Codex authentication or
the provider session. Authentication is excluded from business exports; protect full
data-directory backups. See [KEYS.md](../../docs/KEYS.md#chatgpt-pro-through-codex-subscription-access).

## Payments

With `LINK_CLIENT_ID`, `LINK_CLIENT_SECRET` and `STRIPE_PUBLISHABLE_KEY` set, `boot` imports
`@open-instinct/payments`, builds a `LinkWallet` on the state dir and registers
`paymentsTools(...)`. The wallet is a Stripe Link agent wallet: the owner approves it once in
a browser and the agent can then ask Link for one-time cards for approved amounts. The
handshake:

1. The owner asks to connect payments. The tool returns `wallet.authorizeUrl()` and the
   agent texts the link.
2. The owner approves on Link. Link redirects to `LINK_REDIRECT_URI`.
3. Either that URI is this server's `GET /oauth/link/callback?code&state`, which calls
   `wallet.handleCallback(code, state)` and shows "Connected", or it is the gateway's
   callback, which relays `{ type: "link.oauth_callback", code, state }` to this agent as an
   `@@instinct-event@@` envelope on `/chat`, and the server completes the same call.

`GET /status` reports `payments: { connected }`. When the package is not installed the
server logs `payments: ... not installed; skipping` and boots without payment tools.

## Programmatic use

```ts
import { boot, createHttpServer } from "@open-instinct/server";

const app = await boot(process.env);          // { runtime, state, config, scheduler, outbox, close, ... }
const server = createHttpServer(app);
server.listen(8080, "0.0.0.0");
```

`boot(env, opts)` accepts `model`, `streamFn`, `outbox`, `logger`, `skillsDir`, `fetchImpl`
and `payments` (a payments module to wire in place of the real import) so tests and
embedders can swap the network out. `createHttpServer(app, opts)` accepts a `signingKey` or a
`signingKeyProvider` for webhooks, `chatToken` for the owner's surface and `tunnelOnly` for
the webhook-only listener; `listenTunnelServer(app, opts)` builds and binds that listener on
loopback. `bindHostFor(env)` is the bind-address rule.

`boot` also hands core two hooks it cannot build itself (core must not import the network
package): `describeDataPart` renders a valid OIP/1 data part on an A2A message into one
paragraph for the model, and `promptExtraFor(principal, channel)` adds `networkGuidance`
for the principal to the system prompt. Both are exported for embedders that build their
own `AgentRuntime`.

Also exported: `ConsoleOutbox`, `ChatAwareOutbox`, `ChatReplyBuffer`, `fileTools` (below),
`createScheduleSync` (the Maritime schedule push), `loadSkillsPrompt`,
`ensureWebhookSubscription`, `paymentsEnv`, `loadPaymentsModule`, `apiKeyFor`.

### File tools

`fileTools(workspace, { bash?, env? })` registers Pi's `read`, `ls`, `grep`, `write`, `edit`
and `bash` with `files.read` / `files.write` capabilities (owner only by default).

- `read`, `ls`, `grep`, `write` and `edit` refuse any `path` that resolves outside
  `<data>/workspace` after following symlinks (absolute paths, `..`, `~`, and links that
  point out of the workspace all return an `isError` result). Pi's own resolver would
  accept absolute paths, which is how `/data/secrets/webhook.json` or another principal's
  session transcript could otherwise be read from the owner conversation.
- `bash` is a real shell with cwd = workspace, not a sandbox. It runs with a small
  allowlisted environment (`PATH`, `HOME`, `LANG`, `LC_*`, `TZ`, `TERM`, `TMPDIR`, ...;
  see `SHELL_ENV_ALLOWLIST`) and nothing whose name matches `KEY`, `SECRET`, `TOKEN`,
  `PASSWORD` or `CREDENTIAL`, so `env` inside the shell never shows a provider or Inkbox
  key. It can still read any file the process user can read, which is why the image runs
  as an unprivileged user and why these tools are visible to the owner tier only.

## Running locally

```bash
pnpm -r build
INSTINCT_OWNER_PHONE=+15551234567 ANTHROPIC_API_KEY=... INSTINCT_CHAT_TOKEN=$(openssl rand -hex 24) node packages/server/dist/main.js
curl -s 127.0.0.1:8080/chat -H "authorization: Bearer $INSTINCT_CHAT_TOKEN" -H 'content-type: application/json' -d '{"message":"hi"}'
```

Without `PORT` the server listens on `127.0.0.1:8080`; the token is optional on loopback
but cheap to set. With an Inkbox identity, add `INKBOX_API_KEY`, `INKBOX_AGENT_HANDLE` and
`INSTINCT_TUNNEL=1`. The server prints the tunnel URL (it serves webhooks only) and, when
`INKBOX_ADMIN_API_KEY` is set, subscribes `imessage.received`, `text.received`,
`message.received` and the A2A events to `<url>/webhooks/inkbox`. The signing key is
stored in `<data>/secrets/webhook.json` (mode 0600).

## Smoke test

`pnpm --filter @open-instinct/server build && pnpm smoke` boots a real agent in a
temp directory with Pi's faux provider (no network, no keys) and checks:

1. Owner chat: "remember that I like window seats" makes the model call `memory_write`;
   `MEMORY.md` contains the text and `/chat` returns the final answer.
2. Stranger iMessage (relayed as an envelope): the model tries `memory_write`, the tool
   is not available to a stranger, the write does not land, and exactly one iMessage
   reply goes out through the outbox for `imessage:<conversation_id>`.
3. `GET /schedules` is `[]`, then a `schedule_create` call makes it non-empty.
4. A stranger's agent sends an A2A task (with an OIP/1 `ask` part) for the owner's calendar.
   The caller resolves to `stranger:a2a:<handle>`, `memory_read` is not available to it, the
   only allowed tool call is `notify_owner`, the owner gets exactly one iMessage through the
   outbox, exactly one A2A reply completes the task with the inbound `replyRef`, and nothing
   from `MEMORY.md` appears in either message.

It exits non-zero on any failed check.

## Tests

`pnpm --filter @open-instinct/server test` runs vitest against a stubbed runtime: every
route (health, status, schedules, owner chat, envelope chat, body limit, 400/404/500,
webhook 503/401/204), the chat token (401 without it, Bearer and header forms, envelope
rejection), the webhook-only tunnel listener (404 for the owner's surface), schedule wakes
(run once on `scheduled:<id>`, never as owner chat, acked when already run), pending chat
replies, the Link callback route and envelope, the bind-address rule, the Maritime schedule
sync, the console outbox, the file tool guards (paths outside the workspace, symlinks, the
scrubbed shell environment), the payments loader, the webhook subscription setup and the
skills loader.

## Docker

`deploy/Dockerfile.agent` builds this package into `ghcr.io/<owner>/open-instinct-agent`.
The image sets no `PORT` (Maritime injects 18789; compose sets 8080), runs the server as
the unprivileged `instinct` user through `deploy/entrypoint.sh` (which fixes `/data`
ownership and drops privileges with `setpriv`), and health-checks `${PORT:-8080}`.
`deploy/docker-compose.yml` runs it next to the gateway for a local trial, publishing the
agent on `127.0.0.1:8080` only.

## Durable business commitments

Business mode uses `BusinessCommitments` and the coordinator's single nonoverlapping
sweep. It does not start a second scheduling timer. Personal-mode schedules keep
their existing behavior. Business `schedule_create/list/delete` use versioned
commitments, durable occurrence keys, owner authority and the same task dispatcher.
Admission is not completion; an occurrence completes only with task outcome evidence.

The four visible standing routines are incoming requests, follow-through, daily
brief and meeting preparation. They start disabled. Only an authenticated direct
owner turn can enable or edit them. Select connected account IDs and source scopes
explicitly. Enabling incoming requests records an activation time; connecting an
account alone never authorizes historic mailbox processing. Historical research
requires a separate owner request. Editing a routine revokes its previous authority.

Customer follow-through defaults to two unanswered chases, 72 elapsed hours apart,
Monday through Friday from 09:00 to 17:00 in the configured IANA timezone. Owners
can edit contact hours and elapsed interval; workers cannot widen these rules.
Quiet hours shift execution, not the meaning of elapsed hours. After downtime,
each due commitment receives one fresh premise check, not a burst of missed sends.
Replies, opt-outs, owner intervention, source changes, cancelled work, changed
availability and disabled or substituted accounts suppress stale follow-through.
The Google bridge re-reads the live thread before effects; unavailable verification
does not authorize a chase.

Owner cancellation requires the current record version and fences outstanding
occurrence work. Already accepted provider effects cannot be recalled. Durable waits
end model turns; workers never hold model calls open for hours.

Integration exports are `createBusinessCommitmentTools`, `BusinessCommitments.sweep`,
`assertDispatch`, `cancelForTask`, `sweepGoogleRoutines` and `recheckGooglePremise`.
The coordinator owns lifecycle and invokes the sweep and pre-dispatch hooks.
`test/business-commitments.test.ts` uses a controllable clock and the real SQLite
store/coordinator for authority, event ordering, restart, downtime and suppression
regressions. Those tests do not establish live-provider delivery.

## Owner workspace and browser evidence

Business mode serves the framework-free owner application at `/workspace` on the
controller listener, never the webhook tunnel. Set a nonempty `INSTINCT_CHAT_TOKEN`
and canonical `INSTINCT_WORKSPACE_ORIGIN` such as `https://assistant.example.test`.
Plain HTTP is allowed only for an explicit loopback origin with
`INSTINCT_WORKSPACE_ALLOW_HTTP=1`. Production requires HTTPS and persistent storage.

The sign-in form exchanges the token through `POST /api/owner/session`. The server
keeps only hashes of opaque session cookies in memory. Production cookies are
host-only `__Host-` cookies with Secure, HttpOnly and SameSite=Strict; loopback
development uses a different cookie name. Sessions expire after 24 hours absolute
or 30 minutes without authenticated requests. Restart invalidates browser sessions,
not admitted work. Tokens are not saved in browser storage. Session cookies never
authenticate legacy `/chat`, `/status` or `/schedules` bearer routes.

Owner API mutations require the exact origin, JSON and the session CSRF header.
Tasks, profile, sources, settings, routines and connection changes use expected
versions. Resume also checks the current settings version. Priority stop always
fences future work, including when the initiating tab is stale. Already dispatched
external effects may finish and remain visible. The computer's separate privacy
release requires an explicit owner attestation and a provider mode check.

Overview and Settings project the same durable allowance balances: accounted
usage, held reservations, optional owner limit and remaining amount. Purchase
amounts use business-currency minor units; model amounts always use USD cents.
Unconfigured limits are not zero-dollar caps. Unknown usage or pricing has no
numeric remaining balance and is explicitly not free. No exchange rate or default
owner cap is invented. Changing purchase currency cannot reinterpret prior spend
or held purchase reservations.

The application reads actual task/action, source/artifact, connection, notification
and settings services. Browser messages use client idempotency keys and
non-destructive monotonic cursors, polled every two seconds while visible with
offline backoff. Browser reads never settle carrier delivery. Downloads are
attachments addressed by opaque artifact IDs, not controller paths. Uploaded
content is displayed as text, not active HTML. Files and Knowledge share originals
and version history; deletion discloses retained evidence and backups.

Owner texts are brief, conversational updates, without task-ID prefixes or internal
handoff notes. Keep diagnostics in `task_checkpoint` and the task evidence view.
`task_finish.result` is the owner-facing completion channel. `task_wait.question`
is permitted only for owner-actionable `missing_information`, `provider_challenge`
and `connection` waits; reconciliation/timer/external-event/constraint waits stay
silent. Do not also send the same status through `send_message`. Durable notification
IDs prevent replay of accepted or uncertain notifications across restart; this does
not semantically deduplicate independently authorized message actions.

Missing artifact/source records, including IDs from another workspace, return 404.
A registered artifact whose original bytes are missing or corrupt remains a 500
operation failure, not a fabricated missing record. Browser admission waits for the
durable task ID and state, not particular acknowledgement wording; signed webhook
admission returns 204 while work continues asynchronously.

`pnpm --filter @open-instinct/server build` compiles `web/` into `dist/web` through
`tsconfig.web.json` and copies the external stylesheet with the portable
`scripts/copy-web-assets.mjs`. Assets resolve relative to the server module, not cwd.
After the normal integrated build, install Chromium and run `pnpm test:e2e`.
Vitest only discovers `test/**/*.test.ts`, not Playwright specs.

Playwright drives the real controller and compiled application with fresh local
provider state. Both 1440×1000 desktop and 390×844 mobile projects cover the thirteen
required screens in light and dark mode, plus empty, validation, offline, expired,
disconnected, unknown and stopped states. Checkpoints follow semantic assertions.
No screenshots are pre-generated or used as invented pixel baselines.

`e2e/customer-lifecycle.spec.ts` adds provider/document checkpoints without replacing
the original screen matrix. It uploads authoritative rates through the browser,
delegates a quote in owner chat, compares downloaded PDF bytes and extracted content
with the independently stored Gmail MIME attachment, and displays persisted send
evidence after refresh. It also exercises reply-before-follow-up suppression after
restart, Calendar insert/update/cancel readback and stale-etag protection, direct
stop during a gated model turn, and accepted-but-unseen Gmail reconciliation without
a second send. Every flow runs on both viewports in both themes.

The additional screenshot IDs are `quote-gmail-verified`, `quote-pdf-download`,
`followup-suppressed`, `calendar-lifecycle`, `calendar-conflict`,
`provider-stop-persisted`, `gmail-reconciling` and `gmail-reconciled`; filenames in
`evidence/screenshots/` are `<desktop|mobile>-<light|dark>-<id>.png`.
The shared `testing/document-lifecycle.ts` scripts only model decisions; real
registered tools produce the artifacts, provider changes and durable receipts.
These are emulator-backed orchestration and real-browser UI checks, not live
Google or hosted LibreOffice execution. After an integrated build, target the new
flow with `pnpm --filter @open-instinct/server exec playwright test --config playwright.config.ts e2e/customer-lifecycle.spec.ts`.
The full `pnpm test:e2e` run is still required for matrix completeness.

`test/scenarios/calendar-read.test.ts` exercises the production tool/coordinator
against stateful Calendar fixtures: local-day bounds, all-day timezone boundaries,
overlaps, ordered pagination, and explicit recurring instances. Recurrence fixtures
declare their complete supported window; unsupported or out-of-window expansion
fails rather than returning a misleading empty schedule. This is not an RRULE engine.
Malformed filters are rejected before any provider call, including null bounds that
the SDK would otherwise remove during argument normalization.

The runner writes `evidence/index.html`, `evidence/manifest.json`,
`evidence/screenshots/`, `evidence/traces/*.redacted.zip`,
`playwright-report/index.html`, `playwright-report/results.json` and private
`test-results/`. The manifest names missing checkpoints; CI fails if required
evidence is missing. Set `INSTINCT_CHANGED_PATHS` to newline-separated changed
source paths to prioritize affected cases. Missing or unmapped paths show the
complete gallery. Raw trace attachments are removed before HTML/JSON reporters
serialize them. Public trace exports remove credential fields and body resources;
the failure index links only sanitized ZIPs and the actual failure screenshot,
not an earlier successful checkpoint. Redaction/capture failure fails the evidence
gate. CI uploads only explicitly allowlisted report files, evidence PNGs and
sanitized trace ZIPs, never SQLite, browser auth state, downloads or raw ZIPs.

After the parent integration build, run from the repository root:

```bash
pnpm --filter @open-instinct/server exec playwright install chromium
pnpm --filter @open-instinct/server exec vitest run test/workspace-http.test.ts test/evidence-redaction.test.ts
pnpm test:e2e
INSTINCT_EVIDENCE_NEGATIVE_CASE=1 pnpm --filter @open-instinct/server exec playwright test --config playwright.config.ts --grep "intentional semantic assertion failure"
```

The final command must exit unsuccessfully: it deliberately expects two delegation
controls in a real fresh workspace that has one. It writes separate
`evidence-negative/`, `playwright-report-negative/` and `test-results-negative/`
directories so it cannot overwrite the complete gallery. Inspect its report,
failure screenshot and redacted trace; verify no session cookies, CSRF values,
bearer tokens or private response bodies survived. This is an opt-in failed
assertion, not a production fault or a routine CI test.

Required visual inspection: open the changed-case index, then every desktop/mobile
light/dark checkpoint. Check login and form labels, task IDs and action evidence,
long source/version content, downloads, private takeover disclosure, allowance
accounted/held/remaining labels and unknown/unconfigured states. On 390-pixel mobile,
confirm no horizontal overflow and that stop/resume, navigation and form actions
remain reachable. Inspect validation, offline/stale, expired authentication,
disconnected provider, unknown action and globally stopped screenshots for honest
status text and readable contrast. A generated manifest or screenshot count alone
does not establish these visual checks passed.

Local provider fixtures establish orchestration contracts; rendered browser evidence
does not establish live Google/Inkbox/Maritime behavior or real-model reliability.
