
## Audit result

**All 177 ledger rows assessed. Source and ledger remain unchanged.** The latest integrated evidence supersedes the earlier server/image failures, but **six source-demonstrated issues still affect reachable acceptance requirements**. Independent final security review and all nine live scenarios remain blocked.

**Artifact-writing blocker:** this reviewer has no exposed write tool, and its Bash policy permits only read-only review commands. Therefore, **`local://acceptance-mapping-proposal.json` was not created**. The complete status census and mappings below are provided for the parent to materialize; no file creation is claimed.

### Proposed status census

| Proposed status | Rows |
|---|---:|
| `verified_deterministic` | 72 |
| `verified_browser` | 36 |
| `blocked_live` | 28 |
| `blocked_security_review` | 16 |
| `implementation_gap` | 12 |
| Existing `reference`, intentionally unchanged | 13 |
| **Total** | **177** |

`verified_*` means **only the explicitly mapped local proof**, not complete live readiness or independent security clearance. Header/reference rows are not additional passing scenarios.

## Reachable implementation gaps

### 1. Reject business-state directories inside the readable workspace
**Priority:** P1 · **Confidence:** 0.99  
**Anchor:** `packages/server/src/boot.ts:121`  
**Affected IDs:** BO-044, BO-048, BO-288

`business.stateDirectory` is passed directly to `BusinessStore`, while local file tools are independently rooted at `state.path("workspace")` at boot lines 292–293. A supported configuration such as `<state>/workspace/private-business` places the SQLite database and private artifacts inside the tree the worker’s file tools permit. `BusinessStore` canonicalizes and protects permissions but does not enforce separation from that readable tree. Reject overlapping canonical paths before constructing the store. This requires operator configuration; the default `<state>/business` placement is separate.

### 2. Advance the consumed-event boundary between successive questions
**Priority:** P2 · **Confidence:** 0.99  
**Anchor:** `packages/server/src/business-task-tools.ts:33`  
**Affected IDs:** BO-067, BO-122, BO-291

Every `ask_owner` uses `owner-reply:${task.id}` with `eventCursor: 0`; `task_wait` also always supplies zero. `BusinessCoordinator.wait()` at lines 215–222 selects an already-stored matching event after that cursor. Consequently, after question A is answered, a distinct question B in the same task immediately becomes satisfied by answer A instead of establishing its own durable wait. Preserve event-before-wait behavior while tracking the consumed cursor or a distinct server-owned question occurrence.

### 3. Remove raw historical profile data from active model context
**Priority:** P2 · **Confidence:** 0.99  
**Anchor:** `packages/server/src/business-service.ts:155–159`  
**Affected IDs:** BO-080, BO-093, BO-189

`BusinessService.context()` serializes the entire raw `profile/current` record. Boot then appends `knowledge.profiles.compactContext()` rather than replacing that raw serialization. `BusinessProfile.current()` filters deleted/superseded sources, but the preceding raw profile bypasses both that filtering and the compact-context budget. `deleteSource()` retains historical profile records, so deleted facts disappear from retrieval/UI while remaining in active foreground/worker context. Use the filtered, bounded profile projection as the sole active business-fact context.

### 4. Populate and maintain the production open-thread recovery set
**Priority:** P2 · **Confidence:** 0.98  
**Anchor:** `packages/server/src/business-proactive-google.ts:15–16`  
**Affected ID:** BO-153

`GmailIntake.activate()` defaults `openThreads` to an empty array, and production activation never supplies it. No production writer updates that field. Thus the direct-thread recovery branch in `packages/apps/src/gmail-intake.ts:39–42` never runs in production. Wire account-bound open task/wait threads into intake recovery and maintain their lifecycle. The separate follow-up pre-dispatch thread check does not implement intake’s required direct-open-thread recovery.

### 5. Recover interrupted notification attempts as unknown on ordinary restart
**Priority:** P2 · **Confidence:** 0.99  
**Anchor:** `packages/server/src/business-coordinator.ts:278–286`  
**Affected ID:** BO-128

Both `BusinessService.notify()` and `BusinessOutbox.send()` persist `dispatching` before awaiting transport. Ordinary coordinator/service startup recovers actions, usage and foreground cursors, but not notification records. A crash between send initiation and its status commit therefore leaves the notification `dispatching` indefinitely; stable-ID notification retry returns immediately because the record exists. Convert interrupted notification attempts to explicit unknown/reconciliation state without resending. Backup restore already performs a corresponding conversion; ordinary startup does not.

### 6. Give fallback outbound messages stable event/message identity
**Priority:** P2 · **Confidence:** 0.98  
**Anchor:** `packages/server/src/business-outbox.ts:14`  
**Affected ID:** BO-128

