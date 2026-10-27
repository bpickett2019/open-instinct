# Shared integration contracts

Integration owner: primary assistant. Do not edit core business-types.ts, business-store.ts, tools.ts, runtime.ts, policy.ts, server business-coordinator.ts, business-service.ts, boot.ts, http.ts, package manifests or lockfile without messaging the owner. Independent slices own their added files and relevant adapter internals. Read the complete acceptance-contract.md and repository CONTRIBUTING.md/docs/SECURITY.md. No build/lint/tests/formatters mid-flight: primary runs integrated checks. Write behavior tests but do not run them. Report required dependencies with exact versions and engine evidence to primary; primary owns installs/manifests.

Current shared exports: core BusinessStore (native SQLite), BusinessTask/Action/Connection/Settings/Wait, TaskRunBinding, LogicalAction, BusinessDispatch. Read actual modules for signatures. Store is server-side/private; worker tools must check ctx.taskRun or authenticated owner scope in execute, not only visibility. Store generic records support versioned get/put/list with validation callback and kinds authority/profile/connection/commitment/routine/knowledge/artifact/notification/usage/cursor. Use existing store, no second task or policy store. Additional tables/methods require requesting primary. Json serialization rejects undefined, nonfinite numbers and non-JSON objects.

BusinessCoordinator server owns admission, claim, dispatch, complete, waits, controls, recovery. Constructor accepts worker/audit/reconcile callbacks. ToolRegistry task-bound invocation calls dispatcher before spec.execute, then optional spec.verify(args,result,ctx,signal), which returns receipt/evidenceRefs/verified. Generic tools remain accepted, not outcome-verified. Dedicated adapters should provide verification; request enhancements for normalized prepared requests, per-operation connection binding, source revisions and credential references. Never dispatch twice from nested wrappers. Stable step ID currently hash(tool,args); primary will extend explicit durable logical steps.

BootResult.business is BusinessService exposing coordinator and intake(message,principal), context(), notify(). All owner text/web ingress must persist admission and immutable owner provenance. Worker runtime uses existing Pi AgentRuntime.runBusinessTask; no second assistant. Primary wires slice services into boot and HTTP. Business mode currently stores DB under <state>/business, identity from store settings; hosted Maritime forced with separate MARITIME_COMPUTER_API_KEY; host bash filtered. App user ID is workspace UUID. BootOptions.appsAdapters is now forwarded.

Owner workspace agent: create workspace-session/http/page and web assets. Export route service accepting BusinessService plus injected artifact/app/computer services; coordinate exact facade methods with peers. Primary wires createHttpServer. Do not directly expose arbitrary record writes, tool invocation, config, environment or paths. Browser APIs require opaque hashed sessions and CSRF. Legacy bearer is separate.

Knowledge agent: one artifact service backed by business records/files, source authority and extraction; export narrow facade and tools to primary/workspace. Provider agent: GoogleWorkspace + GoogleTransport per plan, Composio fixed proxy/account binding; export narrow business tools and discovery. Harness agent: test-only exact emulator transport, actual boot/server and state; coordinate public Google wire with provider agent. UI/e2e agent owns workspace plus browser matrix and evidence generator; harness agent provides reusable scenario app.

Vertical proof ran through real HTTP/Pi/registry/SQLite/filesystem with a faux model; the throwaway script was removed after preserving `evidence/vertical-slice.json`. Current integration and verification status is in `acceptance.json` and `ACCEPTANCE.md`. No live provider scenario has run. Never mark live proof from emulator/browser screenshots. Fixtures use synthetic .test recipients and explicit isolated environments only.

## Hosted document transfer (plan82)

