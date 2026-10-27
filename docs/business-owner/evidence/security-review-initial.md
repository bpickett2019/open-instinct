## Yield — Security gate status

**BLOCKED / NOT PASSED.** Independent read-only agent review completed. Four code findings survive review; three affect external-effect authorization/accounting. Their exploit paths are established by source inspection, but **were not executed**. Parent must implement fixes and supply passing negative regressions before gate reconsideration.

No edits, tests, builds, payload execution, or network calls were performed. This review does not replace repository-required human approval.

All paths below are relative to `open-instinct/`.

## Yield — Prioritized findings

### SEC-1 — High: Google effects can be submitted after stop/cancel while adapter prerequisites are pending

**Locations**
- `packages/apps/src/business-providers.ts:120-124,175-182`: Google transport’s `assertActive` checks only connection state; execution ignores the dispatcher’s abort signal.
- `packages/apps/src/composio.ts:230-255`: account/session awaits precede the actual proxy submission; the final check is that connection-only callback.
- `packages/apps/src/google-workspace.ts:120-146`: Calendar insert/update perform availability/read awaits before POST/PUT.
- `packages/server/src/business-coordinator.ts:135-137`: task/global fence is checked before entering the adapter, not at its eventual network-effect boundary.

**Control/exploit path:** An authorized or prompt-influenced worker proposes a Gmail send or Calendar write. Hold the account lookup, proxy-session creation, or Calendar availability response; the owner stops/cancels the task during that await. Releasing the response still permits the write request: its adapter checks the connection, but not the cancelled task, changed global epoch, source revisions, or aborted signal.

This is distinguishable from an already-accepted external request finishing late: **the consequential request has not yet been submitted when stop occurs.**

**Impact:** Sends, invitations, or calendar changes can begin after owner revocation of execution authority. Settings/source changes during the same window have analogous stale-authority risk.

**Minimal fix:** Carry a server-bound execution-fence callback and abort signal through the operation transport. Recheck task/global/source/account fences immediately before each consequential provider submission, after prerequisite awaits; propagate cancellation into fetch. Preserve truthful accounting for requests already submitted.

**Negative regression:** Gate the production Google adapter’s prerequisite response, pause/cancel through authenticated owner control, release the gate, and assert **zero subsequent send/insert/update requests** in independently recorded provider state. Separately retain the existing late-success case for a request accepted before stop.

---

### SEC-2 — High: Uncertain effects do not fence subsequent effects within the same worker run

**Locations**
- `packages/server/src/business-coordinator.ts:66-71`: unresolved-effect rejection exists at `claimRun`.
- `packages/server/src/business-coordinator.ts:108-125,148-160`: dispatch checks only the proposed step’s previous record; uncertainty does not invalidate the current binding, and the serialization marker is removed afterward.
- `packages/core/src/runtime.ts:1195`: effect identity is a hash of model-supplied tool name and arguments.
- `packages/apps/src/business-providers.ts:149-160`: send preparation derives a new identity from the request arguments.

**Control/exploit path:** A Gmail send is accepted but its response is lost. The action becomes `unknown`, while its current task/run remains eligible for further dispatch. A subsequent proposal in that run with a small argument change—such as trailing body whitespace—gets a different step hash and generated Message-ID. It bypasses the previous-step lookup and can send again before reconciliation.

The restart guard does not protect this same-run path. The existing workflow tests at `packages/server/test/scenarios/workflows.test.ts:33-41` exercise restart after uncertainty, not an immediate changed-argument retry.

**Impact:** A recovering or prompt-influenced model can duplicate customer communications or other uncertain effects despite the no-replay contract.

**Minimal fix:** Before every new effectful dispatch, transactionally reject unresolved prior consequential actions for that task. Preserve safe inspection/reconciliation paths. Do not treat an argument change alone as new owner authorization to repeat uncertain work.

**Negative regression:** Script accept-before-response-loss followed, without restart, by an otherwise equivalent send with altered whitespace or an optional field. Assert one accepted provider message, retention of the first unknown action, and refusal of the second effect. Repeat with an uncertain hosted submission.

---

### SEC-3 — High: Connected-app purchase operations bypass configured purchase allowances when amount metadata is absent

**Locations**
- `packages/apps/src/wrap.ts:42-47,59-66`: concrete MCP tools receive capabilities but no amount extractor or purchase allowance.
- `packages/apps/src/capabilities.ts:69-82`: payment-toolkit writes and money operations receive `purchase`.
- `packages/apps/src/business-providers.ts:232-242`: forwarding an amount extractor is conditional; it cannot supply one absent from wrapped tools.
- `packages/core/src/tools.ts:155-157`: missing amount produces no allowance.
- `packages/core/src/business-store.ts:260-261`: no allowance means no reservation.
- `packages/core/src/policy.ts:372-384`: business policy allows the operation on the premise that the dispatcher enforces allowances.

**Control/exploit path:** With a selected, connected payment toolkit and a configured purchase cap—even zero—a worker invokes a purchase-tagged concrete operation through `business_app`. Its input can contain an amount, but the wrapper has no normalized amount/currency extractor. Policy allows it, no reservation is made, and the provider tool is called.

**Impact:** The advertised purchase cap does not constrain this supported external-effects path. Parallel-reservation correctness for `payment_request` does not close it.

**Minimal fix:** Require a trusted normalized amount/currency allowance for spend-capable operations when enforcing a configured cap. If a concrete operation cannot establish its amount, fail closed with an accounting blocker rather than treating it as zero spend. Supply typed extraction for supported payment operations; do not invent personal-mode monetary defaults.