When no `notificationId` is supplied, the outbox creates `transport:${randomUUID()}`. Runtime `safeSend()` at `packages/core/src/runtime.ts:1083–1086` supplies no stable notification/message ID. Therefore these fallback paths lack the task/event/message-keyed identity explicitly required by BO-128. Propagate persisted logical message identity into these sends and consult the existing attempt rather than minting a new identity. **No duplicate carrier delivery was executed or observed in this audit.**

**BO-306 also remains `implementation_gap`:** the instruction to finish reachable implementation cannot be satisfied while these defects remain.

## Current evidence to use

All paths below are relative to `/tmp/open-instinct`.

| Key | Current evidence and scope |
|---|---|
| **FINAL** | `docs/business-owner/evidence/security-final-integrated.txt`: affected apps/Inkbox/server build and typecheck pass; apps **172 passed**, Inkbox **206 passed / 1 skipped**, server **267 passed**; smoke passed; browser **34 passed**; publication scan **236 files / 4 archive entries** passed. |
| **BUILD** | `docs/business-owner/evidence/security-build-typecheck.txt`: full 12-package build/typecheck evidence preceding the latest affected-package rerun. |
| **CORE** | `docs/business-owner/evidence/consolidated-tests-initial.txt`: core **313 passed** and earlier package results. Do not describe this older aggregate as a fresh all-package pass. |
| **CLI** | `docs/business-owner/evidence/document-cli-smoke-pass.txt`: CLI **104 passed**, document lifecycle and personal-mode smoke. |
| **MATRIX** | `packages/server/evidence/manifest.json`, `packages/server/evidence/index.html`: actual compiled workspace; **116 checkpoints**, desktop/mobile and light/dark; emulated provider/model mode. |
| **NEGATIVE** | `docs/business-owner/evidence/negative-browser.json`: deliberate failing-browser case; masked unsent input; sanitized JSON-only public traces; **7 files / 6 archive entries / 171,755 expanded bytes** scanned. Preserve its historical SEC-7 disclosure; earlier pixel-bearing public traces were unsafe. |
| **SHEET** | `docs/business-owner/evidence/spreadsheet/proof.json`: actual local HyperFormula **3.1.0** recalculation, stale caches **999/888/−111 → 250/280/30**, formulas preserved, production registration/readback through synthetic MCP transport. LibreOffice **26.8.1.1** rendered PDF; it did **not** perform the demonstrated recalculation. |
| **VISUAL** | `docs/business-owner/evidence/visual-followup.json`, `manual-supplier-brief.pdf`, `manual-supplier-brief-rendered.png`, `spreadsheet/rendered-browser.png`: actual local document opening and parent visual review; not hosted/live proof. |
| **SCAN** | `docs/business-owner/evidence/gitleaks-working-tree.json` plus FINAL/NEGATIVE publication scans. Scans are not independent vulnerability clearance. |
| **REVIEW** | `docs/business-owner/evidence/security-review-initial.md`, `security-review-followup.md`: historical review artifacts. Current independent final review remains pending; do not treat old findings as automatically open or automatically cleared. |
| **LIVE** | Updated `docs/business-owner/evidence/live-prerequisites.json`: all nine exact scenarios and prerequisites; none exercised. Owner token is locally generated setup, **not an external credential to request**. |

## Complete proposed mapping

Each explicitly listed ID inherits the status and mapping in its row. This covers all 177 IDs without blanket completion.

### Product, baseline and architecture — 20 rows

| IDs | Status | Implementation / scenario / evidence |
|---|---|---|
| BO-004 | `blocked_live` | `server/src/boot.ts`, `core/src/runtime.ts`, `server/src/business-coordinator.ts`; generic signed-text/web delegation and document workflows pass locally in FINAL/MATRIX; complete product remains LIVE-blocked. |
| BO-006 | `blocked_security_review` | `core/src/policy.ts`, `core/src/tools.ts`, coordinator, usage and controls; FINAL autonomous-send/final-fence negatives; pending independent review. |
| BO-008, BO-015 | `verified_deterministic` | Generic task contracts/coordinator and existing Pi runtime, rather than quote schema; file, Gmail, Calendar and document scenarios in FINAL. |
| BO-010 | `verified_deterministic` | Workspace-local store and single-owner boot; separate-workspace scenario; scope/affiliation disclosures. No multi-tenant readiness claim. |
| BO-013 | `verified_deterministic` | Existing checkout and declared baseline commit `cb3d97ca2322a6c53d0208155b7b5ab66c5ba0d4` inspected. This does not retrospectively prove every editing/LSP practice. |
| BO-017 | `blocked_security_review` | Existing CI plus stateful harness/browser evidence and independent review artifacts; FINAL/MATRIX/REVIEW. |
| BO-019, BO-020, BO-021, BO-023, BO-024 | `verified_deterministic` | Existing runtime/model, Inkbox, Composio, skills, file/PDF, Maritime, personal policy/audit facilities reused; FINAL provider contracts, signed texting and smoke; CORE personal compatibility. |
| BO-022 | `verified_browser` | `server/src/http.ts`, `workspace-http.ts`, `workspace-page.ts`, `server/web/workspace.ts`; actual `/workspace` matrix, FINAL/MATRIX. |
| BO-027, BO-033 | `blocked_live` | Controller/store/hosted-backend architecture and deployment documentation exist; always-on persistent production host, HTTPS routing and real hosted separation are not exercised. |
| BO-029 | `blocked_security_review` | Hosted credential/lease/privacy boundary and private storage implementation; FINAL negatives; pending final review and storage-overlap defect above. Real mounting/isolation remains LIVE-unproven. |
| BO-031 | `verified_deterministic` | Root/all runtime engine declarations, `.nvmrc`, `.tool-versions`, CI and both deployment images use **22.22.3**; pnpm **10.6.1**; native SQLite. BUILD/FINAL plus source inspection. |
| BO-036 | `blocked_live` | `core/src/model.ts`, runtime model/stream/key injection preserved; actual selected-model availability and tool/image support require LIVE credentials. |
| BO-038, BO-040 | `verified_deterministic` | Existing `ComputerBackend`, Composio adapters/MCP; `apps/src/google-transport.ts`, `google-workspace.ts`, `composio.ts`; production fixed proxy exercised by provider/workflow contracts in FINAL. |