`packages/server/src/business-hosted-artifacts.ts` exports
`createHostedArtifactTools({ knowledge: BusinessKnowledge, backend: () => ComputerBackend | undefined })`.
The integration owner registers the returned tools once in business boot, after creating
the knowledge service, with a closure over the actual hosted backend (not a copied provider
client). Import `createHostedArtifactTools` from `./business-hosted-artifacts.js`, then call
`if (knowledge) registry.registerMany(createHostedArtifactTools({ knowledge, backend: () => computer }))`
inside boot's `if (business)` block, beside `businessKnowledgeTools`. Classify
`computer_import_artifact` as a computer operation in the coordinator, including its
computer-use quota, privacy and policy checks. Its effect is a document registration
write, with `computer.use`, `files.read`, and `files.write`; it is not an owner-control,
shell, purchase, or external-send operation.

Arguments are only `path`, `filename`, `mimeType`, and `expectedText` (an explicit list
of required extracted text/totals). Task/workspace/computer identities are runtime-bound.
The tool requires a final task dispatch/fence and invokes the discovered `read_file`
**registered spec**, preserving Maritime's lease, privacy and final-dispatch wrapper;
it never calls `backend.call` directly. The raw transfer remains in memory until
`BusinessKnowledge.registerGenerated` stores immutable original bytes and verifies
extraction. No transfer body is returned or added to action arguments/receipts/history.
The returned artifact ID/hash/evidence refs are opaque; source provenance records the
runtime task and encoded remote path. Transfer receipts are `primitive-only`;
only successful document extraction plus expected-text checks produce
`document-readback` evidence. A wrong total retains a failed original in Files, never
a verified deliverable. Generated content remains evidence, not business policy.

