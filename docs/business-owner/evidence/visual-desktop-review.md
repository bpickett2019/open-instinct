## Desktop inspection result

Inspected **all 58 desktop captures: 29 cases × light/dark**. These use the 1440×1000 viewport, but most PNGs are full-page captures taller than 1000px. Read the actual images; additionally inspected native-resolution sections of both themes’ long quote, Calendar lifecycle, and Activity captures.

### Findings

- **P2 — Clear the obsolete uncertainty message after reconciliation.** Both `desktop-light-gmail-reconciled.png` and `desktop-dark-gmail-reconciled.png` show `business_google` as **verified**, immediately followed by **“Adapter did not establish an outcome; reconciliation required.”** This contradicts the current action certainty and leaves the owner unable to tell whether intervention remains necessary. Source confirms that `packages/server/src/business-coordinator.ts:308–310` promotes the action while retaining `latest.error`, which `packages/server/web/workspace.ts:119` renders without qualification. Clear the current error on successful reconciliation, or explicitly identify it as historical. **Confidence: 1.0.**

### Capture limitation

The full-page captures for **validation-error, quote-gmail-verified, calendar-lifecycle, calendar-conflict, gmail-reconciling, and gmail-reconciled**, in both themes, contain the sticky header partway down the image, obscuring underlying content. Examples include the purchase-limit label in validation-error and receipt/evidence text in the quote and Calendar captures. This is an **acceptance-evidence obstruction**, not proof that the controls are unreachable in the interactive application. The obscured pixels cannot be inspected from these PNGs.

### Other observations

- No additional visible horizontal overflow, clipped primary controls, or obvious text-contrast failures.
- Empty, offline, expired-authentication, stopped, disconnected-provider, and unknown-action states communicate their limitations.
- Task acceptance is distinguished from completion; action verification is explicitly distinguished from delivery/business outcome.
- Knowledge captures show source/version references and explicit authority designation.
- **No raw private takeover/control URLs, passwords, bearer/OAuth tokens, payment values, or controller filesystem paths were visibly exposed.** Computer captures display “Open private takeover” rather than its URL, state the synthetic-provider limitation, and explain sensitive-session privacy.
- Privacy conclusions cover **visible screenshot content only**—not link destinations, collapsed disclosures, internally scrolled receipt content, or obscured pixels. These captures do not prove live-provider behavior.
- No builds, tests, linters, or formatters run. No repository code or reports modified.

## Exact inspected path list

All paths below are relative to `/tmp/open-instinct/packages/server/evidence/screenshots/`.

| Light | Dark |
|---|---|
| `desktop-light-login.png` | `desktop-dark-login.png` |
| `desktop-light-onboarding.png` | `desktop-dark-onboarding.png` |
| `desktop-light-overview.png` | `desktop-dark-overview.png` |
| `desktop-light-task-list.png` | `desktop-dark-task-list.png` |
| `desktop-light-task-detail.png` | `desktop-dark-task-detail.png` |
| `desktop-light-chat.png` | `desktop-dark-chat.png` |
| `desktop-light-knowledge-list.png` | `desktop-dark-knowledge-list.png` |
| `desktop-light-knowledge-detail.png` | `desktop-dark-knowledge-detail.png` |
| `desktop-light-files.png` | `desktop-dark-files.png` |
| `desktop-light-connections.png` | `desktop-dark-connections.png` |
| `desktop-light-computer.png` | `desktop-dark-computer.png` |
| `desktop-light-activity.png` | `desktop-dark-activity.png` |
| `desktop-light-settings.png` | `desktop-dark-settings.png` |
| `desktop-light-allowance-balances.png` | `desktop-dark-allowance-balances.png` |
| `desktop-light-empty.png` | `desktop-dark-empty.png` |
| `desktop-light-validation-error.png` | `desktop-dark-validation-error.png` |
| `desktop-light-offline.png` | `desktop-dark-offline.png` |
| `desktop-light-authentication-expired.png` | `desktop-dark-authentication-expired.png` |
| `desktop-light-provider-disconnected.png` | `desktop-dark-provider-disconnected.png` |
| `desktop-light-action-unknown.png` | `desktop-dark-action-unknown.png` |
| `desktop-light-globally-stopped.png` | `desktop-dark-globally-stopped.png` |
| `desktop-light-quote-gmail-verified.png` | `desktop-dark-quote-gmail-verified.png` |
| `desktop-light-quote-pdf-download.png` | `desktop-dark-quote-pdf-download.png` |
| `desktop-light-followup-suppressed.png` | `desktop-dark-followup-suppressed.png` |
| `desktop-light-calendar-lifecycle.png` | `desktop-dark-calendar-lifecycle.png` |
| `desktop-light-calendar-conflict.png` | `desktop-dark-calendar-conflict.png` |
| `desktop-light-provider-stop-persisted.png` | `desktop-dark-provider-stop-persisted.png` |
| `desktop-light-gmail-reconciling.png` | `desktop-dark-gmail-reconciling.png` |
| `desktop-light-gmail-reconciled.png` | `desktop-dark-gmail-reconciled.png` |

**Overall correctness: incorrect** for the inspected action-certainty presentation because successful reconciliation retains an unqualified current uncertainty message. **Confidence: 0.99.**