### Configuration and private state — 16 rows

| IDs | Status | Implementation / scenario / evidence |
|---|---|---|
| BO-044, BO-048 | `implementation_gap` | Config/init/store implementation exists; custom state placement violates workspace exclusion. See gap 1. |
| BO-046 | `verified_deterministic` | `core/src/business-store.ts`, boot and `apps/src/business-providers.ts`; immutable workspace ID and explicit account binding; cross-workspace/account-substitution scenarios, FINAL. |
| BO-050, BO-052 | `verified_deterministic` | `business-store.ts`, `business-types.ts`; generic schema/indexes and typed record definitions. BO-052 is a table header, not an independent test. |
| BO-054 | `verified_browser` | Settings/profile/routine versioning; `workspace-http.ts`, `business-profile.ts`, `business-commitments.ts`; persisted settings/onboarding matrix, FINAL/MATRIX. |
| BO-055 | `verified_browser` | Connection records/account epochs/revocation-request status; `business-providers.ts`, connections UI; FINAL/MATRIX. |
| BO-056 | `verified_browser` | Generic task contracts/store/coordinator and task UI; admission, task evidence, edit/close/version-conflict scenarios, FINAL/MATRIX. |
| BO-057 | `verified_deterministic` | Immutable attempted action payloads, normalized hashes and receipts; store/coordinator/provider preparation; FINAL dispatch-boundary cases, including latest canonical-wire Gmail cases. |
| BO-058 | `verified_deterministic` | `business-commitments.ts`; scoped routines, occurrences, bounded follow-up and cancellation; 21 commitment tests, FINAL. |
| BO-059 | `verified_deterministic` | Store events/cursors/waits plus Gmail intake admission; event dedupe and failed-admission recovery scenarios, FINAL. Repeated-wait bug remains separately mapped. |
| BO-060 | `verified_browser` | `business-knowledge-types.ts`, store FTS and shared artifact/knowledge services; versions/citations/download/search, FINAL/MATRIX. |
| BO-061 | `verified_browser` | Store message/activity cursors, service/outbox and owner API; independent readers, multitab and signed transport history, FINAL/MATRIX. Notification restart gap is not cleared. |
| BO-063, BO-065 | `verified_deterministic` | Typed task/action states, evidence distinctions, CAS claims/fences and immutable actions; competing claims, wrong readback, uncertainty and process-lock tests, FINAL/CORE. |
| BO-067 | `implementation_gap` | Durable waits exist, but registered wait producers reset event cursors. See gap 2. |

### Knowledge and documents — 7 rows

| IDs | Status | Implementation / scenario / evidence |
|---|---|---|
| BO-070 | `verified_deterministic` | `business-profile.ts`, `business-knowledge.ts`, generic onboarding/follow-through skills; partial saved answers/citations/reopen and skill privacy tests, FINAL. |
| BO-072 | `verified_browser` | Profile fields/one-question progression plus checked pricing; `business-pricing.ts`, knowledge tools; onboarding reload/source view and exact arithmetic tests, FINAL/MATRIX. |
| BO-074 | `verified_deterministic` | Scoped owner authority/current citations/contradiction handling; knowledge/profile tools; retrieved-source policy-promotion rejection and scoped-conflict tests, FINAL. |
| BO-076, BO-078 | `verified_deterministic` | Shared artifacts, `business-document-parser.ts`, bounded extraction worker and Gmail attachment ingestion; actual PDF/DOCX/XLSX/CSV extraction, locators, archive limits, failure/retry and model-derived image evidence, FINAL. |
| BO-080 | `implementation_gap` | Raw profile bypasses filtered compact context. See gap 3. |
| BO-082 | `blocked_live` | Versioned local files, PDF generation, registered hosted-artifact import, actual XLSX recalculation/download/open proof: FINAL/SHEET/VISUAL. **Real hosted LibreOffice execution and hosted transfer remain unexercised.** |

