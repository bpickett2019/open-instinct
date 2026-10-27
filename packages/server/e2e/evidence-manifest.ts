export const evidenceCases = [
  { id: "login", route: "/workspace", state: "signed-out", assertions: ["Invalid token rejected", "Valid token exchanged for HttpOnly session", "Bearer not stored"], sources: ["workspace-session.ts", "workspace-page.ts", "workspace-http.ts"] },
  { id: "onboarding-welcome", route: "/workspace", state: "assistant-welcome", assertions: ["Blank workspace route opens the shared assistant conversation", "Server-generated opening uses an empty authenticated request, never invented owner words", "Actual model welcome replaces inline pending state", "App cards and raw profile controls remain secondary"], sources: ["business-service.ts", "runtime.ts", "workspace.ts"] },
  { id: "onboarding", route: "#onboarding", state: "conversation-and-saved-facts", assertions: ["Free-form business description is admitted through the actual message endpoint", "Scripted owner model saves multiple cited facts and replies in the same history", "Saved facts refresh without replacing the composer draft or focus", "Reload and reopening retain facts without another opening model turn", "HTTPS model links are safely clickable while markup remains inert", "Normal answers never PATCH the profile from the browser"], sources: ["business-service.ts", "runtime.ts", "business-knowledge.ts", "workspace.ts"] },
  { id: "onboarding-waiting", route: "#onboarding", state: "oauth-pending", assertions: ["Named Gmail action returns the actual fixture authorization URL", "Pending authorization is not connected", "Advanced raw fact fields are collapsed", "Free-form conversation remains available during authorization"], sources: ["business-onboarding.ts", "workspace.ts", "business-providers.ts"] },
  { id: "onboarding-connected", route: "#onboarding", state: "oauth-verified-draft-retained", assertions: ["Automatic visible-page refresh independently verifies the same provider account", "Unsent conversation draft and keyboard focus survive status refresh", "Connecting does not enable routines or create tasks"], sources: ["business-onboarding.ts", "workspace.ts", "business-providers.ts"] },
  { id: "overview", route: "#overview", state: "populated", assertions: ["Persisted task result displayed", "Autonomy and stop visible", "Accounted, held and remaining allowance values match the durable ledger"], sources: ["business-service.ts", "business-coordinator.ts", "business-store.ts"] },
  { id: "task-list", route: "#tasks", state: "populated", assertions: ["Submitted objective listed from durable task store"], sources: ["business-coordinator.ts", "business-store.ts"] },
  { id: "task-detail", route: "#tasks/:id", state: "verified-action", assertions: ["Actual file write readback evidence shown", "Task result agrees with provider/file state"], sources: ["business-files.ts", "business-coordinator.ts", "tools.ts"] },
  { id: "chat", route: "#chat", state: "cross-channel-history", assertions: ["Message persisted before acknowledgement", "Refresh and second tab preserve history", "Repeated client id does not duplicate admission"], sources: ["business-service.ts", "http.ts", "runtime.ts"] },
  { id: "knowledge-list", route: "#knowledge", state: "indexed", assertions: ["Uploaded document searchable by extracted text and source"], sources: ["business-knowledge.ts", "business-artifacts.ts"] },
  { id: "knowledge-detail", route: "#knowledge/:id", state: "source-version", assertions: ["Original hash and source locator visible", "Replacement retains superseded original"], sources: ["business-knowledge.ts", "business-artifacts.ts"] },
  { id: "files", route: "#files", state: "downloadable", assertions: ["Actual generated file downloads with verified content", "Downloaded source bytes match upload"], sources: ["business-files.ts", "business-artifacts.ts"] },
  { id: "connections", route: "#connections", state: "account-bound", assertions: ["Live fixture account identity visible", "Refresh checks current state"], sources: ["business-google.ts", "composio.ts", "google-workspace.ts"] },
  { id: "computer", route: "#computer", state: "takeover", assertions: ["Task requests takeover through real registered tool", "Provider human mode and owner-only takeover link displayed", "Completion check invokes provider status, not an owner done claim"], sources: ["business-computer.ts", "maritime.ts"] },
  { id: "activity", route: "#activity", state: "recorded-effects", assertions: ["Task/action evidence references match durable ledger", "Carrier acceptance not marked delivered"], sources: ["business-store.ts", "business-service.ts"] },
  { id: "settings", route: "#settings", state: "saved-rules", assertions: ["Timezone and rules persist after reload", "Unconfigured caps remain optional", "Accounted and held usage shown; unknown pricing is not free"], sources: ["workspace-http.ts", "business-store.ts", "business-recovery.ts"] },
  { id: "allowance-balances", route: "#settings", state: "configured-allowances", assertions: ["Owner-configured caps persist after reload", "Remaining balances match accounted usage and reservations", "Model balances use USD cents"], sources: ["workspace-http.ts", "business-store.ts"] },
  { id: "empty", route: "#tasks", state: "empty", assertions: ["Fresh store contains no tasks", "Delegation control reachable"], sources: ["workspace.ts"] },
  { id: "validation-error", route: "#settings", state: "invalid-timezone", assertions: ["Invalid settings rejected", "Persisted settings unchanged"], sources: ["workspace-http.ts"] },
  { id: "offline", route: "#chat", state: "offline-stale", assertions: ["Network unavailable shown without deleting history", "Reconnect restores polling"], sources: ["workspace.ts"] },
  { id: "authentication-expired", route: "/workspace", state: "expired-session", assertions: ["Revoked session cannot read owner API", "Browser asks to authenticate again"], sources: ["workspace-session.ts"] },
  { id: "provider-disconnected", route: "#connections", state: "locally-disabled", assertions: ["Disconnect disables connection before provider revocation", "Subsequent bound dispatch rejected"], sources: ["business-google.ts", "business-coordinator.ts"] },
  { id: "action-unknown", route: "#tasks/:id", state: "accepted-response-lost", assertions: ["Fixture records one hosted protocol operation before dropping its response", "App retains unknown outcome", "No blind second dispatch"], sources: ["business-coordinator.ts", "google-workspace.ts", "maritime.ts"] },
  { id: "globally-stopped", route: "#overview", state: "stopped", assertions: ["Direct stop increments durable fence", "No later dispatch", "Restart remains stopped"], sources: ["business-coordinator.ts", "workspace-http.ts"] },
  { id: "quote-gmail-verified", route: "#tasks/:id", state: "source-backed-pdf-sent", assertions: ["Owner uploads authoritative rates and delegates from browser chat", "Stored Gmail MIME has the expected recipient, quote content and PDF attachment", "Verified send and source revision persist on browser refresh"], sources: ["business-knowledge.ts", "business-providers.ts", "google-workspace.ts", "business-coordinator.ts", "document-lifecycle.ts"] },
  { id: "quote-pdf-download", route: "#knowledge/:id", state: "generated-pdf-extracted", assertions: ["Browser downloads actual PDF bytes equal to the independently stored Gmail attachment", "Downloaded PDF extraction contains assessment scope, USD 250.00 and cited source ID", "Extracted artifact content is visible in the workspace"], sources: ["business-artifacts.ts", "business-extraction.ts", "business-files.ts", "document-lifecycle.ts"] },
  { id: "followup-suppressed", route: "#settings", state: "reply-before-due-after-restart", assertions: ["Follow-through is enabled through owner routine controls", "Actual provider reply precedes the due time", "Restart after downtime suppresses the persisted commitment without another accepted send", "Browser shows suppression after refresh; original PDF and send evidence remain readable"], sources: ["business-commitments.ts", "business-proactive-google.ts", "business-coordinator.ts", "document-lifecycle.ts"] },
  { id: "calendar-lifecycle", route: "#tasks/:id", state: "insert-update-cancel-verified", assertions: ["Browser-delegated insert, update and cancellation change one provider event", "Independent provider GET matches the cancelled map entry", "Three verified action receipts and event references remain visible after refresh"], sources: ["business-providers.ts", "google-workspace.ts", "business-coordinator.ts"] },
  { id: "calendar-conflict", route: "#tasks/:id", state: "human-etag-preserved", assertions: ["A stale model-supplied etag cannot overwrite an independent human edit", "One provider event retains the human revision", "Refused action never becomes verified; browser shows the unresolved boundary and missing-information wait"], sources: ["business-providers.ts", "google-workspace.ts", "business-coordinator.ts"] },
  { id: "provider-stop-persisted", route: "#overview", state: "calendar-dispatch-stopped", assertions: ["Direct owner stop responds while a model turn is gated", "Releasing the model cannot dispatch the proposed calendar write", "Restart and refresh retain global stop and the unchanged provider event"], sources: ["business-coordinator.ts", "workspace-http.ts", "business-providers.ts"] },
  { id: "gmail-reconciling", route: "#tasks/:id", state: "accepted-mail-hidden-from-readback", assertions: ["Provider stores exactly one message before response loss", "Browser displays unknown rather than success", "Restart and refresh with delayed Sent visibility retain uncertainty without another send"], sources: ["business-coordinator.ts", "google-workspace.ts", "business-providers.ts"] },
  { id: "gmail-reconciled", route: "#tasks/:id", state: "sent-readback-recovered", assertions: ["Revealing the actual stored Sent message lets reconciliation verify the original action", "Browser displays the persisted verified Gmail reference after refresh", "Provider sees exactly one send request and one accepted message"], sources: ["business-coordinator.ts", "google-workspace.ts", "business-providers.ts"] },
] as const;
export type EvidenceCaseId = typeof evidenceCases[number]["id"];
export interface EvidenceCheckpoint {
  caseId: EvidenceCaseId;
  route: string;
  state: string;
  viewport: "desktop" | "mobile";
  theme: "light" | "dark";
  fixtureId: string;
  assertions: readonly string[];
  screenshotPath: string;
  taskIds: string[];
  actionIds: string[];
  verificationMode: "emulated" | "live";
}
export function affectedCases(paths: string[]): string[] {
  const matched = new Set<string>();
  for (const path of paths) {
    if (/\/web\/|workspace-page|workspace\.css|playwright|\/e2e\//.test(path)) return evidenceCases.map(c => c.id);
    const cases = evidenceCases.filter(c => c.sources.some(source => path.endsWith(source)));
    if (!cases.length) return evidenceCases.map(c => c.id);
    for (const item of cases) matched.add(item.id);
  }
  return matched.size ? [...matched] : evidenceCases.map(c => c.id);
}
