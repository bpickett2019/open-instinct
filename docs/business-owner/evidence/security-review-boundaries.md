This file preserves the independent read-only agent's initial report and subsequent addenda. The integration owner persisted it because the reviewer had no write tool. The final scoped gate disposition below supersedes earlier pending-evidence qualifications; live, image and human-review limits remain explicit.

# Independent boundary security follow-up

## Yield — Disposition

```json
{"findings":[]}
```

**No concrete release-blocking security finding survived review of the specified boundaries.** This conclusion uses inspected production source, regression assertions, and actual integrated output—not implementation-agent pass claims.

This is a scoped independent-agent review, not whole-product release approval. The parent’s pending model-count change and arbitrary-cwd smoke are not covered by supplied final evidence. The current-change browser rerun was not observed. Repository-required human approval and mandatory live-provider acceptance remain separate.

No implementation edits, tests, builds, linters, formatters, payload execution, or network calls were performed.

## Yield — Reviewed boundaries

Paths below are relative to `open-instinct/`.

| Boundary | Reviewed locations | Assessment |
|---|---|---|
| Private controller state | `packages/server/src/boot.ts:115–133`, `privateBusinessDirectory`; `packages/core/src/business-store.ts:118–145`, constructor | Canonicalizes private state and worker workspace, rejects overlap in either direction using path-component boundaries, and retains database/directory leaf-symlink refusal. Database creation follows the overlap check. |
| Immutable preparation and rebinding | `packages/core/src/business-store.ts:263–275`, `updateAction`; `packages/server/src/business-coordinator.ts:108–176`, `dispatch` | Prepared actions retain operation arguments, source/account bindings, effect classification, and allowance. Run/revision rebinding is restricted to never-attempted preparation. Attempted actions cannot acquire a new execution binding. |
| Reservations and final dispatch | `packages/core/src/business-store.ts:335–399`, saved purchase rules, `reserve`, `assertReservation`, budget checks and settlement; coordinator `dispatch`/`assertDispatch` | Preparation and attempt marking occur in separate synchronous transactions. The final transaction checks task authority, connection, consumed sources, and held reservation before invocation. Unknown outcomes retain allowance. Settings changes affecting limits advance the control epoch. |
| Recovery and replay | `packages/server/src/business-coordinator.ts:303–361`, `recover`/`runSweep` | Unattempted effect preparation remains resumable; attempted effects become unknown. Unknown/accepted consequential actions block further consequential dispatch. Reconciliation uses provider evidence rather than assuming a failed response means no effect. |
| Consumed events | `packages/server/src/business-coordinator.ts:229–258,303–307`, `wait`, `consumeEvent`, `appendEvent`, recovery | Per-task/correlation consumption prevents an old answer satisfying successive waits while preserving event-before-wait behavior. Recovery reconstructs consumption from satisfied waits. |
| Profile context | `packages/server/src/business-service.ts`, `context`; `packages/server/src/business-profile.ts:20–31,122–132`, `current`/`compactContext` | Foreground and worker context use filtered profile facts. Deleted, superseded, version-mismatched, or missing-locator sources are excluded from active profile projection while history remains retained. This is not transcript erasure. |
| Notification identity and uncertainty | `packages/server/src/business-outbox.ts:7–38`; `business-service.ts`, `notify`; `packages/core/src/notifier.ts:52–75`; `runtime.ts`, `deliver`/`safeSend` | Logical message identity is required for fallback transport and incorporates principal and route. Changed content under an existing identity is rejected. Notification attempt records precede transport awaits; interrupted attempts recover as unknown without automatic resend. |
| Invocation-local provenance | `packages/core/src/tools.ts:146–194`, `bindOne`; `runtime.ts:1165–1215`, `bindTools` | Each invocation snapshots context before preparation. Task identity, dispatched connection, final assertion, and receipt callback are local to that invocation rather than shared mutable tool context. |
| Proactive Gmail recovery | `packages/server/src/business-proactive-google.ts:7–79`, `openGmailThreads`/`sweepGoogleRoutines`; `packages/apps/src/gmail-intake.ts:18–78`; `business-providers.ts`, account pinning and bound transport; server `business-commitments.ts`, admission and premise checks | Recovery scope comes from current nonterminal tasks, waiting correlations, and active commitments—not accumulated cursor history. Account/connection epoch/identity bindings exclude stale work. Pre-activation thread evidence can wake existing work but does not authorize historical messages as new routine requests. |