### Delegation and proactive work — 13 rows

| IDs | Status | Implementation / scenario / evidence |
|---|---|---|
| BO-085, BO-087, BO-089 | `verified_deterministic` | Coordinator lifecycle/API, runtime-created binding, registered dispatcher and criterion-evidence completion; admission, uncertainty, wrong-readback and dispatch-boundary tests, FINAL. |
| BO-091 | `verified_deterministic` | `business-owner-tools.ts`, service and foreground runtime; immediate answer versus durable delegation, one task/action, FINAL. |
| BO-093 | `implementation_gap` | Foreground/worker separation and shared history exist, but the required compact owner context includes raw historical profile data. See gap 3. |
| BO-095 | `blocked_security_review` | Priority intake precedes inbox enqueue; HTTP direct stop passes. No located signed-text-stop scenario with an already-blocked durable inbox handler. Source present; proof gap, not a demonstrated bypass. |
| BO-097 | `blocked_security_review` | Coordinator/runtime implement worker/computer limits, slices, dispatch caps and no-progress handling. Dedicated full contention/deadline/no-progress matrix was not located; pending gate. |
| BO-099 | `verified_browser` | `business-usage.ts`, store reservations/balances and settings UI; caps/held/unknown balances plus both image-accounting tests now pass in FINAL/MATRIX. |
| BO-101 | `verified_deterministic` | Stream-boundary accounting and atomic allowances; unknown model/image price and parallel reservations, FINAL. |
| BO-103 | `verified_deterministic` | Owner/task/commitment tools; business scheduler cutover with personal scheduler retained; commitment and CLI control tests, FINAL/CLI. |
| BO-105, BO-107, BO-109 | `verified_deterministic` | Nonoverlapping sweep, scoped activation/routines and fresh premise checks; `business-commitments.ts`, `business-proactive-google.ts`; downtime/dedupe, reply/intervention/opt-out suppression, timezone/contact-window tests, FINAL. |

### Autonomy and owner controls — 14 rows

| IDs | Status | Implementation / scenario / evidence |
|---|---|---|
| BO-112, BO-114 | `verified_deterministic` | Business-owner policy branch, runtime principal checks and task authority; autonomous Gmail, negative principals and personal compatibility, FINAL/CORE. |
| BO-116 | `verified_deterministic` | Mode-aware core prompt, Inkbox/network/payment guidance and task questions; source inspection and relevant guidance/missing-source tests, FINAL/CORE. Successive question bug remains BO-122. |
| BO-118 | `blocked_security_review` | Nine requested mode-aware skills, saved owner restrictions and credential-vault/payment/Maritime redaction paths; concrete tests exist, independent current review pending. |
| BO-120 | `blocked_live` | Phone/payment operations, limits and provider-hosted consent; latest phone fences in FINAL. Real calls/purchase consent/checkout need configured providers and consenting participants. |
| BO-122 | `implementation_gap` | Second missing-fact question can reuse the first answer. See gap 2. |
| BO-124, BO-126 | `blocked_security_review` | Dispatcher/final-adapter fences and opaque credential/privacy paths; latest phone/Gmail fixes and negative tests acknowledged. Current independent gate, including SEC-7 replacement evidence, remains pending. |
| BO-128 | `implementation_gap` | Ordinary notification restart recovery and fallback logical identity missing. See gaps 5–6. |
| BO-130, BO-132 | `verified_deterministic` | Honest generic receipts/unknown batches, typed reconciliation and normalized logical effect identities; latest Gmail canonical-wire variants and same-run uncertainty cases, FINAL. |
| BO-134, BO-136 | `verified_browser` | Deterministic direct controls and persistent stop/cancel epochs; blocked-model stop, restart, late result and owner-control matrix, FINAL/MATRIX/CLI. |
| BO-138 | `verified_deterministic` | Immutable effect history and separate current-state Calendar corrections; Calendar lifecycle/stale-etag and task-version tests, FINAL/MATRIX. |

### Apps and computer — 10 rows

