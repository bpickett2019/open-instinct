## Yield — Follow-up gate status

**Security gate remains NOT PASSED.** The original fixes materially improve the implementation, and exercised negatives support several of them. However, **SEC-1 remains open across alternate adapters**, and two additional concrete control failures survive this review.

This was read-only source/evidence review: no edits, suites, builds, payload execution, or network calls. Findings below distinguish inspected implementation from unexecuted exploit scenarios.

## Yield — Surviving findings

### SEC-1 — High, partially fixed: Final execution fences still stop at selected adapters

The Google/Composio/MCP fixes do not cover all registered external-effect paths.

| Remaining path | Exact locations | Unfenced transition |
|---|---|---|
| Stripe Link purchase request | `packages/payments/src/tools.ts:154-167` | Await payment-method discovery, then create a spend request and request approval without checking the dispatch signal or `ctx.assertBusinessDispatch`. |
| Inkbox messages/files | `packages/inkbox/src/channel.ts:220-240,266-284,288-304`; callers in `packages/inkbox/src/tools.ts:238-254,400-444` | Await identity/media upload, then submit customer communication without the task/source fence. Registered tools call the channel directly. |
| A2A delegation | `packages/network/src/tools.ts:353-361,413-419` | A multi-contact call continues to later recipients after awaiting earlier sends, without checking cancellation or updated authority. |
| Ample subprocesses | `packages/ample/src/tools.ts:56-58`; `packages/ample/src/cli.ts:33-61` | Await authentication, then spawn the controller-side CLI. The subprocess adapter registers an abort listener **after spawning**, but never rejects an already-aborted signal. |

**Plausible execution path:** A worker initiates one of these operations, then pauses in a prerequisite await. The owner stops/cancels the task or changes a consumed source. Releasing that prerequisite permits a new consequential request. For A2A, stop after the first recipient is accepted and before its response completes; subsequent recipients are still contacted.

The coordinator’s initial fence and abort do not fix this: these adapters either ignore the signal or lack a final source/task check. `BusinessOutbox` is also not a universal remedy: direct Inkbox tool calls bypass it, and its checks precede transport awaits.

**Impact:** New payment-consent requests, customer messages/file transfers, delegated requests, or deployments can start after authority is withdrawn. This is not merely an accepted-before-stop request finishing late.

**Minimal fix:** Complete propagation of the server-bound dispatch assertion and cancellation signal through these adapters. Check immediately before each consequential submission, after prerequisite awaits. Reject pre-aborted signals before `spawn`; do not rely solely on adding an abort listener. Keep owner control acknowledgments independently deliverable after stop.

**Exact negative scenarios for parent:**
1. Hold synthetic `paymentMethods.list()`, stop the bound task, release it; assert zero `spendRequests.create` and `requestApproval` calls.
2. Hold Inkbox identity discovery or media-upload completion, stop, release; assert no subsequent customer-send request. Preserve an upload receipt if upload already occurred.
3. Gate the first A2A response in a two-recipient request, stop, release; assert the second recipient receives nothing.
4. Hold Ample authentication, cancel, release; assert the injected CLI runner is never invoked. Separately exercise `spawnCli` with an already-aborted signal using a harmless local test fixture.

**Proof status:** Source-confirmed missing checks; these remaining scenarios were **not executed** during review.

**Ample isolation qualification:** Business boot still registers Ample when configured (`packages/server/src/boot.ts:298-320`), and its implementation unquestionably spawns a process on the controller. I did **not** establish that its external CLI executes attacker-supplied project code locally; calling this arbitrary-code execution would exceed the evidence. The demonstrated cancellation flaw above stands independently. CLI packaging/build isolation remains an explicit prerequisite for claiming that this path honors the hosted-only arbitrary-code boundary.

---

### SEC-5 — High: Completed Gmail effects can be repeated by changing nonsemantic arguments

**Locations**
- `packages/core/src/runtime.ts:1195`: step identity hashes raw model-supplied tool arguments.
- `packages/apps/src/business-providers.ts:140,154-167`: Google input accepts arbitrary record fields, and the message identity seed hashes the unnormalized request.
- `packages/apps/src/google-workspace.ts:23,53-76`: mail preparation normalizes addresses and drops unused fields, but generates Message-ID from that raw-request seed.
- `packages/server/src/business-coordinator.ts:117-125`: the new uncertainty fence excludes verified actions; duplicate rejection is by step ID.

**Execution path:** Within one task, send a message and obtain verified Sent readback. Propose the same send again with only:
- recipient case changed from `Customer@fixture.test` to `customer@fixture.test`; or
- an unused input field such as `retryTag: "again"`.

The delivered recipient/body/subject are unchanged, but the raw argument hash, action step, and generated Message-ID differ. The previous verified action therefore does not prevent another send.

**Impact:** A model retry/replan—or prompt-influenced retry—can duplicate completed customer communications without a new owner request or scheduled occurrence. The new unknown-effect fence correctly addresses uncertainty but does not address this distinct identity problem.

**Minimal fix:** Assign a persisted logical occurrence/effect identity using normalized operation semantics and server-bound authorization/occurrence scope. Generate provider idempotency identifiers from that identity, not arbitrary raw model fields. Reject or ignore unused fields *before* identity calculation.

**Negative regression:** In a single worker run, verify the first Gmail send, then issue the two equivalent variants above. Assert one accepted message and no second send request. Also prove a genuinely distinct owner request can intentionally repeat the same content.

**Proof status:** Source-confirmed identity mismatch; duplicate delivery is **[INFERENCE]**, pending the synthetic scenario.

---

### SEC-6 — High: Image-model requests bypass model allowances and unknown-price accounting