### SEC1–7 regression interactions

- **SEC1:** Traced invocation-local final assertions into Google, Inkbox telephone/message transport, payments, A2A tools, and Ample authentication/subprocess boundaries. No regression identified in the inspected paths. Accepted-before-stop receipts remain recordable.
- **SEC2:** The same-run uncertain-effect fence remains present, including when a model changes arguments or step identity.
- **SEC3:** Concrete connected-operation metadata still feeds spend classification and fail-closed reservation checks.
- **SEC4:** PDF/image destination rechecks, no-follow creation, and business exclusive writes remain present. The new private-directory exclusion strengthens the adjacent controller-state boundary.
- **SEC5:** Gmail identity remains based on canonical serialized MIME and server-bound task/account occurrence. Prepared arguments do not reintroduce ignored raw fields.
- **SEC6:** Image generation retains `unpricedModel` classification and capped rejection/uncapped unknown-cost accounting.
- **SEC7:** Public trace generation still omits image/resources and screencast events; the publication scanner rejects their reintroduction. This review did not independently repeat visual inspection of the historical canary artifacts.

No surviving finding requires a severity, exploit reproduction, impact, or corrective patch entry.

## Yield — Observed verification

**Independently read actual output:**

- `artifact://220`: server **302 passed**, CLI **105 passed**.
  - Acceptance boundaries: **9 passed**
  - Operational limits/ingress authority: **13 passed**
  - Crash phases: **8 passed**
  - Open-thread recovery: **5 passed**
  - Existing dispatch boundaries: **11 passed**
  - Image accounting: **2 passed**
- `artifact://217`: twelve package build/typecheck output and successful non-server suite output inspected. Its earlier server run is **not** represented as an aggregate pass.
- `docs/business-owner/evidence/security-final-integrated.txt`: historical security integration output, including browser **34 passed** and successful exact-publication scan. This is prior evidence, not proof of the pending current-change browser rerun.
- `acceptance-boundaries-failing-before.txt`: inspected historical failures; the symlink case was an incidental expected-error matcher failure, not evidence that its previous symlink guard allowed database creation.

**Assertions and harness inspected:**

The crash suite and `testing/crash-phase-worker.mjs` use a separate controller process, assert actual `SIGKILL`, reopen SQLite, and keep provider state alive. They check submission counts, prepared identity retention, no uncertain resend, and independently verified Gmail recovery. The browser-effect fixture is synthetic and does not establish real hosted-browser or live-provider behavior.

## Yield — Remaining qualifications

1. No final model-count diff/evidence was received; it is outside this disposition.
2. No fresh browser rerun or arbitrary-cwd smoke result was inspected.
3. Invocation-local snapshotting and all preparation-rebinding rejection combinations were source-reviewed; the supplied suites do not individually demonstrate every concurrency/mutation combination.
4. `live-prerequisites.json` explicitly records BO-296–304 as externally blocked and unexercised. Nothing here marks them passed.
5. The prior Ample qualification remains: controller CLI execution is established, but arbitrary project-code execution there—and hosted-only isolation for that path—was not established.
6. Human repository approval remains required independently.

**Coverage conclusion:** Reviewed all named changed production boundaries and relevant SEC1–7 interactions. No confirmed authorization bypass, secret exposure, unintended external effect, or cross-workspace access was identified within that scope. Final integration evidence and live/human gates must retain their separate statuses.

## Yield — Final model-count delta addendum

```json
{"findings":[]}
```

**No additional security finding identified.** The earlier scoped boundary-review disposition remains unchanged.

Reviewed:
- `packages/core/src/runtime.ts:430–439`, model `streamFn`
- `packages/server/src/boot.ts:566–573`, personal-mode registry warning
- `packages/core/test/runtime.test.ts:172–198`, 128/129-tool boundary cases
- `artifact://231`, actual failing-before output