| IDs | Status | Implementation / scenario / evidence |
|---|---|---|
| BO-141 | `verified_deterministic` | Broad toolkit connect/catalog retained; actual synthetic Stripe connect/discovery and Notion concrete-tool tests, FINAL. |
| BO-143 | `verified_deterministic` | `business-providers.ts` catalog/concrete wrapper and `composio.ts` filtering; raw Google/router/remote-code bypasses excluded, FINAL. Total selected-model tool-limit enforcement is not proven; see proof gaps below. |
| BO-145, BO-147 | `blocked_live` | Typed fixed Google proxy, account checks, MIME, attachment hashes and Calendar operations have FINAL contracts. Live Composio serialization/OAuth/provider behavior remains unexercised. |
| BO-149 | `blocked_live` | Prepared canonical MIME and saved Message-ID; one accepted send across lost response/restart/delayed visibility, FINAL/MATRIX. No actual Gmail Sent or consenting-mailbox receipt. |
| BO-151 | `blocked_live` | Stable event IDs, freebusy, conditional etags and readback; actual fixture insert/edit/cancel/stale conflict, FINAL/MATRIX. No actual Calendar outcome. |
| BO-153 | `implementation_gap` | Production open-thread recovery set is never populated. See gap 4. |
| BO-155 | `blocked_live` | Local disable precedes requested upstream revocation; account substitution/auth error tests and UI pass. Actual revoke/reconnect identity remains LIVE-blocked. |
| BO-157, BO-159 | `blocked_live` | Workspace-specific forced Maritime, disabled host bash, task lease and takeover/privacy verification; fixture protocol/UI tests pass. No real hosted action, entitlement, takeover or controller-mount inspection. |

### Owner workspace — 15 rows

| IDs | Status | Implementation / scenario / evidence |
|---|---|---|
| BO-162 | `verified_browser` | Explicit module-relative compiled assets, framework-free shell and existing HTTP routes; `workspace-http.ts`, `workspace-page.ts`, `server/web/*`, `tsconfig.web.json`; FINAL/MATRIX/smoke. Correct old ledger path **`packages/server/src/web` → `packages/server/web`**. |
| BO-164, BO-166, BO-168 | `verified_browser` | `workspace-session.ts`, HTTP/session boundary and text-only rendering; expiry/logout/origin/Host/CSRF/tunnel/legacy separation and hostile-content tests, FINAL/MATRIX. |
| BO-170, BO-171, BO-172, BO-173, BO-174, BO-175, BO-176 | `verified_browser` | Actual Overview, Tasks, Chat, Knowledge/Files, Connections/Computer, Activity/Settings routes; `workspace-http.ts`, `server/web/workspace.ts`; complete matrix plus edit/close, source versions, downloads, account disable and takeover-status interactions, FINAL/MATRIX. |
| BO-178 | `verified_browser` | Mobile/desktop stop, forms, loading/error/offline states; actual viewport assertions and checkpoints, FINAL/MATRIX. |
| BO-180, BO-182 | `verified_browser` | Typed owner routes, fixed provenance/client-ID dedupe, cursor pagination and visible-page polling; multitab/reload/immediate/deferred history scenarios, FINAL/MATRIX. |
| BO-184 | `verified_deterministic` | Durable service/outbox transport projection and `cli/src/commands/chat.ts` pending-reply output; signed transport/history and CLI tests, FINAL/CLI. This does not clear BO-128 crash/identity gaps. |

### Visibility and recovery — 4 rows

| IDs | Status | Implementation / scenario / evidence |
|---|---|---|
| BO-187 | `verified_deterministic` | Coordinator→AuditLog bridge, action evidence/timestamps and stream usage; `business-usage.ts`, store/activity; FINAL/MATRIX. |
| BO-189 | `implementation_gap` | Export and deliberate stopped/disconnected deletion exist and pass; however deleted source facts remain in active runtime context. See gap 3. |
| BO-191 | `verified_deterministic` | `core/src/business-recovery.ts`, CLI business commands; SQLite snapshot, immutable manifests, retention and stopped restore/no replay, CORE/CLI/FINAL. Post-snapshot provider-history investigation is manual, not automated live proof. |
| BO-193 | `blocked_security_review` | Documented limitations and exercised boundaries do not replace pending independent review or eliminate model/provider risks. |

### Stateful harness — 15 rows

| IDs | Status | Implementation / scenario / evidence |
|---|---|---|
| BO-196, BO-198 | `verified_deterministic` | `testing/scenario-app.ts`, pinned `emulate@0.12.3`; real boot/runtime/store/HTTP with controlled model/external boundaries; FINAL contracts/workflows. |
| BO-200, BO-202 | `verified_deterministic` | `testing/emulators/calendar.ts`, `composio.ts`, `google.ts`; canonical event state, conditional conflicts and loud unsupported operations; FINAL provider contracts. |
| BO-204 | `blocked_live` | `testing/emulators/CONTRACT-COVERAGE.md` and retained upstream-gap tests exist. The table explicitly has **no separately captured live observations**; those remain required external proof. |
| BO-206, BO-208, BO-210 | `verified_deterministic` | Controller-only restart, fresh synthetic state, faults and exact-origin/global+injected/browser guards; scenario app, isolation and emulator controls; FINAL security/provider/workflow tests. |
| BO-212 | `blocked_security_review` | Harness limitation disclosures correctly distinguish faux-model behavior from planning/injection resistance; independent current review remains pending. |
| BO-215, BO-217 | `verified_deterministic` | Requested test-only modules and real-boot seams; explicit apps adapter forwarding and real MCP transport; FINAL. |
| BO-219 | `blocked_live` | Production signed Inkbox transport and SSRF rejection exercised locally. Required actual allowed-media attachment download is not exercised. |
| BO-221, BO-223 | `verified_deterministic` | Production Maritime backend over fixture HTTP MCP, readiness assertions, compiled assets and teardown/restart; FINAL provider/workflow/browser tests. No real shell execution. |
| BO-225 | `verified_deterministic` | Root/server focused scripts, pinned emulator/direct MCP dependency and Vitest include configuration; source inspection plus FINAL/BUILD. |