**Locations**
- `packages/core/src/core-tools.ts:599-611,630-635`: `image_generate` is tagged only `files.write` and directly invokes `/images/generations`.
- `packages/core/src/tools.ts:155-169`: that metadata creates neither a model allowance nor a spend-capable classification.
- `packages/server/src/business-usage.ts:7-42`: pricing, reservation, and unknown-usage accounting wrap the conversational stream, not the image request.
- `packages/server/src/boot.ts:248-260`: image generation is enabled with a dedicated image key **or the existing OpenAI key**.

**Execution path:** A task’s conversational turn fits within its configured model budget and proposes `image_generate`. The image request has no priced reservation and does not mark usage unknown, despite invoking a separate model endpoint. Repeating with new output paths avoids file-immutability/step-identity checks.

**Impact:** **[INFERENCE]** With a paid configured image provider, spending can exceed the model allowance while the displayed balance omits image costs and remains falsely known.

**Minimal fix:** Put image generation under model accounting: reserve a trustworthy upper bound before network access, settle reported/verified cost, and retain uncertainty after ambiguous outcomes. If pricing cannot enforce a configured cap, fail closed; without a cap, report unknown cost rather than implicit zero.

**Negative regression:** Use a known-priced conversational fixture with enough budget for its turn, plus a synthetic image endpoint with unavailable pricing. Propose image generation and assert no image request under a configured model cap. Cover known-price over-cap and concurrent reservations, then unknown-price accounting without a cap.

**Proof status:** Source-confirmed accounting omission; no live billing or synthetic reproduction was performed.

## Yield — Original findings and new boundaries

- **Original SEC-1, Google variant:** Source fix inspected. `dispatch-boundaries.test.ts` exercises stop during Calendar freebusy; `artifact://81` reports the six-case suite passing. This supports that specific fix, not all adapters.
- **Original SEC-2, same-run uncertainty:** The coordinator now checks prior `dispatching`/`accepted`/`unknown` consequential actions on every new effect. The same-run Gmail and shell negatives are in that passing suite. SEC-5 above is a separate completed-effect identity defect.
- **Original SEC-3, unpriced connected purchase:** `spendCapable` and fail-closed reservation checks are present. The passing scenario uses an actual discovered synthetic Stripe operation with a zero cap.
- **Original SEC-4, PDF/image symlinks:** Canonical descendant checks, symlink refusal, final destination recheck, no-follow open, and exclusive business creation are present. Core’s 313-test run, including the expanded core-tool suite, passed in `artifact://81`.
- **Hosted artifact transfer:** Inspected the real registered-wrapper path, lease/privacy checks, explicit encoding/size/hash handling, and byte-preserving readback. `artifact://81:171-195` records passing malformed/private-envelope, takeover, credential-entry, and transfer cases. Its stop-during-read case failed an expected-error-text assertion before reaching the artifact-list assertion; the revised source assertion alone is not fresh passing proof.
- **Owner/worker controls:** Foreground visibility and source-bound `business_task_reply` checks are present; automatic unrelated-request association was removed. The retrieved-content promotion negative passed. The broader signed/group principal test still partly calls `ownerAuthority` directly rather than exercising every ingress-to-runtime path.
- **Saved constraints:** Custom per-action/daily limits now enter transactional reservation checks, and the parallel daily-hold scenario passed. I found no additional concrete bypass in that inspected accounting path.
- **Notifications:** Durable notification identity is inserted before transport awaits, preventing simultaneous ordinary retries from both sending. I found no separate demonstrated duplicate-notification race. Alternate transport fencing remains covered by SEC-1.

## Yield — Evidence limitations and publication review

Observed verification—not agent claims:

- `artifact://77`: build and all twelve package typechecks passed.
- `artifact://81`: core 313 passed; server 253 passed, three test failures and one suite-load failure. This is not an aggregate pass.
- `artifact://79`: browser 26 passed / eight failed.
- A newer on-disk targeted browser result dated **2026-10-23T07:58:28Z** records eight expected tests and zero unexpected failures. Its accompanying manifest still reports **failed**, with **88 missing matrix checkpoints**. Do not combine stale screenshots and separate partial runs into an invented full pass.
- Inspected the newer mobile stop screenshot: it visibly shows global stop, separate queued work, and the prior unknown Calendar effect. That is corroboration, not substitute proof of dispatch suppression.
- Inspected a retained sanitized trace’s login, authenticated requests, and mutation headers: token fill text, cookies, CSRF headers, and request bodies were redacted in those records.

**Secret/canary proof remains incomplete.** The redactor unit test covers named fields and recognizable synthetic strings; retained image resources are copied verbatim. CI uploads artifacts before the final secret-pattern scan, and that scan is not an `always()` prepublication gate. I found no confirmed secret leak in the inspected trace sample, but neither that sample nor the unit test proves a canary cannot survive in DOM snapshots, error text, screenshots, or serialized values. Supply an end-to-end failing-browser canary case and inspection of the exact publication set before claiming artifact-secret clearance.

Live prerequisites remain explicitly unavailable; acceptance records now correctly identify them and the unpassed security gate.

### Coverage conclusion

Follow-up covered revised dispatcher/core-tool paths, Google/MCP adapters, owner controls, saved accounting, private file revisions and hosted imports, computer privacy, notification transport, Link payments, A2A, Ample process execution, CI publication/redaction, and the supplied/current verification artifacts.

**Release remains blocked by SEC-1, SEC-5, SEC-6 and incomplete final verification.** No additional confirmed cross-workspace, owner-session bypass, or private-artifact disclosure finding survived this follow-up.