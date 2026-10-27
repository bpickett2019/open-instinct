# Business-owner acceptance record

**Overall acceptance remains blocked by mandatory live-provider proof and deployment-image execution.** Basic authorized owner texting and the real ChatGPT Pro-backed local conversation are verified; comprehensive Google, hosted-computer and business-workflow readiness is not. Nothing was published, deployed or merged.

Canonical contract: [acceptance-contract.md](acceptance-contract.md). Requirement-by-requirement checklist: [acceptance.json](acceptance.json). Integration owner: primary assistant; shared store, authority, coordinator and dispatch contracts remained under that owner. The inspected commit was a reference, not a reset target.

## Live Google connector setup

The isolated `open_instinct_test` Composio project now has managed Calendar and
Gmail auth configurations and a scoped service key stored privately outside the
repository/worker workspace. The private launcher loads that key; actual CLI boot
connected Composio MCP and the existing Inkbox tunnel. In the real authenticated
owner workspace, both apps became ready to connect. Clicking Calendar produced a
real provider link and opened Google's account chooser.

**Calendar OAuth and independently verified account identity now pass.** The real
account-bound proxy read primary-calendar metadata, and the authenticated production
workspace displays Calendar connected before and after a clean idle restart.
Identity-bearing screenshots remain private; public JSON records the identity hash.
No appointments were listed or changed. Isolated test targets, consenting attendee,
agreed time/timezone and duration are still required for live Calendar mutations.
Gmail remains unauthorized.

Live integration exposed two corrected defects in `packages/apps/src/composio.ts`:
the raw v3 session requires `toolkits: { enable: [toolkit] }`, and SDK telemetry
must be disabled to prevent its re-sent SIGTERM interrupting controller cleanup.
The unit contract and stateful emulator now enforce the real request shape;
`packages/server/test/apps-shutdown.test.ts` exercises actual SDK signal behavior
without network access. Both regressions failed before their fixes. The actual
provider also rejected a foreign-workspace account binding without executing an
operation. Independent read-only review found no release-blocking issue in this
scope.

Proxy integration checks passed: 12-package build/typecheck, 178 app tests, 338
server tests, smoke, 34 real Chromium scenarios with emulated providers, and the
publication scan. After the shutdown-only correction, apps build/typecheck, all
178 app tests, the new subprocess regression and smoke passed. The corrected live
pilot exited 0 and restarted with Calendar still connected. This proves neither
live appointment workflows nor full-product readiness.

Credential incident: an initial key appeared in a tool response. It was revoked
before installation, with provider UI confirmation, and replaced with a scoped key
saved directly to a mode-0600 private file without printing it. No Google account
was connected to the project when the initial key was exposed.

Evidence and exact scope: `evidence/google-connection-setup.json`,
`evidence/google-proxy-live-contract.json`, `evidence/google-proxy-live-negative.json`,
`evidence/google-calendar-connected.json`, `evidence/google-calendar-restarted.json`,
`evidence/google-proxy-integrated-checks.txt`,
`evidence/google-shutdown-integrated-checks.txt`, `evidence/google-clean-shutdown.txt`,
`evidence/google-setup-verification.json`,
and `evidence/security-review-google-shutdown.md`.

## Messaging feedback correction

Private owner iMessages now get read feedback after durable admission and bounded,
single-flight typing while the shared foreground assistant composes. It can use
seven named tapbacks, including reaction-only acknowledgements without an error
text or task. Current-message-only courtesy authority is separate from existing
dispatcher-governed delegated reactions. Group/nonowner/SMS/web/guidance boundaries,
stop, uncertain acceptance, duplicate admission and restart remain fenced.

Verification: `pnpm typecheck`, `pnpm test` (1,590 passed, one existing skip), and
`pnpm smoke` passed. After adding the delegated-reaction regression, the final
17-case messaging scenario suite, 34 real-Chromium desktop/mobile tests and
publication scan passed. The browser matrix contains 128 checkpoints; providers
and model responses in those tests are emulated, not live-provider proof.
Standalone Node smoke also exercised production signed ingress, runtime and tools
against isolated stateful providers. The independent read-only review found no
release-blocking findings in this scope.

