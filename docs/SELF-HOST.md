# Self-hosting Open Instinct

This guide runs one Open Instinct agent on a machine you control. That can be your laptop, a home server, or a VPS. Nothing here needs Maritime hosting. The agent is one Node process, one data directory, and (optionally) one Inkbox identity so you can text it on iMessage.

Open Instinct is unrelated to OpenInstinct, a separate project published by Merit Systems.

Analogy: the agent is a person who works from home. Inkbox is their phone line. The data directory is their filing cabinet. This guide sets up the home office.

## Contents

1. [What you need](#what-you-need)
2. [Install](#install)
3. [Step 1: `instinct init`](#step-1-instinct-init)
4. [Step 2: `instinct dev --tunnel`](#step-2-instinct-dev---tunnel)
5. [How the tunnel gives you a public webhook URL](#how-the-tunnel-gives-you-a-public-webhook-url)
6. [Step 3: connect your iPhone](#step-3-connect-your-iphone)
7. [Docker Compose](#docker-compose)
8. [Where state lives](#where-state-lives)
9. [Backups](#backups)
10. [Updating](#updating)
11. [The computer: none, or hosted](#the-computer-none-or-hosted)
12. [Keeping the owner surface private](#keeping-the-owner-surface-private)
13. [Environment variables](#environment-variables)
14. [Troubleshooting](#troubleshooting)

## What you need

| Item | Why | Required |
|---|---|---|
| Node >=22.22.3 and pnpm 10.6.1 | runs the agent and the CLI | yes |
| A model key (`ANTHROPIC_API_KEY`, or `OPENAI_API_KEY` with `OPENAI_BASE_URL`), or eligible ChatGPT subscription authentication below | the model behind the agent | yes |
| An Inkbox admin key (`INKBOX_ADMIN_API_KEY`) from the Inkbox console | gives the agent an iMessage line, email and A2A endpoint | for iMessage |
| A Maritime key (`MARITIME_API_KEY`) with the `computers` scope | a hosted Linux desktop the agent can drive | for computer use |
| Docker | only for the Compose path | no |

Personal texting can use outbound HTTPS and the webhook-only Inkbox tunnel without a domain. Business mode also needs an always-on persistent controller and an independently secured HTTPS owner workspace origin; the webhook tunnel does not expose that workspace.

## Install

```bash
git clone https://github.com/mariagorskikh/open-instinct && cd open-instinct
pnpm install && pnpm -r build
```

Run the CLI from inside the repo:

```bash
pnpm --filter @open-instinct/cli exec instinct --help
```

Or link it so `instinct` is on your PATH:

```bash
cd packages/cli && pnpm link --global && cd ../..
instinct --help
```

The rest of this guide writes `instinct ...` and assumes one of those two.

## Step 1: `instinct init`

`init` writes `config.json` into the data directory. With `INKBOX_ADMIN_API_KEY` in the environment it also creates the agent's Inkbox identity.

```bash
export ANTHROPIC_API_KEY=sk-ant-...
export INKBOX_ADMIN_API_KEY=ApiKey_...

instinct init --name "Maria" --phone +14155550100 --email maria@example.com \
  --handle maria-instinct --timezone America/New_York
```

What each flag does:

| Flag | Meaning |
|---|---|
| `--name` | your name. Required |
| `--phone`, `--email` | how the agent knows a message is from you, the owner |
| `--handle` | the agent's Inkbox handle. People will text `connect @maria-instinct` |
| `--timezone` | used in prompts and schedules |
| `--model` | `provider/model-id`. Default `anthropic/claude-fable-5-1` |
| `--skip-inkbox` | write config only, even when an admin key is set |

With the admin key, `init` does five things on Inkbox:

1. Creates the identity `@maria-instinct` with iMessage enabled.
2. Mints an identity-scoped API key. This is the key the agent process runs with.
3. Creates the webhook signing key.
4. Saves all of it to `<dataDir>/secrets/inkbox.json` with mode 0600.
5. Prints the connect instructions.

If the handle is taken, Inkbox gives you `maria-instinct-2` and `init` saves that name. If your Inkbox plan is full, `init` stops with the plan limit error and the billing URL. See [INKBOX.md](INKBOX.md#plan-limits).

Running `init` again updates the existing config. It does not wipe anything.

### Use a ChatGPT Pro subscription instead of a model API key

ChatGPT subscription access through Codex is separate from paid OpenAI API billing.
Keep the existing agent and its data directory:

```bash
instinct auth login --data-dir .instinct
# For SSH or a headless server, use this instead:
instinct auth login --device --data-dir .instinct
instinct auth status --data-dir .instinct
instinct auth models --data-dir .instinct
```

Open the browser URL and finish signing in. The callback needs no terminal input.
If it cannot reach the CLI, the terminal supports a hidden manual code/redirect URL.
Device mode displays a verification URL and one-time user code and waits for approval.
Ctrl-C cancels. Never pass credentials or authorization codes as arguments.

Choose an `openai-codex/<id>` printed by `auth models`, export it as `INSTINCT_MODEL`
or set `config.json` `model.primary`, and restart the existing server with the same
`--data-dir`. Login prints selection guidance but never changes your
configuration. There is no paid API fallback for `openai-codex`; other configured
model providers and external services still require their own credentials.

Login uses only `<dataDir>/model-auth/auth.json` (0600 in a 0700 directory).
Existing global Codex logins are not imported, overwritten, or removed. `auth status`
is local metadata, not a live entitlement check; `auth models` is the installed
catalog. Neither sends a model request. OpenAI controls account eligibility, model
availability, and subscription usage/rate limits.

Use `instinct auth logout --data-dir .instinct` to remove this local login, then
restart running servers. This does not revoke the provider session or log out
global Codex. Business exports exclude authentication; full directory backups must
be treated as secrets. See [KEYS.md](KEYS.md#chatgpt-pro-through-codex-subscription-access).

## Step 2: `instinct dev --tunnel`

`dev` runs the agent server in the current process. No Docker. No Maritime.

```bash
instinct dev --tunnel
```

Expected output:

```
Open Instinct is running on http://127.0.0.1:8080  (data: /Users/maria/.instinct)
  tunnel: https://maria-instinct.inkboxwire.com
  webhook: subscription whs_8f2 (new)
```

`dev` loads `secrets/inkbox.json` into the environment, so you do not export `INKBOX_API_KEY` yourself. Ctrl-C closes the tunnel, the server and the agent cleanly.

Flags:

| Flag | Meaning |
|---|---|
| `--port 8080` | local port. Default 8080 |
| `--host 127.0.0.1` | bind address. `dev` defaults to `0.0.0.0`, so pass this on a shared machine or set a chat token |
| `--tunnel` | open the Inkbox tunnel and subscribe the webhook |
| `--quiet` | less log output |
| `--data-dir <dir>` | use another data directory |

Without `--tunnel` the agent still runs. You can talk to it from a second terminal:

```bash
instinct chat "remember that I like window seats"
instinct status
```

But iMessage cannot reach it. Inkbox needs a public URL to post events to. That is what the tunnel provides.

## How the tunnel gives you a public webhook URL

Inkbox posts every inbound message to your agent as an HTTP webhook. A laptop behind a home router has no public address. Instead of opening a port, the agent opens an outbound connection to Inkbox, and Inkbox forwards traffic back down it.

Analogy: you cannot receive mail at a desk in a coworking space. So you rent a mailbox at the front desk, and the receptionist walks letters to you.

Step by step:

1. `instinct dev --tunnel` sets `INSTINCT_TUNNEL=1`.
2. The server starts a second listener on loopback that answers only `GET /health` and `POST /webhooks/inkbox`. Everything else on that listener is 404.
3. The CLI opens an Inkbox tunnel with the identity key and the handle. Every identity owns the host `https://<handle>.inkboxwire.com`. The tunnel is outbound HTTP/2, so it works from inside any network that allows HTTPS out.
4. With `INKBOX_ADMIN_API_KEY` set, the CLI subscribes the identity's webhooks to `https://<handle>.inkboxwire.com/webhooks/inkbox`. An existing subscription for the same URL is reused. The signing key is stored in `<dataDir>/secrets/webhook.json`.
5. Without the admin key, the CLI prints the URL and you create the subscription yourself in the Inkbox console or with the API. See [INKBOX.md](INKBOX.md#webhooks-and-signing-keys).

Two safety points:

- The tunnel never exposes `/chat`, `/status` or `/schedules`. Those are the owner's surface and stay on your local port only.
- Every webhook is checked against the signing key before the agent reads it. A bad or missing signature gets 401. A missing key gets 503.

## Step 3: connect your iPhone

```bash
instinct connect
```

Output:

```
Connect your iMessage
  1. Text connect @maria-instinct to +1 415 555 0199
  2. A new thread from your Instinct appears. Say hi.
  Tap-to-text link: sms:...
  QR code written to /Users/maria/.instinct/connect-qr.png
```

Inkbox runs a shared iMessage router number. You text `connect @handle` to it once. From then on you have a normal iMessage thread with your agent. The first message must come from you. The agent on the shared line cannot text a stranger first. Details are in [INKBOX.md](INKBOX.md#the-shared-router-and-connect-handle).

## Docker Compose

The Compose path runs the same server in a container. It is a good fit for a VPS.

```bash
cp deploy/.env.example deploy/.env
# fill in the model key, owner fields and Inkbox values
docker compose -f deploy/docker-compose.yml up --build
```

The agent answers on `http://127.0.0.1:8080`. The port is published on loopback only.

How it maps:

| Compose setting | Value | Meaning |
|---|---|---|
| `PORT` | `8080` | the port inside the container |
| `INSTINCT_DATA_DIR` | `/data` | state, on the `agent-data` volume |
| `INSTINCT_SKILLS_DIR` | `/app/skills` | the SKILL.md playbooks copied into the image |
| `env_file` | `deploy/.env` | every other variable |
| `restart` | `unless-stopped` | comes back after a reboot |

Notes for this path:

- The container runs as the unprivileged `instinct` user. The entrypoint only uses root to make `/data` writable, then drops privileges.
- Without Inkbox keys the agent still runs. Replies go to the container log (`docker compose -f deploy/docker-compose.yml logs -f agent`).
- To receive iMessage in a container, set `INSTINCT_TUNNEL=1` in `deploy/.env` along with the `INKBOX_*` values. The server opens the tunnel itself and, with `INKBOX_ADMIN_API_KEY`, subscribes the webhook.
- Set `INSTINCT_CHAT_TOKEN` in `deploy/.env` if anything beyond this machine should reach `/chat`. See [Keeping the owner surface private](#keeping-the-owner-surface-private).
- The `gateway` service in the same file is for the multi-user shape. It needs `--profile gateway` and is not part of a single-person self-host. See the [gateway README](../packages/gateway/README.md).

To run `instinct` commands against the container's data, point them at the same directory. The simplest way is to run the CLI on the host with `--data-dir` set to a bind mount, or to keep the CLI's `.instinct` for `init` and copy `secrets/inkbox.json` values into `deploy/.env`.

Subscription login must run against the same persistent data directory the container
uses, as its service user. A host-side login into another `.instinct` directory is not
visible inside `/data`. Prefer device login for containers; do not mount your global
Codex credentials or inject OAuth tokens through Compose environment variables.

## Where state lives

Everything is in one directory. The CLI default is `./.instinct`. The server default is `/data` when that directory exists, else `./.instinct`. `INSTINCT_DATA_DIR` or `--data-dir` overrides both.

| Path | What it holds | Written by |
|---|---|---|
| `config.json` | owner (name, phones, emails, timezone), agent name and handle, model, feature flags | `init`, first boot |
| `secrets/inkbox.json` | identity key, identity id, signing key, handle. Mode 0600 | `init` |
| `secrets/webhook.json` | webhook subscription id, URL, signing key. Mode 0600 | `dev --tunnel`, server |
| `contacts.json` | people, their phones, emails, agent handles and tiers | `invite`, `trust set`, the agent |
| `policy.json` | tiers, grants, spend limits | `trust grant`, `trust revoke`, the agent |
| `schedules.json` | cron and one-shot jobs | `schedules`, the agent |
| `approvals.json` | pending owner approvals | the agent |
| `memory/MEMORY.md` | durable memory, plain Markdown | the agent |
| `memory/journal/` | one file per day | the agent |
| `sessions/` | Pi JSONL transcripts, one per conversation | the agent |
| `audit.jsonl` | append-only log of every side effect | the agent |
| `workspace/` | files the agent makes for you | the agent |
| `inbox/` | files you sent to the agent | the agent |
| `maritime.json` | the deployed agent id, only after `instinct deploy` | `deploy` |
| `connect-qr.png` | the connect QR | `connect` |

Two rules worth knowing:

- `config.json` wins over the environment after the first boot. Env seeds it; it does not override it later. To change the owner or the model, run `init` again or edit the file.
- Memory is Markdown. You can open `memory/MEMORY.md` and read or fix it by hand.

## Backups

The full-directory archive instructions below are for a stopped personal agent.
Do not tar a live business SQLite/WAL directory. Use the consistent business
snapshot command in [Business-owner operation](#business-owner-operation).

What matters most:

| File | If lost |
|---|---|
| `secrets/inkbox.json` | the agent cannot send or receive. Inkbox shows the identity key and signing key only once. You would mint new ones with the admin key |
| `secrets/webhook.json` | the server cannot verify webhooks until it mints a new signing key |
| `memory/`, `sessions/`, `audit.jsonl` | the agent forgets, and you lose the record of what it did |
| `contacts.json`, `policy.json` | the trusted network and grants are gone |

Local run:

```bash
tar czf instinct-backup-$(date +%F).tgz -C "$(dirname "$INSTINCT_DATA_DIR")" "$(basename "$INSTINCT_DATA_DIR")"
```

Docker Compose keeps `/data` on a named volume. Compose names it after the project, which defaults to the directory name, so look it up first:

```bash
docker volume ls | grep agent-data
docker run --rm -v deploy_agent-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/instinct-backup-$(date +%F).tgz -C /data .
```

Store the archive somewhere encrypted. It contains API keys.

Restore is the reverse: stop the agent, unpack into the data directory (or the volume), start it again. Keep file modes: `secrets/` should be 0700 and the files inside 0600.

## Business-owner operation

Initialize a separate state directory with `instinct init --business`. This enables
full autonomy for authenticated owner tasks and enabled owner routines, not contacts,
email senders or groups. Ordinary authorized sends, bookings and computer actions
need no fresh yes. Actual owner restrictions still apply. Missing facts, contradictions,
OAuth/MFA/CAPTCHA and provider payment consent remain genuine blockers. Stripe Link
requires its own per-purchase consent. Existing personal approvals are never migrated
into permission to run old work.

Use an always-running process supervisor and persistent **local** filesystem for
`business/business.sqlite`, its WAL and immutable `business/artifacts/`. No shared
network mount. Do not run the controller inside its arbitrary-shell desktop. Set a
separate `MARITIME_COMPUTER_API_KEY`; business mode forces hosted Maritime and disables
controller bash while retaining bounded file/PDF tools. Only required task files go
to the desktop. Its browser sessions are still sensitive. Verify a real computer
action, not just provisioning, before declaring entitlement.

If setting `business.stateDirectory`, keep it disjoint from `<state>/workspace`:
neither directory may contain the other, including through symlink aliases.
Startup rejects overlap before creating the controller database. A sibling such
as `<state>/workspace-private` is valid; a symlink used as the state directory is not.

Configure `INSTINCT_WORKSPACE_ORIGIN` with the canonical HTTPS owner origin, a nonempty `INSTINCT_CHAT_TOKEN`, TLS and an
owner-only reverse proxy route. `/workspace` uses a short-lived HttpOnly browser
session; CLI bearer authentication stays separate. Never put the token in a URL,
browser storage or public configuration. Keep the signed webhook listener restricted
to its existing health/webhook routes. Production HTTP and sleeping controllers are
not accepted as continuous business operation.

### Owner-led conversation, assistant-led setup

Once the operator has provisioned the controller and texting identity, the owner
can begin in the assistant's text thread or `/workspace`. The app opens the shared
conversation and the assistant starts with a contextual welcome or continuation;
the owner does not need to invent a starter prompt. Answer naturally, provide
several facts at once, ask a question, or change direction. The assistant saves
only explicit owner facts and chooses a useful follow-up, not a fixed field order.
The same profile and conversation survive refresh and restart. Saved facts,
citations, app connections, and advanced edits remain secondary, collapsed controls.
Normal work does not require completing a setup questionnaire.

Opening the app is read-only model guidance, not permission to save facts, connect
apps, delegate tasks, or resume stopped work. The welcome is durably deduplicated
across tabs and restarts. If its model turn is interrupted, the app reports that
instead of replaying it; the owner can continue with an ordinary message.

Gmail and Google Calendar have named connection steps with their purpose and
current readiness. When chosen, the assistant supplies the actual private sign-in
link and checks for independently verified account identity automatically. The
owner does not need to type “done” or “sent.” Connecting does not turn on routines
or scan old messages. To change an already connected account, disconnect it first.
An outstanding upstream revocation is not silently treated as complete.

Missing Composio or hosted-computer infrastructure is operator setup, not an
owner password/API-key request. The UI and conversation remain usable while those
capabilities are unavailable. Never fabricate a sign-in link or ask the owner to
put credentials in chat. Local evaluation and emulator checks do not establish
full live-provider readiness.

### Private owner iMessage feedback

Use the assistant's direct iMessage thread, not the provider's routing contact.
Once a known-private owner message is durably admitted, the assistant marks it
read and sends bounded typing indicators while composing. It can acknowledge with
a tapback instead of sending another text; reactions are chosen conversationally,
not added to every message. Group read/typing and SMS feedback are unsupported.
Web chat and the automatic onboarding welcome do not create iMessage feedback.

Read receipts and foreground reactions retain durable attempt records. An
uncertain carrier response is not retried after restart. Feedback failure does
not block the answer or stop controls, and stop/shutdown fence further typing.
Provider acceptance is not proof that the recipient's phone displayed an
indicator. To check a configured installation, send a fresh private owner message
asking for a thumbs-up and observe the phone's read status, transient typing and
tapback. Do not treat emulator screenshots as live phone evidence.

### Deterministic controls

Controls are deterministic: `instinct business status`, `tasks`, `task <id>`,
`pause`, `resume`, `stop <id>` and `close <id>`. `stop` without an ID is global.
Use `INSTINCT_CHAT_TOKEN` for local and remote `--url https://<owner-origin>` calls.
`--agent` authenticates to Maritime, not automatically to the controller's separate
bearer check; if the relay cannot satisfy that check, use direct HTTPS, never a
tokenless bypass. Text/web use the same durable service. Pause fences future dispatch,
not already accepted provider operations or already-running remote shell commands.

Business purchase and model limits are optional; an unconfigured owner cap is not
silently replaced with a personal-mode default. The workspace displays accounted
usage, unresolved holds and remaining allowance. Configured model limits fail closed
when pricing is unknown, including the separate image-generation endpoint; without
a cap, image usage is explicitly marked unknown cost, never free usage.

Customized saved owner spend restrictions remain effective, including timezone-local
daily limits and merchant restrictions. Legacy personal default amounts are not
imported as implicit business caps. To impose a business cap equal to a legacy
default, set it explicitly in workspace settings. Unknown purchase amounts or
currencies cannot bypass a configured cap. Stop does not undo charges or messages
already accepted upstream; unresolved actions retain evidence and holds for
reconciliation rather than being blindly replayed.

Notification transport is also journaled by logical task/event/message identity.
An interrupted send becomes `unknown` on restart and is not automatically resent.
Never treat a missing carrier response as proof that the recipient received nothing.
Successive missing-information waits consume distinct persisted events, so an old
answer cannot silently satisfy a later question.

Before enabling live work, complete the isolated scenarios in
[the acceptance record](business-owner/ACCEPTANCE.md). Emulator contracts and browser
screenshots do not prove provider entitlement, recipient delivery or remote-shell
isolation. Use authorized test accounts and consenting recipients, never production
appointments or customers. Do not paste credentials into ordinary business files.

### Snapshot, export and restore

For CLI recovery, first pause work, then stop the controller process. A process
ownership lock rejects concurrent controllers and recovery operations. It is an
OS-held SQLite mutex, released on crash; do not delete lock files to bypass it.
Use private directories outside business state:

```bash
instinct business backup --destination /private/instinct-backups --retention 7
instinct business export --destination /private/instinct-export.json
instinct business restore --source /private/instinct-backups/<snapshot-id> \
  --destination /private/restored-business
```

Backup uses a consistent SQLite snapshot plus a hashed manifest and copies of immutable
artifact bytes. `--retention 7` keeps seven completed snapshots for that workspace in
that backup directory. Incomplete snapshots are not usable. Retention prunes only that
directory, not offsite copies. The workspace's backup operation uses a server-configured
private destination; raw backups are never public downloads. Protect/encrypt backups
as private business data and test recovery on an isolated host.

Export is JSON containing profile, knowledge, artifact metadata and active file bytes,
tasks, actions and visible messages. It excludes configuration, credential stores,
cookies and browser sessions, and redacts credential-named structured fields. Uploaded
business documents may themselves contain private information: review exports before
sharing. Export is not a restorable backup. Large exports fail explicitly rather than
silently dropping files; use an operator backup for larger workspaces.

Restore accepts a fresh directory, or a stopped directory with no running controller.
It retains the replaced directory under a `.pre-restore-<id>` name. It always sets
global stop, blocks nonterminal tasks, cancels pending waits/prepared effects, disables
routines/authorities/connections, and marks unresolved attempted effects unknown.
Reconfigure credentials independently. A snapshot may predate effects that actually
happened: inspect and reconcile provider history **since its snapshot time** and any
outstanding computer operations. Do not run the original and restored workspace at
the same time. Resume does not clear investigation blockers or replay prior work.
Re-enable only reviewed routines and deliberately admit new work after reconciliation.

Selective deletion removes knowledge from active retrieval; retained action evidence
and backups are disclosed, not called erased. Full business deletion is deliberately
offline: pause, disconnect every provider and request upstream revocation, log out the
separate hosted browser, stop the controller, then run
`instinct business delete --confirm-workspace <workspace-uuid>`.
This deletes the business directory only. Configuration/secrets elsewhere, old backups,
pre-restore directories and third-party records require separate owner administration.
It is not a worker tool and does not promise immediate third-party erasure.


## Updating

Local run:

```bash
git pull
pnpm install && pnpm -r build
# restart instinct dev
```

Docker Compose:

```bash
git pull
docker compose -f deploy/docker-compose.yml up --build -d
```

State lives outside the code, so an update never touches the data directory. Run `instinct status` after a restart to confirm the agent name, model and computer kind are what you expect.

## The computer: none, or hosted

Personal mode may use an in-VM desktop or hosted computer as described below.
Business mode always uses a separate hosted Maritime computer and a separate computer
credential; it never auto-selects controller-local desktopd.

| Mode | Set | What happens |
|---|---|---|
| No computer | `INSTINCT_COMPUTER=none` | the agent has no `computer` tools. It still texts, emails, reads Gmail and Calendar through Composio, runs schedules, and talks to other Instincts |
| Hosted computer | `MARITIME_API_KEY=mk_...` and `INSTINCT_COMPUTER=auto` (the default) or `maritime` | the agent uses Maritime Computers over MCP. Maritime keeps one persistent desktop for you behind `https://mcp.maritime.sh` |

How `auto` decides: it probes for an in-VM desktop first. On your own machine there is none. If `MARITIME_API_KEY` is set, it uses the hosted computer. Otherwise it runs with no computer. Nothing fails; the tool set is just smaller.

Hosted computer details:

- The key needs the `computers` scope. Mint it in the Maritime dashboard.
- `MARITIME_COMPUTERS_MCP_URL` changes the endpoint. Default `https://mcp.maritime.sh`.
- The first call creates the desktop and can take up to 60 seconds. A sleeping desktop wakes in a few seconds.
- A `402 no_plan` means the Maritime account has no Computers plan. The key being valid does not prove the plan exists. Test with one real action.
- Logins, 2FA and payments are yours. The agent calls `request_takeover` and texts you a viewer link. You do the step in a browser and click Done. The agent sees nothing while you are in control.

More in the [computer package README](../packages/computer/README.md).

## Keeping the owner surface private

`POST /chat`, `GET /status` and `GET /schedules` run with the full owner tool set. Anyone who can reach them is you, as far as the agent is concerned. Two guards exist.

1. Bind address. A bare `node packages/server/dist/main.js` with no `PORT` listens on `127.0.0.1` only. `instinct dev` also binds `127.0.0.1` unless you pass `--host 0.0.0.0`. Compose publishes `127.0.0.1:8080` on the host, so the container port is not reachable from outside.
2. Token. Set `INSTINCT_CHAT_TOKEN` to a random string. Every call must then send `Authorization: Bearer <token>` (or `X-Instinct-Token: <token>`) or it gets 401.

```bash
export INSTINCT_CHAT_TOKEN=$(openssl rand -hex 24)
instinct dev --host 127.0.0.1 --tunnel
```

`instinct chat` and `instinct status` read `INSTINCT_CHAT_TOKEN` from the environment and send it as `Authorization: Bearer <token>`, so export the same value in the shell you run them from. Any other client sends the header itself:

```bash
curl -s http://127.0.0.1:8080/chat \
  -H "Authorization: Bearer $INSTINCT_CHAT_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"message":"hi"}'
```

Or keep the token off and leave `instinct dev` on loopback. On a laptop that is enough. On a VPS, set the token.

The tunnel does not change any of this. It carries signed webhooks only and never reaches `/chat`.

## Environment variables

Every variable below is read by the server or the CLI. `deploy/.env.example` lists them with comments. `config.json` wins over most of them after the first boot.

| Variable | Read by | Meaning |
|---|---|---|
| `INSTINCT_DATA_DIR` | server, CLI | the data directory |
| `INSTINCT_MODEL` | server | `provider/model`. Default `anthropic/claude-fable-5-1`. `openai-compatible/<id>` uses `OPENAI_BASE_URL` |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENAI_BASE_URL` | server, CLI | model access |
| `INSTINCT_OWNER_NAME`, `INSTINCT_OWNER_PHONE`, `INSTINCT_OWNER_EMAIL`, `INSTINCT_OWNER_TIMEZONE`, `INSTINCT_AGENT_NAME` | server | seed `config.json` on first boot. `init` flags do the same job |
| `INKBOX_API_KEY`, `INKBOX_AGENT_HANDLE`, `INKBOX_IDENTITY_ID`, `INKBOX_SIGNING_KEY` | server, CLI | the identity-scoped Inkbox credentials. `init` saves them in `secrets/inkbox.json`; `dev` loads them |
| `INKBOX_ADMIN_API_KEY` | CLI, server | org-wide key. Provisions the identity, subscribes webhooks, creates invitations |
| `INKBOX_BASE_URL` | CLI, server | only for a self-hosted Inkbox |
| `INSTINCT_TUNNEL` | server, CLI | `1` opens the Inkbox tunnel. `dev --tunnel` sets it |
| `INSTINCT_CHAT_TOKEN` | server, CLI | bearer token for the owner surface |
| `INSTINCT_BIND` | server | bind address override |
| `INSTINCT_PUBLIC_URL` | server | public URL of the agent, used to build the Stripe Link callback |
| `INSTINCT_COMPUTER` | server | `auto`, `desktopd`, `maritime`, `none` |
| `MARITIME_API_KEY` | server, CLI | hosted computer (scope `computers`), and `instinct deploy` |
| `MARITIME_COMPUTERS_MCP_URL` | server | hosted computer endpoint. Default `https://mcp.maritime.sh` |
| `COMPOSIO_API_KEY`, `COMPOSIO_TOOLKITS` | server, CLI | Gmail, Calendar and other apps. The key alone turns apps on |
| `LINK_CLIENT_ID`, `LINK_CLIENT_SECRET`, `STRIPE_PUBLISHABLE_KEY`, `LINK_REDIRECT_URI` | server, CLI | Stripe Link agent wallet. All of the first three are needed for payment tools |
| `BRAVE_SEARCH_API_KEY` | server, CLI | better web search. DuckDuckGo otherwise |
| `INSTINCT_SKILLS_DIR` | server | SKILL.md folder. Default `<repo>/skills` |
| `INSTINCT_REPLY_BUDGET_MS` | server | how long `/chat` waits before acknowledging and finishing in the background. Default 20000 |
| `PORT` | server | listen port. Default 8080 |
| `NO_COLOR`, `INSTINCT_DEBUG` | CLI | plain output; stack traces |

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `no tunnel: iMessage webhooks need --tunnel or the gateway` | `dev` started without the flag | run `instinct dev --tunnel` |
| `INKBOX_API_KEY and INKBOX_AGENT_HANDLE are required` | no `secrets/inkbox.json` | run `instinct init` with `INKBOX_ADMIN_API_KEY` set |
| `webhook: subscribe Inkbox events to https://...` printed in grey | no admin key, so no auto-subscribe | set `INKBOX_ADMIN_API_KEY`, or subscribe by hand to the printed URL |
| texts from your phone get no answer | your number is not the owner's | check `--phone` in `init` matches the iPhone you text from, in E.164 form |
| webhook returns 401 | signing key mismatch | delete `secrets/webhook.json` and restart with the admin key, or set `INKBOX_SIGNING_KEY` to the current key |
| webhook returns 503 | no signing key configured at all | same as above |
| `Inkbox plan limit` on `init` | the org is at its identity cap | upgrade, or delete an unused identity |
| `402 no_plan` on a computer action | Maritime account has no Computers plan | add the plan, or set `INSTINCT_COMPUTER=none` |
| `COMPOSIO_API_KEY` set but no app tools | `config.json` has `apps.enabled: false` | run `instinct init --name <you> --apps` |

Related reading: [INKBOX.md](INKBOX.md) for the identity, router and webhooks; [ARCHITECTURE.md](ARCHITECTURE.md) for the message flow; [PERMISSIONS.md](PERMISSIONS.md) for who may ask the agent for what; the [CLI README](../packages/cli/README.md) for every command and flag; the [server README](../packages/server/README.md) for the HTTP routes.