**Negative regression:** Expose a synthetic purchase-tagged concrete MCP operation through the real Composio catalog/dispatcher. Set the cap before claiming the task. With cap zero, absent amount metadata, and then an over-cap amount, assert no provider invocation and no false remaining balance. Include concurrent valid reservations.

---

### SEC-4 — Medium: Retained PDF/image tools bypass the workspace symlink boundary

**Locations**
- `packages/core/src/core-tools.ts:530-543`: `resolveWorkspacePath` canonicalizes the workspace root but only lexically bounds the requested descendant.
- `packages/core/src/core-tools.ts:561-573`: PDF image reads and destination writes use that path.
- `packages/core/src/core-tools.ts:597-629`: image generation uses the same destination resolver.
- `packages/core/src/pdf.ts:299-310`: the resolved image path reaches `doc.image`.
- `packages/server/src/boot.ts:223-232`: these tools remain registered in business mode.

**Prerequisite and path:** A symlink exists inside the workspace—for example, from owner-imported/pre-existing workspace content. A prompt-influenced worker selects `output.pdf` when that path is a symlink to controller state, or selects a symlinked directory. The lexical check passes and `writeFileSync` follows the link outside the workspace. A symlink to a private image similarly permits embedding that image into an exportable PDF.

I did **not** establish that a remote uploader can create such a symlink through the new upload endpoint; this is a conditional file-confinement failure, not an unauthenticated upload exploit.

**Impact:** Outside-workspace file corruption and private-image disclosure where a hostile/pre-existing symlink is present. The stronger Pi file-tool and artifact-store guards do not cover this separate resolver.

**Minimal fix:** Reuse a canonical descendant/ancestor confinement check for both input images and output paths, with no-follow file handling consistent with artifact storage.

**Negative regression:** Through registered `create_pdf` and `image_generate`, test file symlinks and symlinked directories targeting synthetic private state. Assert outside bytes remain unchanged and private image bytes never appear in the generated artifact. Existing tests cover lexical traversal and Pi `read`, not these sinks.

## Yield — Evidence gaps and required follow-up

These are **gate-evidence gaps**, not additional demonstrated vulnerabilities:

- **Server suite is not green:** `artifact://41:235-295` records heap exhaustion and a closed worker channel. Passing earlier package cases cannot establish the integrated security gate.
- **Original browser run failed before meaningful flows:** `artifact://42:118-145` shows the production Composio destination rejected by outbound isolation during boot. This evidences a working rejection, **not live network access**. Adapter precedence is now corrected in the inspected `boot.ts:349`, but that edit alone is not passing regression evidence.
- **Newer on-disk browser evidence also fails:** `packages/server/playwright-report/results.json` records a failed desktop/light task-admission assertion at `e2e/workspace.spec.ts:40`, with the application reporting that the owner conversation could not finish. The inspected manifest has failed status, only login/empty/onboarding checkpoints from that failed test, and missing matrix coverage. None establishes the changed-flow security negatives.
- **Trace inspection was limited but concrete:** inspected retained redacted trace network records show cookie/header and login-body redaction. I also inspected a retained screenshot. Neither proves complete trace-secret removal or takeover screenshot privacy. Require a successful credential-canary negative covering transcripts, SQLite/action records, exports, screenshots, and public evidence artifacts.
- **Authority negatives need integrated proof:** some current security cases call `ownerAuthority` directly. Supply exercised signed-ingress/runtime negatives for forged owner email, group scope, delegated principals, and worker attempts to alter settings/authority. Include malicious retrieved content followed by attempted policy promotion.
- **Required proof remains outstanding** for the four findings above and the integrated account/source fences, provider revocation/substitution, restore-without-replay, and cross-workspace computer/knowledge boundaries. Existing test source is not a passing result.
- **Live prerequisites are unavailable:** `docs/business-owner/evidence/live-prerequisites.json` explicitly records unexercised BO-296–304 and missing model, Composio/test Google accounts, consenting recipient, Inkbox owner-phone credentials, Maritime entitlement/test portal, and configured owner origin/token. No texting/Google/computer/full-product readiness is established.
- **Acceptance bookkeeping is stale/incomplete:** `acceptance.json` still marks BO-250/252 pending review with empty evidence and says review was not requested; its aggregate external-prerequisites list is empty despite the separate blocker artifact.

Parent should provide fix-specific negative results, completed integrated scenario/browser evidence, and publication/secret-scan evidence for independent follow-up. Mandatory live scenarios remain separately blocked until their real prerequisites exist.

## Yield — Reviewed paths and coverage

Reviewed relevant plan security/verification sections and acceptance records; core principal/runtime/policy/tool dispatch, credentials, store/recovery, memory/prompt and network guard; server coordinator, owner/task tools, usage/outbox, knowledge/profile/extraction/file services, HTTP/session/browser rendering and boot wiring; app catalog/account/proxy/Google operations; hosted-computer privacy and credential entry; payment and network tools; relevant Inkbox signature/file boundaries; scenario isolation, Composio/Maritime fixtures, provider/security/workflow tests, browser fixtures/reporting/redaction, CI/Gitleaks configuration, and available failure/trace/screenshot artifacts.

**Coverage conclusion:** Session/CSRF/Host handling, owner-only control checks, account pinning, private artifact storage, and credential-reference paths contain substantive controls. Those controls do not resolve the three external-effect/accounting failures or the separate symlink escape above. **Release remains blocked pending fixes and exercised negative evidence.**