The updated ChatGPT Pro/Inkbox local pilot is running. **The owner confirmed the
fresh phone probe: “Okay that worked.”** Authenticated durable activity records
accepted read feedback and the requested `like` reaction. This is a real-provider
exchange plus owner-reported phone success, not an independently captured phone
screenshot. Seven-reaction coverage and failure/restart cases remain emulator-backed.
See `evidence/messaging-feedback-live-confirmation.json`. The broader mandatory
live-provider and deployment-image gates remain unchanged.

Records: `evidence/messaging-feedback-verification.json`,
`evidence/messaging-feedback-consolidated-checks.txt`,
`evidence/messaging-feedback-browser-checks.txt`,
`evidence/messaging-feedback-runtime-smoke.json`, and
`evidence/security-review-messaging-feedback.md`. Requirement mapping and live
status: `messagingFeedbackCorrection` in `acceptance.json`.

## Conversational in-app onboarding correction

The default `/workspace` route now opens the shared assistant conversation.
The assistant starts without an owner-written prompt; ordinary free-form replies
use the same runtime and history as texting. It can save several explicit facts
from one message, answer questions and change direction rather than follow a
fixed sequence. Facts, citations, app readiness and advanced edits are secondary
controls. Opening itself exposes no executable tools and grants no work authority.

- Implementation: core `runtime.ts`; server `business-service.ts`,
  `business-onboarding.ts`, `business-knowledge-tools.ts`, `workspace-http.ts`,
  `boot.ts`, `web/workspace.ts`/CSS; existing onboarding skill.
- All 12 package builds/typechecks passed; core **332 passed**; server **321 passed**;
  smoke passed. Final canonical-opening scenarios: **9 passed**.
- The complete Chromium run passed **34 tests / 128 checkpoints**, with no
  missing cases, failures or capture errors. Publication scan passed 260 files
  and four archive entries. This matrix uses emulated providers and model choices.
- Live visual inspection then exposed initial history opening at its oldest
  message. That was fixed and the **four affected desktop/mobile light/dark
  workspace flows passed again**. This follow-up is recorded separately, not
  silently merged into the earlier single-run matrix.
- Real ChatGPT Pro-backed opening: “What kind of business are we setting up?”
  Asked to start with the owner's needs instead of collecting details, it answered:
  “Yes. What’s the main thing you’d like me to take off your plate?”
  No facts or tasks were created. Actual desktop (1440×1000) and mobile-viewport
  (390×844) states were inspected; latest replies were visible and mobile had no
  horizontal overflow.
- Graceful live controller restart retained all 12 message IDs, exactly one
  opening answer, and unchanged model usage. Emulator recovery also covers an
  unfinished durable phase snapshot; that specific case is not a SIGKILL claim.
- Earlier failed checks are retained. The fixture was corrected to use Pi's
  current tool declarations from transcript deltas. Incidental tests assuming no
  model usage were removed; pricing-unknown and owner-budget enforcement were
  not weakened.
- Independent read-only security review passed the scoped implementation and
  supplied evidence with no release-blocking findings. This does not replace the
  outstanding live-provider or deployment-image security gates.

[Implementation, commands and scoped evidence](evidence/conversational-onboarding-verification.json) ·
[Complete browser gate](evidence/conversational-onboarding-browser-gate.txt) ·
[Post-scroll affected checks](evidence/conversational-onboarding-scroll-checks.txt) ·
[Independent security review](evidence/security-review-conversational-onboarding.md) ·
[Live desktop](evidence/conversational-onboarding-live-desktop.png) ·
[Live mobile viewport](evidence/conversational-onboarding-live-mobile.png).

This revision does not establish live Google, hosted-computer, revocation or full
business-workflow readiness. Those mandatory gates remain blocked below.

## Earlier onboarding and revocation revision

The owner no longer receives a technical persistence receipt for a greeting.
Texting and the owner workspace share saved facts and one next question. Named
Gmail/Calendar actions use actual provider links, verify account identity
automatically and preserve unsaved answers/focus during refresh. Missing provider
infrastructure remains explicit and does not block learning the business.
Connecting does not enable routines or authorize historical-message scans.

