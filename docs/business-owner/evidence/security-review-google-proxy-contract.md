## Yield — Composio v3 proxy contract repair

**Scoped pass. Release-blocking findings: `[]`.**

### Authority boundary preserved

Reviewed:
- `packages/apps/src/composio.ts:230–258`
- `packages/apps/test/composio.test.ts:62–107`
- `packages/server/testing/emulators/composio.ts:52–95`
- Adjacent Google request validation and connection-epoch controls.

The `composio.ts:239` correction changes the raw REST toolkit selector to `{ enable: [toolkit] }`. It does not relax account selection or authorization:
- Workspace ID and the explicit toolkit-to-account-ID binding remain controller supplied.
- Connection management and workbench remain disabled.
- Returned session workspace/account bindings are checked before use.
- Each operation still checks active account metadata.
- Cancellation and the local authority fence are rechecked after asynchronous session creation, immediately before proxy submission.
- Fixed Google endpoint/method/query validation remains in place; no generic authenticated HTTP tool is introduced.

The emulator now rejects the obsolete array selector and validates the enabled toolkit set against bound account keys, account workspace, toolkit, and active status. Proxy execution continues checking revocation. This is stricter contract modeling, not an adapter bypass.

### Negative-case coverage

Source inspection confirms coverage for:
- The obsolete selector producing HTTP 400.
- Explicit account binding and preservation of inner Google errors.
- `blocked` and `input_required` responses not becoming success.
- Foreign-workspace accounts and arbitrary external endpoints being rejected.
- Adjacent reconnect tests retaining failed/pending-revocation, stale OAuth completion, account substitution, changed identity, and interrupted identity-verification cases.

**Coverage limitations, not identified vulnerabilities:** the modified unit test does not directly exercise a returned-session binding mismatch or disconnect/stop while session creation is held. The production checks are present, but this focused test does not prove those branches. The emulator also does not validate the nested disable flags themselves.

### Evidence and release limits

Read `google-proxy-regression-before.txt`: it records the focused regression failing with HTTP 400 before the repair. I did not rerun it.

`google-proxy-live-contract.json` records the actual v3 corrected request returning HTTP 201 with matching workspace/account bindings and disabled connection management/workbench, followed by a completed, inner-200 **primary-calendar metadata** read. This supports the specific wire-contract correction; it does not prove appointment reads/writes or the restarted controller’s end-to-end readiness.

At review time, the evidence explicitly leaves production-controller post-fix verification pending. Integrated checks and restart results remain Main’s gate; no passing result is inferred here.

Continue withholding appointment mutations until isolated test targets and consenting attendees are established. Google authorization does not establish account test-only suitability or authorize routine/history scanning.

No edits, commands, network requests, secret reads, or verification runs performed.