### Browser and CI — 9 rows

| IDs | Status | Implementation / scenario / evidence |
|---|---|---|
| BO-229, BO-231, BO-233 | `verified_browser` | `playwright.config.ts`, pinned Playwright, fixtures/specs and production-output exclusions; exact desktop/mobile projects, serial/no-retry runner; FINAL/MATRIX. |
| BO-235, BO-237 | `verified_browser` | Complete screen/state/theme checkpoints follow meaningful persisted interactions; `workspace.spec.ts`, `changed-flows.spec.ts`, `customer-lifecycle.spec.ts`; FINAL/MATRIX. |
| BO-239 | `verified_browser` | `evidence-manifest.ts`, `evidence-reporter.ts`, sanitized trace pipeline and escaped index; FINAL/MATRIX/NEGATIVE. Current publication evidence replaces unsafe historical SEC-7 artifacts. |
| BO-241, BO-243, BO-245 | `verified_deterministic` | `.github/workflows/ci.yml`, PR template, ignore rules: read-only permissions, ephemeral runners, disabled checkout credential persistence, existing build reuse, gated allowlisted upload, retention and summary link. **Configuration inspected; no actual GitHub run/artifact URL is claimed.** |

### Security gate — 3 rows

| IDs | Status | Implementation / scenario / evidence |
|---|---|---|
| BO-248 | `verified_deterministic` | Existing Gitleaks/source-pattern scans retained; new harness/e2e paths not broadly exempted; SCAN/FINAL/NEGATIVE. |
| BO-250, BO-252 | `blocked_security_review` | Historical independent reports exist; latest integrated fixes and publication negatives are available, but current independent final review has not returned. |

### Sequence and integration anchors — 11 rows

| IDs | Status | Implementation / scenario / evidence |
|---|---|---|
| BO-256 | `verified_deterministic` | Shared types/store/coordinator/contracts, runtime pins and acceptance ledger established; BUILD/source inspection. |
| BO-257 | `verified_deterministic` | `testing/vertical-slice.mjs`, `evidence/vertical-slice.json`; subsequent real registered-tool admission/write/result and stop/restart cases, FINAL. |
| BO-258 | `verified_deterministic` | Integrated knowledge/provider/computer/harness slices use shared coordinator/store; FINAL real-boot workflows. Does not waive specific defects above. |
| BO-259 | `verified_browser` | Shared texting/browser services and actual compiled UI matrix; FINAL/MATRIX. |
| BO-260 | `blocked_security_review` | Integrated deterministic/browser reruns now pass; final independent review and newly identified gaps remain unresolved. |
| BO-261 | `blocked_live` | Mandatory real model/provider scenarios unexercised; LIVE. |
| BO-264, BO-265 | `verified_deterministic` | `core/src/tools.ts` registered dispatcher and boot apps-adapter forwarding exercised unchanged by scenarios; FINAL. |
| BO-266 | `verified_browser` | Existing HTTP/authenticated owner ingress and direct stop; FINAL/MATRIX. Busy-inbox signed-stop proof remains separately held under BO-095. |
| BO-267, BO-268 | `verified_deterministic` | Existing trusted CI and narrow Gitleaks configuration; source inspection, FINAL/NEGATIVE/SCAN. |

### Verification and acceptance — 27 rows