- Implementation: `business-onboarding.ts`, `business-service.ts`,
  `business-owner-tools.ts`, `workspace-http.ts`, `boot.ts`, `setup-summary.ts`,
  server `web/workspace.ts`/CSS, apps `business-providers.ts`, and the existing
  `business-onboarding` skill.
- Full build/typecheck: all 12 packages passed. Consolidated package tests:
  **1,519 passed, one Darwin skip**, followed by smoke. This run preceded the
  security repair and removal of three wording-only setup tests.
- After the repair: apps 177 passed; server's affected run had one 5-second
  harness timeout in the 13-dispatch scenario. Its consumer-visible assertions
  were unchanged, its harness deadline was made 15 seconds, and all 13 operational
  cases passed. Final reconnect security cases: 6 passed. Onboarding:
  6 boundary cases and 3 stateful HTTP/carrier scenarios passed.
- Final real Chromium matrix: **34 passed, 124 checkpoints, no missing cases or
  capture errors**. Publication scan: 252 files, four archive entries, passed.
  Desktop pending authorization and mobile connected/draft-preservation images
  were visually inspected. This is emulator-backed provider evidence.
- The real local Pro-backed browser conversation returned exactly
  “What name should I use for your business?” without a technical receipt.
  No facts, tasks or external customer work were requested for this probe.
  The private profile remained version 0 with zero facts. Missing Gmail/Calendar
  and hosted-computer readiness was also inspected in the real running UI.
- Independent read-only review found a stale OAuth intent could undo disconnect.
  Cancellation is now transactional; late links and identity reads are fenced;
  unresolved revocation cannot re-enable the same account. Four failing-before
  cases and six final passing cases are retained. The reviewer closed the finding
  with no remaining blocker in that scope. Notices are durable and deduped, not
  guaranteed carrier delivery after an uncertain send.

[Revision record and commands](evidence/onboarding-verification.json) ·
[Build/typecheck](evidence/onboarding-build-typecheck.txt) ·
[Consolidated tests/smoke](evidence/onboarding-package-smoke.txt) ·
[Final affected checks, browser and scan](evidence/onboarding-final-checks.txt) ·
[Security review](evidence/security-review-onboarding.md).

The sections below retain historical baseline verification. Current mandatory
live gaps remain authoritative in [live prerequisites](evidence/live-prerequisites.json).


## Implementation locations

| Area | Locations |
|---|---|
| Shared durable authority, actions, reservations and recovery | `packages/core/src/business-*.ts`, `tools.ts`, `runtime.ts`, `policy.ts`; `packages/server/src/business-coordinator.ts`, `business-service.ts` |
| Owner workspace and common text/web admission | `packages/server/src/http.ts`, `workspace-*.ts`, `business-outbox.ts`, `business-owner-tools.ts`, `web/`; `packages/inkbox/src/`; `packages/cli/src/commands/business.ts` |
| Knowledge, immutable artifacts, extraction and hosted transfer | `packages/server/src/business-knowledge.ts`, `business-extraction.ts`, `business-files.ts`, `business-hosted-artifacts.ts` |
| Google/apps, money, delegation and isolated computer boundaries | `packages/apps/src/business-providers.ts`, `google-workspace.ts`; `packages/payments/src/`; `packages/network/src/`; `packages/computer/src/`; `packages/ample/src/` |
| Routines, waits, owner controls and operational visibility | `packages/server/src/business-commitments.ts`, `business-coordinator.ts`, `business-service.ts`, workspace routes/views; core private store |
| Stateful verification and CI | `packages/server/testing/`, `test/contracts/`, `test/scenarios/`, `e2e/`, `scripts/check-evidence.mjs`; `.github/workflows/ci.yml` |

Specific requirement mappings and qualifications belong in the checklist; a directory appearing here is not itself proof of every feature.

## Historical baseline verification

Commands were invoked with `npm exec --yes --package=pnpm@10.6.1 -- pnpm` because the checkout's pinned pnpm was not globally installed.

