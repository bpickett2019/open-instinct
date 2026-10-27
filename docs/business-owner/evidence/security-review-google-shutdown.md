## Yield — SDK shutdown correction and updated Google evidence

**Scoped pass. Release-blocking findings: `[]`.** Post-fix lifecycle execution and live restart proof remain Main’s pending gate.

### Shutdown fix

Reviewed `packages/apps/src/composio.ts:482–485`, `packages/server/test/apps-shutdown.test.ts:1–29`, the CLI shutdown path, and installed `@composio/core@0.22.0` implementation.

The root-cause explanation matches source:
- SDK telemetry setup registers signal handlers.
- Those handlers flush, remove themselves, then re-send the signal.
- The CLI uses a once-only signal listener and asynchronous cleanup, leaving that second signal capable of terminating cleanup prematurely.

`allowTracking: false` prevents telemetry setup through the SDK’s supported configuration. It does **not** remove controller signal handlers, suppress provider failures, change account authority, or globally monkeypatch process behavior. Repository search found no alternative production `new Composio(...)` initialization requiring the same correction.

The regression exercises the actual SDK in a subprocess with a synthetic key, synthetic fetch responses, real SIGTERM delivery, and delayed cleanup. It checks both clean termination and the cleanup marker. Its limitation is appropriate: it tests this signal interaction, not complete production durability or shutdown ordering.

The recorded failing-before artifact confirms termination by `SIGTERM`; I did not rerun it. No passing-after lifecycle result is inferred.

### Updated Google evidence

Reviewed:
- `google-calendar-connected.json`: records the repaired production controller returning HTTP 200 with verified Calendar identity and `connected` status; no appointment reads or mutations.
- `google-proxy-live-negative.json`: records a foreign-workspace binding attempt rejected with HTTP 400 / `ToolRouterV2_InvalidConnectedAccountIds`, without creating a session or executing provider operations.
- `google-proxy-integrated-checks.txt`: inspected output confirms the 12-package build/typecheck, 178 apps tests, 338 server tests, and smoke pass for the preceding proxy repair.

Main additionally reports 34 Chromium tests and publication scanning succeeded. The file excerpts available during this review did not expose their completion summaries, so those remain **Main-reported**, rather than independently inspected completion evidence. These preceding checks do not establish success of the newer shutdown correction.

The connected JSON records browser confirmation, but I did not open the private identity-bearing screenshot.

### Remaining boundaries

This updates the earlier “controller verification pending” limitation: the supplied evidence now records a real connected controller and a real cross-workspace denial. It still does not establish:
- successful post-fix production shutdown/restart;
- live account-revocation races or uncertain-effect recovery;
- isolated account suitability, consenting attendees, or authorized appointment mutations;
- broader hosted-computer, deployment, or full-product readiness.

Continue withholding appointment writes until test targets and attendee consent are established. No new authority/privacy regression was found in this scoped correction.

No edits, commands, network requests, secret reads, or verification runs performed.

## Final evidence disposition — independent reviewer

Scoped **PASS**, findings `[]`. This supersedes the earlier pending lifecycle
execution and incomplete browser-output evidence limitations above.

The reviewer inspected:
- `google-shutdown-integrated-checks.txt`: apps build/typecheck, 178 app tests,
  actual-SDK subprocess shutdown regression and smoke all passed.
- `google-clean-shutdown.txt`: corrected live service received SIGTERM, closed its
  tunnel and exited 0.
- `google-calendar-restarted.json`: restarted production controller returned
  HTTP 200 and connected Calendar with the unchanged identity hash; no appointment
  reads or mutations. The reviewer did not inspect the private screenshot.
- Restored complete `google-proxy-integrated-checks.txt`: 34 browser tests passed
  across desktop/mobile and light/dark; publication scan passed for 260 files,
  4 archive entries and 2,617,242 expanded bytes.

The initial saved proxy log had a captured-output truncation footer instead of its
last 45 lines. Main recovered the complete original artifact using an explicit
raw range, without rerunning successful checks. The reviewer inspected the restored
ending and closed this evidence-packaging gap.

No surviving release-blocking security finding in the reviewed proxy contract and
SDK shutdown corrections. These focused results do not establish crash durability
at every external-effect boundary or full-product readiness. Publication scanning
is emulated pattern/canary checking, not OCR or a complete vulnerability review.

Remaining prerequisites: isolated account/calendar suitability, consenting attendees
and authorized live workflows; separate Gmail, hosted-computer, live revocation-race
and deployment evidence. Connection consent does not authorize routines or historical
message scans. Reviewer performed no edits, commands, network requests or secret reads.