**Source-confirmed behavior:** Business requests using `openai-completions` reject more than 128 currently bound tools before selecting/invoking the accounting wrapper or provider stream. The check counts conversation-bound tools, not the entire registry. It does not truncate capabilities, substitute a router, or widen authority. The boot warning is now personal-mode only.

The business error correctly describes 128 as an **OpenAI-compatible safety bound**, not a universally established current provider maximum. I made no network calls to independently verify provider documentation.

**Evidence distinction:** The new test exercises the real owner runtime and records model-transport entry. Its assertions permit exactly 128 declarations and require rejection with zero provider calls at 129. `artifact://231` confirms the prior implementation incorrectly accepted 129; it is failing-before evidence, **not passing-after evidence**. The final build/test/browser outputs remain unobserved in this addendum. Accounting non-entry is established by source ordering; this test does not separately instrument the accounting wrapper.

No checks were run or files edited. Human approval and live-provider gates remain separate.

## Yield — Final scoped security gate disposition

**PASS — independent-agent security gate for the reviewed production boundaries, including the final model-count guard.**

```json
{"findings":[]}
```

No concrete release-blocking security finding survives this follow-up. This disposition rests on the production-source review, inspected regression assertions, and actual final integrated output. It does **not** establish whole-plan completion, live-provider readiness, container execution, or repository-required human approval.

## Yield — Final evidence inspected

Read `artifact://235` and persisted `docs/business-owner/evidence/acceptance-final-integrated.txt`:

- Affected **core/server builds and typechecks passed**.
- Core: **315 passed**, including the 84-test runtime suite containing the inspected **128-tool positive / 129-tool negative** cases.
- Server: **302 passed**, including:
  - Acceptance boundaries: **9**
  - Operational limits and ingress authority: **13**
  - Actual SIGKILL crash phases: **8**
  - Account-bound open-thread recovery: **5**
  - Existing dispatch boundaries: **11**
  - Image accounting: **2**
- Actual personal-mode smoke: **passed**.
- Current real-Chromium suite: **34 passed**, including session/origin/CSRF/Host/tunnel negatives, stop persistence, unknown-effect handling, and Gmail reconciliation without resend.

Independently read current `packages/server/evidence/manifest.json`:

```json
{
  "overallStatus": "passed",
  "verificationMode": "emulated",
  "checkpointCount": 116,
  "missing": [],
  "captureErrors": 0,
  "failures": []
}
```

Read `docs/business-owner/evidence/packaged-cwd-smoke.json`: it records successful compiled CLI/main startup outside the checkout, unauthenticated owner-API rejection, exact compiled asset serving, and Stop persistence across shutdown/restart. It explicitly records **zero model/provider requests** and **no container-image execution**.

These results close the previously pending final model-guard, current browser-rerun, and unrelated-cwd evidence qualifications.

## Yield — Evidence qualifications retained

- The newly reported publication scan—236 files, four archive entries, 2,313,950 expanded bytes—was **not present in the inspected final integrated log or evidence files located by search**. I therefore do not independently attest that fresh scan result. The prior raw publication-scan pass and inspected SEC7 resource/screencast exclusion controls remain supporting evidence; no new SEC7 regression was identified.
- Refreshed screenshot visual inspection was reported by the parent, not independently repeated by this reviewer. The browser assertions and manifest above were independently inspected.
- Container execution remains **unexercised**, with its precise environment blocker recorded in the packaged smoke artifact.
- All nine mandatory live-provider scenarios remain **blocked/unexercised**, not passed.
- The prior Ample isolation qualification remains: controller-side CLI execution is established; arbitrary project-code execution there and hosted-only isolation for that path were not established.
- Repository-required human approval remains separate.

## Yield — Coverage conclusion

The completed source review covers private-state/workspace separation; immutable preparation and safe rebinding; reservations and final task/source/account fences; crash recovery and uncertain-effect non-replay; consumed event cursors; filtered profile context; stable notification identities and unknown acceptance; invocation-local provenance; proactive account-bound Gmail recovery; the final conservative model-tool bound; and relevant SEC1–7 regression interactions.

**No confirmed authorization bypass, secret exposure, unintended external effect, or cross-workspace access was identified within that scope.**

No code was edited and no checks, payloads, or network requests were executed by this reviewer.