| Check | Observed result | Evidence |
|---|---|---|
| Consolidated build and package typechecks | All 12 packages passed; final core/server changes rebuilt and rechecked | [repair build/typecheck](evidence/acceptance-repairs-build-tests.txt), [final affected integration](evidence/acceptance-final-integrated.txt) |
| Consolidated `pnpm test` | Latest consolidated run exposed a test-helper wall-clock timeout; corrected to a monotonic wait clock, then server and CLI passed. Earlier real defects and failing-before outputs remain retained | [repair runs](evidence/acceptance-repairs-build-tests.txt), [initial output](evidence/consolidated-tests-initial.txt) |
| Latest package suites, across integrated runs | Core 315; server 302; apps 172; Inkbox 206; CLI 105; payments 82; network 77; gateway 67; AtomicMail 53; computer 50; Ample 36; context 3. **1,468 passed**, one Windows-only test skipped on Darwin | [full-package/CLI records](evidence/acceptance-repairs-build-tests.txt), [final core/server](evidence/acceptance-final-integrated.txt) |
| Acceptance repairs and operational/crash regressions | State/wait/profile/notification boundaries 9; open-thread recovery 5; operational limits/ingress/completion 13; actual SIGKILL phases 8. Gmail and generic hosted submission each cover all four crash phases | [final output](evidence/acceptance-final-integrated.txt), [failing-before](evidence/acceptance-boundaries-failing-before.txt) |
| `pnpm smoke` | Actual personal-runtime smoke passed, including nonowner isolation, A2A, scheduling and real PDF bytes | [final output](evidence/acceptance-final-integrated.txt) |
| Authenticated durable vertical slice | 11 checks passed: admission, persisted action, independent bytes, restart and durable stop | [vertical slice](evidence/vertical-slice.json) |
| Final standalone business action smoke | Authenticated HTTP admission → registered Pi write → persisted verified action → byte-exact artifact download → Stop/restart → one retained action, no replay | [final action smoke](evidence/final-action-smoke.json) |
| Compiled CLI/main from unrelated cwd | Node 25.8.1 and pinned 22.22.3 passed isolated initialization, authenticated workspace/assets, unauthorized rejection, Stop and restart with zero provider requests; not container-image proof | [packaged smoke](evidence/packaged-cwd-smoke.json) |
| `pnpm test:e2e` | 34 passed after final boundary repairs; 116 current matrix checkpoints, no missing cases or capture errors | [raw final output](evidence/acceptance-final-integrated.txt), [manifest](../../packages/server/evidence/manifest.json), [gallery](../../packages/server/evidence/index.html) |
| Deliberate failure during private text entry | Expected exit 1 at the intentional assertion; useful masked failure screenshot and sanitized trace retained | [negative command](evidence/canary-final-negative-exit.txt), [inspected privacy proof](evidence/negative-browser.json) |
| Exact publication scan | Refreshed normal report/gallery: 236 files, four archive entries. Negative case: seven files, six entries. Passed; trace resources/screencasts are forbidden | [publication record](evidence/publication-final.txt), [negative proof](evidence/negative-browser.json) |
| Gitleaks 8.30.1 | History: 82 commits, no leaks. Final nonignored working-tree snapshot: 481 files, 3,124,650 scanned bytes, no leaks. Official binary checksum verified before use | [history](evidence/gitleaks-history.json), [working tree](evidence/gitleaks-working-tree.json), [scan output](evidence/gitleaks-working-tree-output.txt) |

The final affected command chain was:

```sh
pnpm --filter @open-instinct/core build
pnpm --filter @open-instinct/server build
pnpm --filter @open-instinct/core typecheck
pnpm --filter @open-instinct/server typecheck
pnpm --filter @open-instinct/core test
pnpm --filter @open-instinct/server test
pnpm smoke
pnpm test:e2e
pnpm --filter @open-instinct/server exec node scripts/check-evidence.mjs
```

The negative was run with `INSTINCT_EVIDENCE_NEGATIVE_CASE=1`, `--grep 'intentional semantic assertion' --project=desktop`; its exit 1 is required evidence, not a passing acceptance test. `node scripts/check-evidence.mjs --negative` then checked the exact publishable set. Raw traces, private state and downloaded documents are excluded from CI publication. Public traces retain sanitized events/DOM, not screencast pixels or body/source resources. Failure images mask input fields. CI scans precede upload and suppress unsafe publication even on test failure.

