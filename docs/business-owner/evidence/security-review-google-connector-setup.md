## Yield — Google connector setup security review

**Scoped pass. Release-blocking findings: `[]`.**

This covers the private launcher change and supplied setup evidence—not completed Google account authorization or full-product readiness.

### Launcher and credential handling

Reviewed `$PRIVATE_STATE/start-local.mjs` without opening either credential file.

The new Composio loader:
- opens the credential with `O_NOFOLLOW`;
- validates the opened descriptor as a regular file with one hard link and no group/other permissions;
- reads through that descriptor;
- replaces parsing/validation failures with a generic error;
- closes the descriptor in `finally`;
- supplies the key through the existing environment-based boot path, not command arguments.

Existing boot registers `COMPOSIO_API_KEY` with exact-value credential redaction. That runtime protection is not dependent on the failed 24-character snapshot heuristic.

The launcher remains bound to loopback with explicitly enabled development HTTP. It does not establish a production HTTPS deployment.

### Evidence disposition

Inspected:
- `docs/business-owner/evidence/google-connection-setup.json`
- `google-connector-auth-configs.png`
- `google-connector-workspace-ready.png`
- Relevant existing boot, OAuth initiation, account-listing, and onboarding-readiness code.

The screenshots corroborate managed Gmail/Calendar configurations with no connected accounts at capture time, and the workspace reporting **“Ready to connect”**, not falsely reporting connected identity. No API key or owner token is visible in these screenshots.

The evidence record appropriately distinguishes reported live configuration/API readback and authorization initiation from still-unverified consent, account identity, proxy execution, and calendar operations. The screenshots alone do not establish the recorded permission list, exact scopes, or revocation; those remain operator-observation evidence in the JSON.

### Credential incident

The initial key’s appearance in a tool response was a genuine disclosure. The reported immediate revocation and replacement are the appropriate containment actions; its never-installed/no-connected-account status limits the reported exposure.

The evidence correctly **does not claim** an old-key HTTP rejection test. Treat the initial key as compromised and retired, and retain the incident record. The failed length-based snapshot filter must not be relied upon for future credential handling; direct private extraction without value output is the safer boundary used for the replacement.

### Remaining gates

Before claiming Google connected, obtain owner consent and independently verify the intended account identity through the existing connection service. Authorization-link generation and reaching Google’s chooser are not connection proof.

Still unverified:
- Google consent, intended identity, and actual proxy/API access;
- live account substitution/revocation behavior;
- authorized Calendar operations and Gmail consent;
- Maritime workflows, production HTTPS, deployment-image/container proof, and broader live-product scenarios.

Calendar’s recorded `calendar` scope and Gmail’s `gmail.modify` remain substantial account permissions despite the narrowing. They require informed consent to an isolated test account and do not themselves authorize routines or historical scans.

No secret-file values or owner token were read. No network requests, browser control, edits, commands, or verification reruns were performed.