Provider assumptions were checked against the official
[Maritime Computers documentation](https://maritime.sh/docs/computers.md) on 2026-10-23.
It documents `/data` and `/home/desk`, UTF-8 text or base64 with a MIME note, and an
**8 MiB provider cap**. The importer additionally enforces a **20 MiB local ceiling**;
this does not override the smaller provider limit. Before reading, it inspects the
current discovered MCP input schema and requires a path-only call accepted by that
schema after the adapter removes server-owned identity fields. No live MCP discovery
or entitlement check was made with customer credentials.

The public page does not specify an exact response envelope. Supported forms are
one JSON text block with explicit `encoding: "base64"` and exactly one string
`data` or `content`, or explicit `encoding: "utf8"` / `"utf-8"` with string `content`.
UTF-8 additionally needs the registered adapter's original-byte hash proof, preventing
redaction/JSON normalization from silently changing an original. Base64 must be
canonical, padded when needed; ambiguous fields, unsupported encodings, plain text,
image blocks, size-only notes, private/redacted/partial responses and unknown contracts
are blockers, not fallback files. Optional `path`, `mime`/`mimeType`, byte-count
(`bytes`, `size`, `size_bytes`) and `sha256` metadata must match. Other `hash`/`digest`
metadata is unsupported and blocks rather than being ignored. A provider with a
different envelope requires a documented adapter contract before import can proceed.

Only formats accepted by the shared Files parser can become verified artifacts:
export LibreOffice output as PDF, DOCX, XLSX, CSV, or text as appropriate; ODT/ODS
are not silently converted by this transfer tool. Expected totals are literal
extracted-content checks, not independent spreadsheet formula recalculation.
The focused `business-hosted-artifacts.test.ts` uses the actual registered tool,
dispatcher, Maritime MCP wrapper, isolated SQLite/artifact store, real extraction and
synthetic in-memory MCP responses, including actual XLSX bytes. It does **not**
run LibreOffice, a hosted shell, or a live desktop/provider. The integration owner
must build the extraction worker before running this test and owns all integrated
verification; these fixtures are not evidence of live LibreOffice execution.

## Gmail canonical effect identity (SEC5)

Business Gmail preparation uses the pinned Nodemailer **10.2.1** serializer twice.
The first pass fixes Message-ID, Date, and multipart boundaries to constants and
hashes the resulting MIME bytes, including Bcc and validated attachment content.
Text/HTML line endings are normalized before transfer-encoding selection; both
passes emit CRLF. This delegates References/In-Reply-To angle brackets, empty
headers, header whitespace, MIME parameters, and encoding normalization to the
same serializer that sends the message, rather than hashing model-input JSON.
No random date, identifier, or boundary enters the canonical identity.

The final identity binds that wire hash and Gmail thread ID to the server-owned
task/operation/account occurrence. Final MIME uses the resulting Message-ID and
boundary plus the durable task creation date. Prepared dispatch arguments contain
only `raw`, `messageId`, and an optional nonempty `threadId`; original cosmetic or
unknown fields never re-enter the core action hash. Different content or thread
remains distinct, and a separate owner request can intentionally send again.
Attachment byte limits, filename/MIME header checks, SHA-256 validation, and
disabled URL/file loading remain enforced before serialization. Verification
still independently reads Gmail SENT raw content and compares parsed headers,
bodies, recipients, attachments, and thread; serialization is not delivery proof.

Regression coverage is in `packages/apps/test/google-workspace.test.ts` and
`packages/server/test/scenarios/dispatch-boundaries.test.ts`: the latter drives
real Pi/registry/stateful Google emulation for bracket/whitespace variants,
empty-versus-omitted fields, line endings, same-task changed content, and explicit
new-owner-request repetition. These are offline regression definitions, not live
provider evidence; the integration owner runs consolidated verification.

## Gmail open-work recovery (BO153)

The production routine sweep supplies the intake's recovery thread set at
activation and replaces it on every poll. Scope comes from nonterminal tasks'
durable account-bound Gmail source messages, currently waiting Gmail correlations,
and active commitments with the exact connection/account/epoch premise. Closed
tasks and waits, cancelled/suppressed commitments, other accounts and stale
connection epochs do not widen this set. A task's first observed recovery binding
persists the connection ID, epoch and identity; reconnecting or substituting an
identity cannot silently retarget that task's old threads.

History expiry still records a fresh baseline and resumes the persisted active
window. Direct reads also recover older messages from explicitly open threads as
evidence for already-authorized work. These reads do not grant retrospective
incoming-request authority: `admitIncoming` retains the routine activation-time
boundary. Sent/draft/spam/trash filtering, durable message dedupe and the separate
live follow-up premise recheck remain in place.

`packages/server/test/scenarios/open-thread-recovery.test.ts` drives the production
routine service, intake, account-bound Composio proxy and stateful Google emulator.
It defines expired-cursor recovery of dated pre-window replies, no historical
request admission, closed/unrelated/foreign thread exclusion, scope added after
activation, commitment cancellation, and connection epoch/identity/account changes.
The pre-fix standalone reproduction observed an active waiting task with
`openThreads: []` and zero direct-thread calls after cursor expiry and recovery.
The throwaway script was removed. Consolidated regression execution belongs to the
integration owner; these are offline contracts, not live-provider evidence.

## Final durable-boundary repairs

Preparation and allowance reservation commit before the separate synchronous
attempt transaction. Only a never-attempted `prepared` action may acquire a new
run/revision binding; its canonical operation, sources, account and allowance stay
immutable. Final dispatch revalidates authority, sources, connection and held
budget. Restart cancels run-local read/model preparations, retains safe effect
preparations, and quarantines attempted effects without replay. Eight real
SIGKILL scenarios exercise Gmail and generic hosted submission at four phases.

Wait-event consumption is persisted per task and correlation; recovery backfills
it from satisfied historical waits. Owner context uses the filtered bounded profile,
not raw deleted/superseded fact records. Notifications carry stable inbound,
task-step or event identities; interrupted attempts recover as unknown.
Tool invocation contexts are snapshots, not shared mutable transport provenance.

Business model calls enforce a conservative 128-tool OpenAI-compatible bound on
the actual task-filtered Pi tool set before provider or accounting entry.
Catalog search and single concrete-operation dispatch do not expand the entire
connected-app catalog into the model request or permit router/remote-code bypass.
The current [OpenAI Chat Completions reference](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)
does not state a numeric tools-array maximum; 128 is retained as this runtime's
compatibility safety bound, not a claim about every current model/provider.
Actual selected-model availability, tools and images still require live proof.

## Assistant-led onboarding and revocation fences

`BusinessOnboarding` is a shared owner-only projection and pending-connection
controller, not another assistant or scheduler. Text foreground context and
`GET /api/owner/onboarding` use the same current profile and verified account state.
The existing coordinator sweep confirms pending connections. A greeting has one
final reply, not a preliminary task receipt. Worker and nonowner contexts cannot
use the onboarding or connection controls.

`POST /api/owner/onboarding/conversation` accepts only `{}` behind the existing
owner-session, origin and CSRF boundary. It durably admits the canonical
`workspace-onboarding` event and returns 202 without waiting for inference.
The event is a visible notice, never a fabricated typed owner message. Its
idempotency hash uses the event identity rather than mutable prompt wording.
`runBusinessOwner(..., "guidance")` uses the same conversation queue and history
with `ownerTurn=false` and no executable tools. Ordinary `/messages` admissions
restore owner-mode tools and retain the actual text as fact provenance.

The opening may consume accounted model usage and refresh previously authorized
readiness/work, but cannot create new authority to execute work. It neither
overwrites the saved carrier route nor sends a carrier greeting. Interrupted
foreground cursors are marked interrupted on restart, not automatically replayed.
The UI displays the returned interruption and remains usable for a genuine reply.
Browser pending state resolves against matching `answer:`/`reply:` message IDs;
ordinary polling does not replace the composer or discard a draft. The missing
profile-field projection is a completeness hint, never a mandatory script.

### Owner iMessage feedback authority

Authenticated ordinary owner iMessage admission captures its provider message ID
and known-private route in the durable inbound cursor. Read feedback starts only
after admission commits. Foreground typing is bounded, single-flight, refreshes
while composing, and cancels on settlement or foreground shutdown; it never
blocks model execution. No automatic feedback authority is created by web,
guidance, SMS, group, unknown-scope or nonowner ingress.

The runtime-bound foreground `react` callback accepts only the active admission's
provider message ID and seven named reactions. Read and reaction attempts reserve
`feedback:<kind>:<sourceId>` before dispatch; accepted and uncertain attempts are
not replayed. Restart converts interrupted attempts to unknown. A carrier-accepted
reaction may finish the turn without text or a task; its persisted notice records
that recipient display is unconfirmed. Later messages cannot redirect its route.
Optional feedback timeout/failure cannot hold priority stop or shutdown.

This courtesy path does not replace task authority. Separately authorized task
reactions remain in `BusinessDispatch`, with the action journal, source revision,
task/run/stop fences and uncertain-acceptance protections. Worker contexts never
receive the foreground callback. Inkbox validates identity-scoped conversation
membership and inbound targets, propagates cancellation to REST, rechecks the
dispatch fence after asynchronous lookups, and makes only one mutation attempt.

### Connection intent versions

`connect:<toolkit>` cursor versions fence authorization: reserve a nonpending
generation before requesting a link; publish pending authority only with that
version. Explicit disconnect atomically cancels the intent and disables the
connection before upstream I/O. Account discovery cannot bootstrap through a
cancelled/reserved intent, and independently verified identity must still match
the captured connection and intent versions when the transaction commits.
Same-account reactivation requires newer explicit intent and unchanged identity;
an unresolved requested revocation blocks it. A new account does not remap
historical task bindings. Already connected onboarding calls return the verified
account rather than creating a redundant authorization.

`onboarding:connect:<toolkit>` records waiting/verified/cancelled conversation
progress. Cancellation is rechecked after discovery before confirmation.
The notice ID is stable across restart; durable notification admission precedes
the verified cursor update. The existing uncertain-delivery/no-replay policy
still applies. Connecting grants no routine activation or historical scan.