Final audit repairs reject private-state/workspace overlap, persist consumed wait
cursors, remove deleted/superseded facts from active context, maintain account-bound
open-thread recovery, recover interrupted notices as unknown, and bind every fallback
send to a stable message/event/task-step identity. Prepared actions now commit before
attempt markers and can resume without duplicate reservations; attempted effects
remain non-replayable. A 128/129-tool regression proves the conservative
OpenAI-compatible request bound before provider entry. See [shared contracts](integration-contracts.md).

## Browser and deliverable inspection

Actual Chromium interactions exercised authentication, partial onboarding save, durable chat/delegation, a verified file download and direct global stop. Desktop/mobile light/dark evidence covers navigation, forms, errors, offline/expired/disconnected/unknown/stopped states, knowledge, tasks, provider effects and recovery. Independent visual reviews found a stale reconciliation error and sticky-header capture obstruction; both were fixed. Reconciled actions now clear the old error, and full-page captures start at the top. See [desktop review](evidence/visual-desktop-review.md), [mobile review](evidence/visual-mobile-review.md) and [follow-up observations](evidence/visual-followup.json).

- [Generated supplier PDF](evidence/manual-supplier-brief.pdf) was created and registered through the same Pi task system, downloaded from the authenticated workspace and opened in Chromium's PDF viewer. [Rendered page](evidence/manual-supplier-brief-rendered.png): checked synthetic totals 250.00 / 280.00 and difference 30.00.
- [Spreadsheet proof](evidence/spreadsheet/proof.json) transferred real XLSX bytes through the production registered hosted-import boundary with explicitly synthetic MCP transport. HyperFormula 3.1.0 evaluated actual formulas, replacing deliberately wrong cached values 999 / 888 / -111 with 250 / 280 / 30. LibreOffice 26.8.1.1 rendered the resulting PDF, which was opened and visually inspected in Chromium: [rendering](evidence/spreadsheet/rendered-browser.png). Numbers automation and UNO attempts failed; LibreOffice is **not** claimed as the recalculation engine. This is local document-engine evidence, not live hosted-computer proof.

## Independent security gate

**PASS for the reviewed integrated implementation and emulator-backed evidence**, by independent read-only agents. [SEC1–7 disposition](evidence/security-review-final.md); [final boundary follow-up](evidence/security-review-boundaries.md); [initial review](evidence/security-review-initial.md) and [follow-up](evidence/security-review-followup.md) retain earlier failures. The final follow-up independently inspected the current core315/server302/browser34 output and current 116-checkpoint manifest; its scope and qualifications remain explicit.

| Finding | Resolution and exercised boundary |
|---|---|
| SEC-1: effects after authority withdrawal | Final dispatch checks after adapter prerequisites and SDK authentication, including payments, messages/uploads/chunks, multiple recipients, Ample spawn and phone origination. Accepted-before-stop receipts remain truthful. |
| SEC-2: replay after unknown effects | Per-dispatch uncertain-effect fence; no blind retry of ambiguous sends, hosted submissions or task telephone calls. |
| SEC-3: unmetered purchase-cap bypass | Unknown amount/currency and unpriced spend-capable operations fail closed under configured caps. |
| SEC-4: file/path isolation | Canonical confinement, symlink rejection and exclusive business-file creation; new versions preserve prior owner bytes. |
| SEC-5: cosmetically different duplicate Gmail sends | Identity derives from canonical serialized MIME and server-bound occurrence. Equivalent headers, optional fields, line endings and recipient forms cannot resend a completed effect; distinct owner requests remain possible. |
| SEC-6: image cost omitted from model budget | Configured model caps reject unpriced image dispatch; uncapped image use records unknown pricing before invocation. |
| SEC-7: credential pixels in trace resources | Confirmed synthetic canary exposure in an earlier screencast. Old public trace replaced; public trace resources/screencasts now omitted and rejected by scanner. The new failure occurs with the canary still in an unsent textarea; masked screenshot and resource-free trace were independently inspected. |

No remaining concrete blocking finding was identified in that review scope. This is not a complete-vulnerability guarantee or repository-required human approval. Ample's CLI runs on the controller; arbitrary project-code execution there was neither established nor disproved, so hosted-only isolation for that optional path is not claimed. Real hosted-computer/controller isolation still requires the live scenario.

