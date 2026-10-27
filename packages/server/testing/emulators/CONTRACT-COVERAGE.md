# Local provider contract coverage

This fixture environment is test-only. It uses `emulate@0.12.3`, real HTTP/MCP clients, the production adapters and a separate stateful Calendar implementation. It is not Google, Composio, Inkbox or Maritime certification. No redacted live observations have been captured in this implementation; live confirmation remains required. The table records executable cases, not claims that the cases have passed.

| Boundary | Contract cases and consistency | Official specification | Deliberate gaps |
| --- | --- | --- | --- |
| Gmail MIME send/list/get | `providers.test.ts`: SENT label, RFC Message-ID search, UTF-8 raw readback, independent emulator inventory; accept then disconnect and delayed visibility maintain one accepted message | [send](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send), [get](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get), [list](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list) | Gmail readback proves sent, never carrier delivery or recipient read. Full Google search semantics are not claimed. |
| Gmail profile | Retained failing-before case checks locked upstream `/profile` returns 404. Narrow facade derives count/thread count and current history ID from the same upstream messages/history, not an independent inbox | [profile](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/getProfile) | No invented quota or mailbox totals. |
| Gmail history/threads/attachments/labels | Forwarded unchanged to locked emulator. History-expiry fault returns 404; intake must baseline/rescan. MIME/attachment fidelity belongs to production adapter contract tests | [sync](https://developers.google.com/workspace/gmail/api/guides/sync), [threads](https://developers.google.com/workspace/gmail/api/guides/threads), [attachments](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages.attachments/get) | History expiration is a controller fault control, not a claim that upstream models real retention. No push delivery or real OAuth consent evidence. |
| Google OAuth | Programmatic emulator authorization page, client-bound callback/state, token exchange and rejected authorization-code replay; all callback destinations use allocated loopback ports | [OAuth web server flow](https://developers.google.com/identity/protocols/oauth2/web-server), [locked emulator API](https://github.com/vercel-labs/emulate/tree/main/packages/emulate) | Production OAuth credentials/tokens are never imported. Composio fixture connection activation is explicit local state, not live OAuth. |
| Calendar | One canonical calendar/event map: metadata/list/get/insert/update/delete/freebusy, client IDs, duplicate 409, etag revision, stale If-Match 412, deleted-event busy removal; wrong readback and racing owner edit controls | [insert](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert), [version resources](https://developers.google.com/workspace/calendar/api/guides/version-resources), [freebusy](https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query) | Upstream Calendar lacks required get/update/If-Match semantics, so it is not used for app Calendar operations. No recurrence expansion, notification delivery, ACL or simultaneous-human-booking guarantee. |
| Composio session/proxy/accounts | Real HTTP narrow session adapter and real MCP StreamableHttpTransport; bound user/account session; production proxy serializer/decoder; inner completed/blocked/input_required; local disable/reconnect/account replacement; revoke job is requested, not verified | [proxy](https://docs.composio.dev/reference/v3/api-reference/tool-router/postToolRouterSessionBySessionIdProxyExecute), [account deletion](https://docs.composio.dev/reference/v3/api-reference/connected-accounts/deleteConnectedAccountsByNanoid) | Narrow session adapter does not prove upstream SDK session serialization. Generic app note is fixture protocol state, not a real selected third-party app. Unsupported routes/fields return errors, never success. |
| Maritime computer | Production MaritimeMcpBackend via `/mcp/u/<workspace>`; real HTTP MCP; per-workspace file map, invocation journal, human/agent mode and takeover completion; post-provision entitlement failure | [Maritime Computers](https://docs.maritime.sh), [MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#streamable-http) | No host shell execution. Shell response and screenshot descriptions are explicitly synthetic and prove only protocol/dispatch handling, never browser automation or OS isolation. |
| Inkbox | Production SDK/global fetch and InkboxChannel; independent attempt journal, idempotent accepted messages and separately controlled delivery receipts; signed ingress via production HMAC helper | [Inkbox documentation](https://docs.inkbox.ai), [SDK](https://www.npmjs.com/package/@inkbox/sdk) | Acceptance is not delivery. No local fixture attachment downloads: production loopback-media SSRF protections remain unchanged. Live media-domain download is a separate check. |
| Harness isolation | Exact allocated IPv4 loopback origins; injected and global fetch guarded; every redirect checked, including manual; swallowed violations fail teardown; explicit synthetic environment; fresh private state between cases; providers survive controller-only restart | [Fetch redirects](https://fetch.spec.whatwg.org/#http-redirect-fetch) | These guards are not an OS sandbox for malicious repository code. Only controlled faux-model output is allowed. Browser routing is also guarded by the Playwright fixture. |

## Running

After the integrated build, run `pnpm test:contracts` and `pnpm test:scenarios` for targeted reproduction. The ordinary aggregate `pnpm test` already includes both; do not duplicate these runs in the same CI pass. `pnpm test:e2e` exercises compiled workspace assets with Chromium. Missing compiled assets or failed provider discovery fail fixture startup. No fallback to live providers exists.

`createScenarioApp({ responses, foregroundResponses, now })` keeps foreground and worker model fixtures separate. `model.setResponses()` controls worker output only; `foregroundModel.setResponses()` controls immediate owner answers or management tools. By default the foreground emits `business_delegate` from the actual owner message, then acknowledges the actual tool result. It never creates tasks or declares provider success outside production services. `restart()` preserves provider state and private application state while expiring browser sessions.

The regression group IDs G1–G10 correspond to the acceptance contract. Provider contract results, real-browser screenshots and live-provider evidence must remain separately labeled. Fault injection is only exposed as in-process test-controller methods, never production routes or model tools.

## Integrated general-work and unanswered-follow-through cases

`test/scenarios/general-delegation.test.ts` admits an authenticated general client
brief through the production runtime, reads stored Gmail/Calendar/source facts,
creates a real PDF, imports an emulated office-produced XLSX, checks authenticated
download bytes and content, and reopens completed work after controller restart.
The Maritime fixture retains text and binary values in one workspace-bound file
map. `read_file` returns explicit `utf8` or `base64` encoding; binary transfers
carry byte count, hash and MIME metadata. The integrated import failed before this
fixture envelope was implemented. Production decoding was not weakened.

The XLSX is a real file produced by ExcelJS as synthetic provider input. Its
formulas and cached values are inspected, but this does not demonstrate remote
LibreOffice execution or formula recalculation. Set `INSTINCT_SCENARIO_EVIDENCE_DIR`
explicitly to capture the synthetic downloaded PDF/XLSX and proof JSON; ordinary
test runs retain no such deliverables.

`test/scenarios/follow-through-send.test.ts` uses an owner-enabled, account-scoped
routine and real registered tools. Controller restart and fourteen days of missed
checks produce one justified Gmail chase, not a burst. Repeated sweeps/restarts
cannot duplicate it, the 72-hour boundary holds, and two unanswered chases exhaust
the schedule even after ninety more days of downtime. Independent provider
inventory and thread/MIME readback establish the effect counts; no task success or
receipt is inserted by the fixture.
