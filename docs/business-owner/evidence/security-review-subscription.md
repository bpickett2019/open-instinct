## Yield — ChatGPT subscription authentication security gate

**PASS for the reviewed authentication integration and deterministic evidence. No release-blocking security finding identified.** There is no security objection within this reviewed scope to initiating the explicitly requested user-controlled OAuth login.

```json
{"findings":[]}
```

This is not confirmation of live subscription eligibility, model entitlement, successful OAuth, or live business readiness.

## Yield — Reviewed implementation

| Boundary | Locations | Assessment |
|---|---|---|
| Private credential storage | `packages/core/src/chatgpt-subscription.ts:27–82`, `open`/`protect`/`readCredential` | Explicit data-directory-local storage; 0700 directory and 0600 files; rejects symlinked directories, symlink/hardlinked files, and canonical workspace overlap. Credentials are validated before constructing Pi’s runtime. |
| Command-valued credential prevention | Same file, `readCredential`; installed Pi `auth-storage.js`, `AuthStorage.read` | Pi can resolve command-valued **API-key** credentials. The integration rejects that credential type and unexpected providers before Pi receives the file. OAuth access/refresh values are passed as tokens, not configuration commands. |
| Refresh, logout, and fallback | `chatgpt-subscription.ts:89–118`; installed Pi `model-runtime.js`, `runtime-credentials.js`, `auth-storage.js`, `auth/resolve.js` | Uses public runtime authentication, with double-checked refresh under the file-store lock. Stored OAuth owns the provider; failed refresh does not fall back to environment API keys. The native Codex provider has OAuth authentication without an API-key handler. |
| Isolation from existing credentials | `ChatGPTSubscription.open`; installed `ModelRuntime.create` | Explicit `authPath`, `modelsPath: null`, disabled model-network refresh, and disabled refresh-on-create avoid loading global model configuration or importing the global Codex login. No second assistant/session is created. |
| Browser/device/manual login | `packages/cli/src/commands/auth.ts:9–132`; installed Codex OAuth and callback-server implementation | Uses provider browser/device flows. Browser authorization uses PKCE and random state; callback validates state. Manual input is hidden and restores terminal state. Cancellation propagates to the provider and removes listeners. Device code display is intentional; access/refresh tokens are not printed. |
| CLI routing and error handling | `commands/auth.ts:134–180`, `cli.ts`, `args.ts`, `io.ts` | Invalid auth arguments are rejected before storage access without quoting pasted values. Provider errors are replaced with generic messages, including debug mode. Login does not change model/configuration. |
| Server authentication and redaction | `packages/server/src/boot.ts:137–143,540,633` | Codex requests use only the private subscription resolver. API-key mappings remain separate. Loaded and rotated access/refresh tokens are registered with the credential vault for exact-value redaction. |
| Subscription accounting | `packages/server/src/business-usage.ts:11–19,26–39` | Codex catalog rates are not treated as billed subscription cost. Configured USD model caps fail closed before the model stream; uncapped requests record unknown monetary cost. |
| Documentation | `docs/KEYS.md:51–98`; server README subscription section | Correctly distinguishes subscription access, installed catalog, live entitlement, local logout, provider-side revocation, full-directory backup sensitivity, and separate service credentials. |

### Prevalidation and race assessment

Validation is **not performed inside Pi’s credential-store lock**. It should not be described as an atomic defense against a malicious same-UID process replacing the private directory or file between validation and use.

Within the reviewed business trust boundary, I found no attacker-controlled workspace/provider path that can perform that replacement: workspace overlap is rejected, file tools remain scoped, and controller shell is disabled in business mode. A compromised controller user already has access to the credential file. Consequently, I did **not** promote this theoretical same-UID race into a security finding.

Normal concurrent refresh is separately protected by Pi’s lock and recheck. The regression uses two independently opened instances in one process; it does not itself demonstrate separate-OS-process contention. Concurrent in-place writes can also cause an unlocked validation read to fail closed; this is not evidence of command execution or credential disclosure.

Personal mode’s existing unrestricted controller shell remains outside any claimed credential sandbox.

## Yield — Actual verification inspected

- **`artifact://265`:** twelve package builds/typechecks passed; 17 new core auth tests passed; CLI 125 passed at that revision. Its server accounting cases **failed before the fix** and are not counted as passing evidence.
- **`artifact://269`:** core **332 passed**, including all 17 auth tests; server **307 passed**, including all five subscription authentication/accounting tests. Affected server/CLI builds and typechecks passed.
- **`docs/business-owner/evidence/subscription-cli-smoke.txt`:** final CLI **125 passed**, including 20 auth cases; actual runtime smoke **passed**.
- The two intermediate CLI failures concerned an obsolete hardcoded model-selection string. I inspected the corrected assertions: method selection, unchanged configuration, credential non-disclosure, and displayed authorization URL/device code remain checked.

The core tests exercise private permissions, reopen, refresh rotation, concurrent instances, logout visibility, refresh failure without fallback, overlap/link rejection, malformed credentials, command-valued API-key rejection, and business-export exclusion.

The server tests exercise missing-private-auth rejection before model transport, retained personal OpenAI authentication, unknown subscription cost, and configured-cap rejection.

## Yield — Remaining qualifications

- No live OAuth or model request was exercised by this reviewer. Live eligibility, actual refresh behavior, selected-model capability, and provider limits remain unverified.
- Packaged `auth status`/`auth models` success is recorded in the verification summary and reported by the parent; I did not inspect separate raw output for those invocations.
- The existing browser matrix predates subscription changes; no fresh browser claim is made.
- Local logout is not provider-session revocation or cancellation of already-started requests. Follow the documented restart/provider-revocation guidance.
- Human repository approval and the nine live business scenarios remain separate.

**Coverage conclusion:** Reviewed the new auth module, CLI flow/routing/input handling, server resolver and redaction wiring, accounting fix, regression assertions, actual outputs, and relevant installed Pi credential/OAuth internals. No confirmed credential disclosure, API-key fallback, command-execution bypass, or business-boundary regression survived review.

No live credentials were read or imported. No code, tests, builds, payloads, or network requests were executed by this reviewer.