## Mandatory live scenarios: comprehensive proof still blocked

[Exact prerequisite and per-scenario record](evidence/live-prerequisites.json). BO-296 through BO-304 remain incomplete. Basic isolated startup, Pro-backed browser chat and owner text/reply are now verified; Google OAuth and the complete workflows below are not:

1. Actual isolated business startup, text/web onboarding and Google OAuth account identity.
2. Texted source-backed quote, real Gmail Sent verification and consenting recipient receipt.
3. Restarted follow-through: autonomous no-reply chase and reply-before-due suppression.
4. Create/revise/cancel test Calendar invitations with actual attendee/timezone readback.
5. General client brief, cited supplier research, PDF and spreadsheet using the same task system.
6. Real hosted portal/office conversion, takeover privacy and controller/tenant isolation.
7. Workspace and authenticated-text stop during active work, restart and controlled resume.
8. Disconnect/reconnect intended account, refreshed multitab history and artifacts.
9. Snapshot/restore stopped, real prior-effect reconciliation, export and selective retrieval deletion.

Inputs still needed: Composio API/proxy entitlement plus isolated Gmail/Calendar OAuth accounts; a separate consenting email recipient; separate Maritime Computers entitlement/key and an allowed test portal task; canonical HTTPS owner origin. Model sign-in, owner test phone, Inkbox identity/signing credentials and webhook routing are already established in private isolated state. OAuth/MFA/CAPTCHA requires the authorized account holder; never paste secrets into chat or business documents.

Deployment-image execution also remains unexercised. `docker version` found the
installed client but no `desktop-linux` daemon at
`unix://$HOME/.docker/run/docker.sock`; `podman`, `colima` and `limactl` are
absent. Supply an **isolated running Docker-compatible daemon/context**, or explicitly
authorize starting the existing Docker Desktop engine (which may resume unrelated
containers). Then build `deploy/Dockerfile.agent` locally and run the isolated
workspace/assets/restart checks inside that image. Do not push, deploy or use a
production Docker context. Native packaged-process proof is not substituted for this gate.

All local provider evidence is labeled synthetic/emulated. Actual browser rendering is distinct from actual provider service effects. The goal is not complete until the live contract is satisfied; missing credentials do not turn these blocked rows into passes.

## User-selected ChatGPT Pro subscription sign-in