| IDs | Status | Implementation / scenario / evidence |
|---|---|---|
| BO-271 | `blocked_live` | Contract explicitly requires live paths before implementation acceptance; LIVE. |
| BO-273 | `verified_deterministic` | BUILD plus latest affected-package FINAL, CORE/CLI and smoke/browser evidence. Report this as recorded integrated/component reruns, not an invented fresh single full-suite pass. |
| BO-275 | `verified_browser` | Actual fixture Gmail/Calendar outcomes, uncertainty/restart/no resend, reply suppression and direct stop shown in real UI; FINAL/MATRIX. |
| BO-277 | `verified_browser` | Wrong signature/origin/nonfixture/unsupported operation negatives plus deliberately failed browser case, retained sanitized diagnostics and complete matrix; FINAL/NEGATIVE/MATRIX. |
| BO-279 | `verified_deterministic` | Actual state/bytes/provider-map assertions and explicit emulated/browser/live classification in scenarios/manifests; FINAL/CORE. |
| BO-281 | `blocked_security_review` | Regression-group header; children contain actual gaps and incomplete proof. Not an independent pass. |
| BO-282 | `verified_deterministic` | Duplicate admission, competing claims, source/task/control/account fences and normalized Gmail effects; workflows/dispatch boundaries, FINAL. |
| BO-283 | `blocked_security_review` | Gmail/shell restart uncertainty is exercised, but a full process-kill matrix around preparation/acceptance/readback was not located. Do not equate graceful fixture restart with every crash phase. |
| BO-284 | `blocked_security_review` | Autonomous effects and imported-policy refusal pass; forged/group/delegated negatives partly call authority services directly rather than every complete ingress path; final review pending. |
| BO-285 | `verified_deterministic` | Scoped conflicts, stale/evidence-only rate blockers, exact arithmetic, recipient readback, timezone and cross-workspace isolation cases; FINAL/CORE. |
| BO-286 | `verified_deterministic` | Reply/intervention/opt-out suppression, downtime occurrence dedupe, Calendar stale-etag and wrong-readback refusal; FINAL/MATRIX. |
| BO-287 | `verified_browser` | Direct stop through blocked model, restart persistence, late in-flight result and stopped restore/no replay; FINAL/MATRIX/CORE. |
| BO-288 | `implementation_gap` | Auth/path/archive negatives pass, but configured storage overlap violates unconditional controller-state exclusion. |
| BO-289 | `verified_browser` | Independent cursor readers, repeated client IDs, multiple tabs and immediate/deferred history after reload; FINAL/MATRIX. |
| BO-290 | `blocked_live` | Fixture disable/revoke/substitution passes. Actual provider auth/reconnect remains unavailable; **arbitrary-cwd deployment-image execution also lacks recorded proof**. Source packaging is not image execution evidence. |
| BO-291 | `implementation_gap` | Budget/first-wait/challenge tests pass, but successive wait cursor reuse remains incorrect. |
| BO-294 | `blocked_live` | Shared real-scenario prerequisites; updated LIVE artifact. |
| BO-296, BO-297, BO-298, BO-299, BO-300, BO-301, BO-302, BO-303, BO-304 | `blocked_live` | Exact dependencies below and in updated LIVE artifact. |
| BO-306 | `implementation_gap` | Reachable implementation gaps above prevent claiming all locally reachable work complete. Live blockers remain separate. |

### Source references — 13 rows

Keep **BO-309, BO-310, BO-311, BO-312, BO-313, BO-314, BO-315, BO-316, BO-318, BO-319, BO-320, BO-321, BO-322** as `reference`. They retain source URLs, not behavioral evidence; do not convert them to passing requirements.

## Exact live dependencies

| ID | Still required |
|---|---|
| BO-296 | Available supported model, Inkbox consenting owner phone, Composio Google OAuth and canonical HTTPS owner route; locally generate owner token. |
| BO-297 | Model, Inkbox, isolated Gmail account, consenting separate recipient and sourced test terms; actual Sent readback and recipient receipt. |
| BO-298 | Model, isolated real Gmail thread/recipient, controlled one-minute follow-up configuration; exercise both no-reply chase and reply-before-due suppression across restart. |
| BO-299 | Model, isolated Calendar, consenting attendee, agreed test time and sourced duration; actual insert/update/cancel/readback. |
| BO-300 | Model, authorized mail/calendar/documents/research sources and hosted computer; real generic brief/research/PDF/spreadsheet workflow. Local SHEET/VISUAL proof is supporting evidence only. |
| BO-301 | Separate Maritime Computers entitlement/credential and authorized portal task/account; real action, office conversion, takeover privacy and controller-mount inspection. |
| BO-302 | Model, Inkbox owner phone, authorized effectful test provider and HTTPS route; web/text stop during real active work, restart and explicit safe resume. |
| BO-303 | Composio OAuth test account, Inkbox and HTTPS route; real disable/reconnect intended identity plus refreshed history/artifacts. |
| BO-304 | Isolated live state produced by preceding scenarios and authorized provider readback accounts; restored stopped state, real prior-effect reconciliation and no duplicate sends. |

## Proof gaps that are not established implementation defects

Do not silently infer these from suite totals:

- Dedicated `init --business` default-toolkit/explicit-toolkit/re-init matrix.
- Signed-text priority control while the durable inbox handler is blocked.
- Full two-worker/one-computer contention, 12-dispatch, reasoning-deadline and three-no-progress matrix.
- Process-kill effect-phase matrix, including generic browser submission.
- Exhaustive completion-criterion/fabricated-reference negatives.
- Enforcement/proof of total selected-model tool-count limits; current runtime binds visible tools and boot warns on overflow.
- Actual arbitrary-cwd deployment-image execution.
- Current independent security clearance.
- All nine live scenarios.

Detailed subordinate source/scenario assessments remain available at:

- `agent://AcceptanceMappingAudit.AuditCoreAcceptance` — 49 IDs, exact test names and source locations.
- `agent://AcceptanceMappingAudit.AuditProviderKnowledge` — 25 IDs, exact provider/document/recovery mappings.

Those reports predate the final evidence update; use **FINAL/SHEET/VISUAL/NEGATIVE above** where they supersede earlier counts or limitations.

**Overall correctness: incorrect.** The ledger can now be made concrete, but reachable implementation gaps, pending independent security clearance and unavailable live proof prevent complete acceptance. **Confidence: 0.97.**

**Correction to the preceding proposal:** I read `docs/business-owner/evidence/security-review-final.md`. The independent security gate **PASS applies to the reviewed integrated implementation and emulator-backed evidence**, and **SEC-1 through SEC-7 are closed**. Historical “not passed,” “not requested,” and pending-review wording must not remain current.

The final review explicitly does **not** establish whole-plan completion, live-provider readiness, every external execution boundary, or repository-required human approval.

## Status overrides

Apply these overrides to the preceding complete 177-row mapping; its other mappings remain unchanged.

| IDs | Revised proposed status | Reason / evidence |
|---|---|---|
| BO-017 | `verified_deterministic` | Stateful development, actual browser evidence and independent review now evidenced. Add `security-review-final.md` alongside FINAL/MATRIX. |
| BO-118, BO-124, BO-126 | `verified_deterministic` | Reviewed mode-aware restrictions, final dispatch fences, credential/privacy boundaries and relevant negatives have cleared the independent gate. Preserve the review’s scope qualifications. |
| BO-193, BO-212 | `verified_deterministic` | Risk/fixture limitations are explicit; independent review is complete for its stated scope. Neither row establishes perfectly safe autonomy or a malicious-code sandbox. |
| BO-250, BO-252 | `verified_deterministic` | Independent review performed; SEC-1–7 closed with inspected source and negative evidence. Cite **`docs/business-owner/evidence/security-review-final.md`** as the current disposition. |
| BO-029 | `blocked_live` | Security-review prerequisite is cleared. Actual hosted mounting/credential isolation remains unexercised; preserve the final review’s separate Ample-isolation uncertainty. |
| BO-006 | `implementation_gap` | The newly identified successive-question, active-context and notification defects remain reachable acceptance issues—not an outstanding SEC-1–7 review. |
| BO-260 | `implementation_gap` | Integrated checks and the independent gate passed, but this acceptance audit identified additional reachable defects requiring resolution. |
| BO-281 | `implementation_gap` | Aggregate deterministic-regression heading inherits confirmed child gaps, notably BO-288 and BO-291. |
| BO-095, BO-097, BO-283, BO-284 | **Concrete verification hold, not security-review hold** | The specific missing assertions described below are not supplied by the security PASS. Do not mark these fully verified solely because that gate passed. |

### Four verification-only holds

The requested status vocabulary has no accurate category for **implemented behavior whose explicitly required deterministic proof is incomplete**. Use `verification_gap`, or retain `in_progress` with concrete `blockerKind: verification_gap` and the following notes if the ledger must preserve its existing enum. **Do not retain `blocked_security_review` for these rows.**

- **BO-095:** No located signed-text priority-stop scenario with an already-blocked durable inbox handler. Direct HTTP stop and source wiring are evidenced.
- **BO-097:** No located complete two-worker/one-computer contention, 12-dispatch, reasoning-deadline and three-no-progress regression matrix.
- **BO-283:** No located process-kill matrix at the required effect phases or distinct generic-browser-submission crash case. Observed-uncertainty restart tests are narrower.
- **BO-284:** Some forged-email/group/delegated-principal negatives invoke authority services directly rather than exercising each complete ingress-to-runtime path. The tested boundaries and independent review remain valid evidence.

## Revised exhaustive census

| Classification | Rows |
|---|---:|
| `verified_deterministic` | 80 |
| `verified_browser` | 36 |
| `blocked_live` | 29 |
| `implementation_gap` | 15 |
| Concrete verification-only holds | 4 |
| Existing `reference` | 13 |
| `blocked_security_review` | **0** |
| **Total assessed** | **177** |

All nine mandatory live scenarios remain `blocked_live`, with the exact dependencies in the updated `live-prerequisites.json`. The locally generated owner token is setup, not an externally missing credential.

**The six source-backed implementation issues in my preceding report are not retracted by the independent gate’s narrower PASS.** They were separately traced in this acceptance audit; none was asserted to be an unresolved SEC-1–7 finding. They should be resolved or explicitly adjudicated before declaring whole-plan acceptance.

The artifact-writing limitation is unchanged: no write tool is exposed to this read-only reviewer, so **no `local://acceptance-mapping-proposal.json` creation is claimed**.

**Overall correctness: incorrect for complete acceptance; independent reviewed security gate: passed. Confidence: 0.97.**