The existing assistant now supports private per-data-directory Codex OAuth, not a
second assistant or a paid API-key fallback. Implementation: core
`chatgpt-subscription.ts`, server `boot.ts` and `business-usage.ts`, CLI
`commands/auth.ts` plus routing/help. Setup: [KEYS.md](../KEYS.md#chatgpt-pro-through-codex-subscription-access)
and [SELF-HOST.md](../SELF-HOST.md#use-a-chatgpt-pro-subscription-instead-of-a-model-api-key).

[Subscription verification](evidence/subscription-verification.json) retains the
actual commands/results: all 12 builds/typechecks passed; current core332,
server307 and CLI125 passed; actual runtime smoke passed. The two subscription
pricing regressions failed before the fix and passed afterward. Obsolete CLI
model-example wording assertions were deleted, not repinned. Packaged CLI
`auth status` and `auth models` ran from an unrelated cwd; neither calls a model.
Global Codex credentials were not read, imported or changed.

Subscription catalog prices are not billed API dollars or remaining plan credits.
Uncapped subscription requests record unknown monetary cost; a configured USD
model cap fails closed. OpenAI controls actual eligibility, limits and credits.
The private evaluation state is `~/.local/share/open-instinct/business-evaluation`.
Independent credential review and actual user login are tracked separately in the
subscription evidence record. No live model access or live business scenario is
claimed by these deterministic checks.

**Live subscription follow-up:** the user completed device authorization. A fresh
CLI status reported a stored login with no refresh required. A real, tool-free
`openai-codex/gpt-6-astra` request returned HTTP 200 and the exact expected reply
`OPEN_INSTINCT_SUBSCRIPTION_OK` (35 input / 11 output tokens). No API-key fallback,
business action or model-configuration change occurred. The independent
[credential security review](evidence/security-review-subscription.md) passed its
stated scope without findings. The throwaway probe was removed. This clears the
model-login prerequisite only; BO-296 through BO-304 and image execution remain
unexercised.

## Requested emulator-only product pass

[Current run record and nine-workflow coverage map](evidence/emulator-request-verification.json).
The isolated controlled-model run used fresh synthetic state and exact allocated
loopback provider origins. It did not use the user's Pro login, real Google/Inkbox/
Maritime accounts, customers or appointments.

- Existing aggregate suite: **1,510 passed, one platform-specific skip**; actual
  runtime smoke passed. [Output](evidence/emulator-request-full-suite.txt).
- Real Chromium workspace: **34 passed**, desktop/mobile and light/dark; **116
  checkpoints**, no missing captures or capture errors.
  [Output](evidence/emulator-request-browser.txt); [gallery](../../packages/server/evidence/index.html).
- Added `server/test/scenarios/follow-through-send.test.ts`: actual emulated Gmail
  sends after controller restart, no downtime burst/duplicate chase, 72-hour
  boundary, two-unanswered cap, independent thread/MIME inventory and no approvals.
- Added `server/test/scenarios/general-delegation.test.ts`: authenticated general
  task, mail/calendar/source-backed brief, actual PDF, hosted-file XLSX import,
  authenticated byte-exact downloads, current source references and restart.
- Fixed a **test-only Maritime binary-file envelope gap**, retaining one canonical
  file map. Production import validation was not changed.
  [Failing-before](evidence/emulator-binary-gap-before.txt).
  After integration, **all 12 targeted cases passed**: ten provider contracts plus
  the two new scenarios. [Output](evidence/emulator-request-integrated.txt).
  A final document-layout-only adjustment was followed by another passing general
  scenario. Do not describe these targeted checks as a fresh full-suite run.
- Opened the generated PDF in Chromium and the actual downloaded XLSX through
  macOS Quick Look's native preview in Chromium. Inspected 222.00 / 255.00 totals,
  33.00 difference, citations and emulated-office disclosure. Fixed duplicate PDF
  heading and narrow workbook fixture columns before the final captures.
  [Artifacts and hashes](evidence/emulator-general/proof.json),
  [PDF rendering](evidence/emulator-general/client-brief-browser.png),
  [workbook rendering](evidence/emulator-general/workbook-browser.png).
- Intentional broken browser assertion exited **1**, with a masked failure
  screenshot and resource-free redacted trace. Both normal and negative
  publication scans passed. This negative run remains labeled failed.
- [Independent read-only security follow-up](evidence/security-review-emulator-request.md):
  **PASS within reviewed scope**, no findings; no live-provider or OS-isolation claim.

All nine product workflow families now have explicitly mapped emulator evidence.
The spreadsheet file and cached values are real; remote LibreOffice execution and
formula recalculation are not established by this emulator case. The original
live-provider and deployment-image gates remain separate and are not marked passed.

## Calendar schedule and conversational-text correction

[Correction record](evidence/calendar-read-tone-correction.json) maps production
locations and private live proofs; [acceptance JSON](acceptance.json) retains both
requirements under `calendarReadAndToneCorrection`.

- Fixed silently dropped Calendar filters in `apps/src/business-providers.ts`.
  Explicit `input.query` fields plus core's upstream `prepareArguments` hook reject
  malformed bounds before SDK null-removal/coercion. Account and dispatch fences
  remain in force. Stateful fixtures cover local-day, all-day and recurrence
  boundaries, pagination and 14 malformed-input cases.
- Server `business-service.ts`, `business-task-tools.ts` and `boot.ts` keep internal
  checkpoints/reconciliation out of owner texts, remove UUID prefixes and use one
  owner-facing result/question channel. Sixteen owner-update regressions cover
  authority, restart, uncertain acceptance and no-replay behavior.
- Actual authenticated Pro-backed owner chat completed one verified Google read
  with Pacific local-day filters and two recurring instances. Main inspected the
  concise rendered result on desktop and mobile. No Calendar events changed.
- One requested copy to the consenting owner's phone was independently read back
  through the identity-scoped Inkbox API: exact text, recipient and conversation
  matched, with provider `delivered` / read status. It was not resent. The task
  initially waited silently; after operator readback the verification task was
  closed through the UI. No durable tool receipt was rewritten or automatic
  reconciliation capability invented. Private event/message evidence stays outside
  the repository.
- Independent [security review](evidence/security-review-calendar-read.md):
  scoped PASS, no findings. Private live observations are Main-observed, not an
  independent security-review claim.

Commands actually run from `/tmp/open-instinct`:

| Command | Result |
| --- | --- |
| `pnpm --filter @open-instinct/server exec vitest run test/scenarios/calendar-read.test.ts -t 'rejects misplaced' --maxWorkers=1 --no-file-parallelism` | Failing-before regression: malformed filters incorrectly succeeded. |
| `pnpm typecheck && pnpm test && pnpm smoke && pnpm test:e2e && pnpm --filter @open-instinct/server exec node scripts/check-evidence.mjs` | Build/typecheck passed; stopped at SDK coercion regression. Later commands did not execute. |
| `pnpm typecheck && pnpm --filter @open-instinct/core test && pnpm --filter @open-instinct/apps test && pnpm --filter @open-instinct/server test && pnpm --filter @open-instinct/cli test && pnpm smoke && pnpm test:e2e && pnpm --filter @open-instinct/server exec node scripts/check-evidence.mjs` | Twelve-package build/typecheck, core334/apps178/server371/CLI125 and smoke passed; browser33 passed/1 failed, so publication scan did not execute. |
| `pnpm --filter @open-instinct/server exec playwright test --config playwright.config.ts e2e/customer-lifecycle.spec.ts --project=mobile --grep 'source quote.*dark' --repeat-each=4 --reporter=list --output=/tmp/open-instinct-calendar-browser-diagnostic` | Four diagnostic cases passed. |
| `pnpm --filter @open-instinct/server exec playwright test --config playwright.config.ts e2e/customer-lifecycle.spec.ts --project=mobile --repeat-each=2 --reporter=list --output=/tmp/open-instinct-calendar-browser-diagnostic` | Twelve sequence-diagnostic cases passed. |
| `pnpm test:e2e && pnpm --filter @open-instinct/server exec node scripts/check-evidence.mjs` | Final34 passed after removing temporary diagnostics; 128/128 captures, no capture errors; publication scan passed. |

The first browser quote failure remains preserved and unexplained, not relabeled
passed. Diagnostic code/output scaffolding was removed after saving results.
The corrected local pilot restarted cleanly and remains running. This correction
does not clear the separate mandatory live-write, Gmail, hosted-computer, HTTPS,
deployment-image or full-product readiness gates.

## Public source publication

The public copy intentionally omits three local evidence files:
`evidence/phone-setup.json`, `evidence/google-clean-shutdown.txt`, and
`evidence/google-connector-auth-configs.png`. They contain live account/contact,
session or provider-configuration metadata. Historical references to these files
remain provenance pointers, not claims that the private originals are published.
Private state paths are represented as `$PRIVATE_STATE`; identity-derived hashes
are withheld in public copies. Original evidence is retained locally.

The supplied source snapshot lacked Git metadata and some implementation files.
Publication uses a fresh checkout of the unchanged inspected GitHub baseline,
preserves all supplied source changes, and restores missing implementation files
from successful historical write payloads and edit snapshots/diffs. Removed
temporary probes are not restored. This is source recovery, not a new design or
a claim that blocked live-product acceptance gates have passed.

Recovery provenance for all 32 restored files is in
`evidence/source-publication-recovery.json`. The reconstructed checkout passed
`pnpm typecheck && pnpm test && pnpm smoke`; output is retained in
`evidence/source-publication-checks.txt`. Three obsolete setup-summary wording
assertions briefly reappeared from the baseline and were removed again, matching
the historical deletion. Subsequent server/browser verification is separate.

Final publication verification: server371 passed, browser34 passed, and the exact
browser-evidence publication scan passed (260 files, four expanded archive
entries). Output: `evidence/source-publication-final.txt`. Gitleaks found no leaks
in the staged publication export. Source whitespace checks passed; historical raw
evidence logs retain their original whitespace. No new live-provider actions were
performed for publication.
