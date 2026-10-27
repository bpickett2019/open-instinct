export {};
type Json = null | string | number | boolean | Json[] | { [key: string]: Json };
interface Task { id: string; version: number; objective: string; doneCriteria: string[]; sourceRefs: string[]; evidenceRefs: string[]; status: string; checkpoint: Json; result: string | null; blocker: string | null; nextWake: number | null }
interface Action { id: string; tool: string; status: string; evidenceRefs: string[]; error: string | null; receipt: Json }
interface Message { id: string; cursor: number; role: string; text: string; channel: string; taskId: string | null; artifactIds: string[]; at: number }
interface Artifact { id: string; version: number; filename: string; mimeType: string; sha256: string; size: number; authority: string; scope: string; supersedes: string | null; extraction: Json; deleted: boolean; error: string | null; sourceLocator: string }
interface Settings { stopped: boolean; autonomy: string; timezone: string; currency: string; constraints: string[]; notificationPreferences: { progress: boolean; blockers: boolean; completion: boolean }; limits: { purchaseMinor: number | null; modelMinor: number | null; currency: string }; usage: { purchaseMinor: number; modelMinor: number; modelPriceUnknown: boolean; inputTokens: number; outputTokens: number }; backupRetention: number }
interface Versioned<T> { version: number; value: T }
interface AllowanceBalance { currency: string; limitMinor: number | null; usedMinor: number; heldMinor: number; remainingMinor: number | null; unknown: boolean }
interface Allowances { purchase: AllowanceBalance; model: AllowanceBalance; savedOwner: Json }
interface Overview { settings: Versioned<Settings>; allowances: Allowances; active: Task[]; waiting: Task[]; blockers: Task[]; recent: Task[]; unknown: Action[]; operationalBounds: Json }
interface Profile { version: number; facts: Array<{ key: string; value: Json; scope: string; citation: { sourceId: string; sourceVersion: number; locator: string } }>; nextQuestion: { key: string; question: string } | null; followThroughDefaults: Json; activeSources: Artifact[] }
interface OnboardingSnapshot { profile: Omit<Profile, "activeSources">; apps: Array<{ toolkit: string; name: string; purpose: string; status: "setup_required" | "available" | "waiting" | "connected" | "unavailable"; identity: string | null }>; computer: { status: "ready" | "setup_required"; description: string }; nextQuestion: Profile["nextQuestion"]; canContinue: true }
interface ConnectionStart { url: string | null; status: "waiting" | "connected" | "setup_required"; message: string }
interface Connection { id: string; version: number; toolkit: string; identity: string; accountId: string; status: string; scopes: string[]; revocation: string; verifiedAt: number | null }
interface Routine { id: string; kind: string; name: string; objective: string; doneCriteria: string[]; enabled: boolean; sources: Array<{ connectionId: string; accountId: string }>; timezone: string; cron: string | null; followUp: { maxUnanswered: number; intervalHours: number; contactHours: { days: number[]; startMinute: number; endMinute: number } }; activationAt: number | null }
interface Commitment { id: string; name: string; status: string; nextCheck: number | null; cancellationReason: string | null }
const content = document.querySelector<HTMLElement>("#content")!;
const navigation = document.querySelector<HTMLElement>("#navigation")!;
const controls = document.querySelector<HTMLElement>("#controls")!;
const connectionState = document.querySelector<HTMLElement>("#connection-state")!;
let csrf: string | undefined;
let stopped = false;
let settingsVersion = 0;
let renderGeneration = 0;
let activityCursor = 0;
let polling = false;
let delay = 2000;
let dirtyForm = false;
let overviewFingerprint = "";
let taskFingerprint = "";
let retryMessage: { clientId: string; text: string; taskId?: string } | undefined;
let refreshSetup: (() => Promise<void>) | undefined;
let refreshConversation: (() => Promise<void>) | undefined;
let openingRequest: Promise<{ reply: string }> | undefined;
const conversationRefreshers = new WeakMap<HTMLElement, () => Promise<void>>();
const setupRefreshers = new WeakMap<HTMLElement, () => Promise<void>>();
const sections = ["Overview", "Onboarding", "Tasks", "Chat", "Knowledge", "Files", "Connections", "Computer", "Activity", "Settings"];
const readable = (value: unknown): string => typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "Not recorded";
function node<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] { const element = document.createElement(tag); if (text !== undefined) element.textContent = text; if (className) element.className = className; return element; }
function link(text: string, href: string): HTMLAnchorElement { const a = node("a", text); a.href = href; return a; }
function safeExternal(text: string, href: string): HTMLAnchorElement | HTMLElement {
  try {
    const url = new URL(href); const loopback = (host: string): boolean => ["127.0.0.1", "localhost", "[::1]"].includes(host);
    const development = location.protocol === "http:" && loopback(location.hostname) && url.protocol === "http:" && loopback(url.hostname);
    if (url.username || url.password || url.protocol !== "https:" && !development) return node("p", "Provider returned an unsupported link. Use provider account controls.");
    const a = link(text, url.href); a.target = "_blank"; a.rel = "noopener noreferrer";
    if (development) { const wrapper = node("div"); wrapper.append(a, node("p", "Local provider fixture: protocol-only evidence, not a real hosted desktop or live-provider verification.")); return wrapper; }
    return a;
  } catch { return node("p", "Provider link unavailable"); }
}
function button(text: string, action: () => Promise<void>, className?: string): HTMLButtonElement { const b = node("button", text, className); b.type = "button"; b.addEventListener("click", () => { b.disabled = true; void action().catch(showError).finally(() => { b.disabled = false; }); }); return b; }
function showError(error: unknown): void { let box = document.querySelector<HTMLElement>("#error"); if (!box) { box = node("div", undefined, "error"); box.id = "error"; box.setAttribute("role", "alert"); content.prepend(box); } box.textContent = error instanceof Error ? error.message : "Operation failed"; }
function notice(text: string): void { connectionState.textContent = text; connectionState.className = ""; }
async function api<T>(path: string, method = "GET", data?: unknown): Promise<T> {
  let response: Response;
  try { response = await fetch(`/api/owner${path}`, { method, credentials: "same-origin", headers: { ...(method !== "GET" ? { "Content-Type": "application/json", ...(csrf ? { "X-Workspace-CSRF": csrf } : {}) } : {}) }, ...(data !== undefined ? { body: JSON.stringify(data) } : {}) }); }
  catch { throw new Error("Offline or unreachable. Displayed data may be stale; accepted work continues."); }
  const value = await response.json() as T & { error?: string };
  if (!response.ok) { if (response.status === 401 && path !== "/session") { csrf = undefined; login("Session expired. Sign in again; admitted work continues."); } throw new Error(value.error ?? `Request failed (${response.status})`); }
  return value;
}
function field(form: HTMLFormElement, labelText: string, value = "", multiline = false): HTMLInputElement | HTMLTextAreaElement {
  const label = node("label", labelText); const input = multiline ? node("textarea") : node("input"); input.value = value; input.name = labelText.toLowerCase().replace(/\W+/g, "-"); label.append(input); form.append(label); return input;
}
function checkbox(form: HTMLFormElement, text: string, checked = false): HTMLInputElement { const label = node("label", undefined, "check"); const input = node("input"); input.type = "checkbox"; input.checked = checked; label.append(input, document.createTextNode(text)); form.append(label); return input; }
function submit(form: HTMLFormElement, text: string, action: () => Promise<void>): void {
  const b = node("button", text, "primary"); b.type = "submit"; form.append(b);
  form.addEventListener("submit", event => { event.preventDefault(); b.disabled = true; document.querySelector("#error")?.remove(); void action().catch(showError).finally(() => { b.disabled = false; }); });
}
function card(title: string, text?: string): HTMLElement { const c = node("article", undefined, "card"); c.append(node("h2", title)); if (text) c.append(node("p", text)); return c; }
function details(title: string, value: unknown): HTMLElement { const d = node("details"); d.append(node("summary", title), node("pre", readable(value))); return d; }
function empty(target: HTMLElement, text: string): void { target.append(node("p", text, "empty")); }
function login(reason = "Use your private controller token. It is exchanged for a session and is never saved in browser storage."): void {
  csrf = undefined; renderGeneration++; navigation.replaceChildren(); controls.replaceChildren(); content.replaceChildren(node("h1", "Sign in"), node("p", reason)); content.dataset.screen = "login";
  refreshSetup = undefined;
  refreshConversation = undefined;
  const form = node("form"); const token = field(form, "Workspace token") as HTMLInputElement; token.type = "password"; token.autocomplete = "off"; token.required = true;
  submit(form, "Sign in", async () => { const secret = token.value; token.value = ""; const result = await api<{ csrf: string }>("/session", "POST", { token: secret }); csrf = result.csrf; notice("Connected"); await render(); }); content.append(form);
}
function shell(): void {
  navigation.replaceChildren(...sections.map(section => { const a = link(section, `#${section.toLowerCase()}`); if ((location.hash.slice(1).split("/")[0] || "onboarding") === section.toLowerCase()) a.setAttribute("aria-current", "page"); return a; }));
  controls.replaceChildren(button(stopped ? "Resume work" : "Stop all work", async () => { const result = await api<{ settings: Versioned<Settings> }>("/control", "POST", { target: "workspace", operation: stopped ? "resume" : "pause", expectedVersion: settingsVersion }); stopped = result.settings.value.stopped; settingsVersion = result.settings.version; notice(stopped ? "Globally stopped. Already-dispatched operations may still finish." : "Resumed. Unknown outcomes are not replayed."); await render(); }, stopped ? "primary" : "danger"), button("Sign out", async () => { await api("/session", "DELETE", {}); login("Signed out. Accepted work continues while the browser is closed."); }));
}
function taskCards(target: HTMLElement, tasks: Task[]): void {
  if (!tasks.length) { empty(target, "No work in this state."); return; }
  for (const task of tasks) { const c = card(task.objective); c.append(node("span", task.status, `badge ${task.status}`), node("p", task.result ?? task.blocker ?? "Accepted work is not yet complete."), link("Inspect task", `#tasks/${task.id}`)); target.append(c); }
}
function allowanceCards(allowances: Allowances): HTMLElement {
  const section = node("section"); section.setAttribute("aria-label", "Allowance balances");
  for (const [kind, label] of [["purchase", "Purchase allowance"], ["model", "Model allowance"]] as const) {
    const balance = allowances[kind]; const units = kind === "model" ? "USD cents" : `${balance.currency} minor units`;
    const panel = card(label); panel.dataset.allowance = kind;
    const values = node("dl");
    for (const [name, value] of [
      ["Accounted", `${balance.usedMinor} ${units}`],
      ["Held", `${balance.heldMinor} ${units}`],
      ["Limit", balance.limitMinor === null ? "Unconfigured (no owner cap)" : `${balance.limitMinor} ${units}`],
      ["Remaining", balance.unknown ? "Unknown (usage or pricing unavailable)" : balance.remainingMinor === null ? "Unconfigured (no owner cap)" : `${balance.remainingMinor} ${units}`],
    ]) values.append(node("dt", name), node("dd", value));
    panel.append(values, node("p", balance.unknown ? "Some usage or pricing is unknown, not free. Accounted amounts are not a complete total." : "Accounted usage excludes held reservations. Unknown outcomes retain their holds."));
    section.append(panel);
  }
  section.append(node("p", "Purchase amounts use business currency. Model amounts use USD cents. No currency conversion or default owner cap is assumed."));
  if (allowances.savedOwner) section.append(details("Saved owner purchase restrictions (USD cents; retained from policy.json)", allowances.savedOwner));
  return section;
}
async function overview(): Promise<HTMLElement[]> {
  const data = await api<Overview>("/overview"); stopped = data.settings.value.stopped; settingsVersion = data.settings.version; shell();
  overviewFingerprint = JSON.stringify(data);
  const state = card(stopped ? "Globally stopped" : "Full autonomy", "Your assistant acts within your standing rules. No routine approval queue. Provider authentication and genuine missing information may require your attention.");
  state.append(details("Operational bounds", data.operationalBounds));
  const setup = card("Set up with your assistant", "Tell me about your business, connect the apps you want help with, or keep the conversation going. You can start work before setup is finished.");
  setup.append(link("Continue setup", "#onboarding"), link("Continue in chat", "#chat"));
  const output = [setup, state, allowanceCards(data.allowances)];
  for (const [label, tasks] of [["Active work", data.active], ["Waiting", data.waiting], ["Blockers", data.blockers], ["Recent results", data.recent]] as const) { const section = node("section"); section.append(node("h2", label)); taskCards(section, tasks); output.push(section); }
  if (data.unknown.length) { const unknown = card("Unknown external outcomes", "These actions may have happened. They will not be blindly replayed."); for (const action of data.unknown) unknown.append(node("p", `${action.tool}: ${action.status} (${action.id})`)); output.push(unknown); }
  return output;
}
async function tasks(id?: string): Promise<HTMLElement[]> {
  if (!id) { const data = await api<{ tasks: Task[] }>("/tasks"); const list = node("section"); taskCards(list, data.tasks); return [link("Delegate new work", "#chat"), list]; }
  const { task, actions, waits } = await api<{ task: Task; actions: Action[]; waits: Json[] }>(`/tasks/${encodeURIComponent(id)}`);
  taskFingerprint = JSON.stringify({ task, actions, waits });
  const summary = card(task.objective); summary.dataset.taskId = id; summary.append(node("p", `Status: ${task.status}`), node("p", task.result ?? task.blocker ?? "No final result yet"), node("p", `Next check: ${task.nextWake ? new Date(task.nextWake).toLocaleString() : "Event or worker scheduling"}`), details("Plan / checkpoint", task.checkpoint), details("Sources", task.sourceRefs), details("Done criteria", task.doneCriteria), details("Wait conditions", waits), details("Result evidence", task.evidenceRefs));
  for (const ref of [...task.sourceRefs, ...task.evidenceRefs]) { const match = /^(knowledge|artifact):([a-f0-9-]{36})(?:[:#]|$)/.exec(ref); if (match) summary.append(link(ref, `#${match[1] === "artifact" ? "knowledge" : "sources"}/${match[2]}`)); }
  summary.append(button("Refresh task evidence", render));
  const actionsSection = card("Action evidence", "Verified means the recorded provider/readback evidence supports the action. It does not imply delivery or the business outcome.");
  if (!actions.length) empty(actionsSection, "No attempted actions yet.");
  for (const action of actions) { const c = card(action.tool); c.dataset.actionId = action.id; c.append(node("p", action.status, `badge ${action.status}`), node("p", action.error ?? ""), details("Receipt", action.receipt), details("Evidence references", action.evidenceRefs)); actionsSection.append(c); }
  const form = node("form"); form.append(node("h2", "Change objective")); const objective = field(form, "Objective", task.objective, true); const criteria = field(form, "Done criteria (one per line)", task.doneCriteria.join("\n"), true);
  submit(form, "Save task changes", async () => { await api(`/tasks/${id}`, "PATCH", { expectedVersion: task.version, objective: objective.value, doneCriteria: criteria.value.split("\n").filter(Boolean) }); await render(); });
  const operations = node("div", undefined, "actions"); for (const [label, operation] of [["Cancel task", "stop"], ["Close task", "close"]]) operations.append(button(label!, async () => { await api("/control", "POST", { target: id, operation, expectedVersion: task.version }); await render(); }));
  return [summary, actionsSection, form, operations];
}
function messageText(text: string): HTMLElement {
  const paragraph = node("p"); let offset = 0;
  for (const match of text.matchAll(/https:\/\/[^\s<>"']+/g)) {
    const href = match[0].replace(/[.,;:!?)}\]]+$/, "");
    paragraph.append(document.createTextNode(text.slice(offset, match.index)), safeExternal(href, href));
    offset = match.index + href.length;
  }
  paragraph.append(document.createTextNode(text.slice(offset)));
  return paragraph;
}
function appendMessages(target: HTMLElement, messages: Message[]): number {
  let cursor = 0;
  const followLatest = target.scrollHeight - target.scrollTop - target.clientHeight < 48;
  if (messages.length) target.querySelector(".empty")?.remove();
  for (const message of messages) {
    cursor = Math.max(cursor, message.cursor);
    if (target.querySelector(`[data-cursor="${message.cursor}"]`)) continue;
    const speaker = message.role === "owner" ? "You" : message.role === "assistant" ? "Your assistant" : "Workspace";
    const channel = message.channel === "imessage" ? "Text message" : message.channel === "chat" ? "Workspace" : message.channel;
    const c = node("article", undefined, `message ${message.role}`); c.dataset.cursor = String(message.cursor); c.append(node("h2", speaker), messageText(message.text), node("small", `${channel} · ${new Date(message.at).toLocaleString()}`)); if (message.taskId) c.append(link("Task evidence", `#tasks/${message.taskId}`)); for (const id of message.artifactIds) c.append(link("Download artifact", `/api/owner/files/${encodeURIComponent(id)}/download`)); target.append(c);
  }
  if (messages.length && followLatest) target.scrollTop = target.scrollHeight;
  return cursor;
}
async function chat(setup = false): Promise<HTMLElement[]> {
  let messageCursor = 0;
  const conversation = node("section", undefined, "conversation");
  conversation.setAttribute("aria-label", setup ? "Setup conversation" : "Conversation");
  const history = node("section"); history.id = "messages"; history.setAttribute("aria-label", "Durable message history"); history.setAttribute("aria-live", "polite");
  const pending = node("p", "", "conversation-pending"); pending.setAttribute("role", "status"); pending.hidden = true;
  let sending = false; let refreshing = false; let opened = !setup;
  const pendingTurns = new Set<string>(); const settledTurns = new Set<string>();
  const recoveredReplies = new Map<string, string>();
  const update = (messages: Message[]): void => {
    messageCursor = Math.max(messageCursor, appendMessages(history, messages));
    for (const item of messages) {
      if (item.role === "owner" && item.id.startsWith("web:") || item.id === "workspace-onboarding") {
        if (!settledTurns.has(item.id)) pendingTurns.add(item.id);
      }
      const answer = /^(?:answer|reply):(.+)$/.exec(item.id);
      if (answer) { settledTurns.add(answer[1]!); pendingTurns.delete(answer[1]!); recoveredReplies.delete(answer[1]!); }
    }
    const recovered = [...recoveredReplies.values()].join("\n");
    pending.hidden = !pendingTurns.size && !sending && !recovered;
    pending.textContent = [recovered, sending ? "Sending your message…" : pendingTurns.size ? "Your assistant is thinking…" : ""].filter(Boolean).join("\n");
  };
  const data = await api<{ messages: Message[]; hasMore: boolean }>("/messages?after=0"); update(data.messages);
  if (!data.messages.length && !setup) empty(history, "Start a conversation here. Your texts and workspace messages stay together.");
  const load = button("Load more messages", async () => { const next = await api<{ messages: Message[]; hasMore: boolean }>(`/messages?after=${messageCursor}`); update(next.messages); load.hidden = !next.hasMore; }); load.hidden = !data.hasMore;
  const form = node("form", undefined, "conversation-composer"); const message = field(form, "Message", retryMessage?.text ?? "", true); message.required = true; message.placeholder = "Tell me about your business, or ask anything…";
  const options = node("details"); options.append(node("summary", "Link to an existing task"));
  const taskLabel = node("label", "Task reference (optional)"); const task = node("input"); task.value = retryMessage?.taskId ?? ""; taskLabel.append(task); options.append(taskLabel); form.append(options);
  const refresh = async (): Promise<void> => {
    if (!conversation.isConnected || refreshing) return;
    refreshing = true;
    try {
      if (!opened) {
        pending.hidden = false; pending.textContent = "Your assistant is getting ready…";
        openingRequest ??= api<{ reply: string }>("/onboarding/conversation", "POST", {});
        try {
          const result = await openingRequest; opened = true;
          if (!settledTurns.has("workspace-onboarding")) {
            if (result.reply) { recoveredReplies.set("workspace-onboarding", result.reply); pendingTurns.delete("workspace-onboarding"); settledTurns.add("workspace-onboarding"); }
            else pendingTurns.add("workspace-onboarding");
          }
        } catch (error) { openingRequest = undefined; throw error; }
      }
      const next = await api<{ messages: Message[]; hasMore: boolean }>(`/messages?after=${messageCursor}`);
      if (conversation.isConnected) { update(next.messages); load.hidden = !next.hasMore; }
    } finally { refreshing = false; }
  };
  conversationRefreshers.set(conversation, refresh);
  submit(form, "Send message", async () => {
    if (!retryMessage || retryMessage.text !== message.value || (retryMessage.taskId ?? "") !== task.value) retryMessage = { clientId: crypto.randomUUID(), text: message.value, ...(task.value ? { taskId: task.value } : {}) };
    const submitted = retryMessage; const turnId = `web:${submitted.clientId}`; sending = true; update([]);
    try {
      const result = await api<{ reply: string }>("/messages", "POST", submitted); retryMessage = undefined;
      if (!settledTurns.has(turnId)) {
        if (result.reply) { recoveredReplies.set(turnId, result.reply); settledTurns.add(turnId); pendingTurns.delete(turnId); }
        else pendingTurns.add(turnId);
      }
      if (message.value === submitted.text) message.value = "";
      if (task.value === (submitted.taskId ?? "")) task.value = "";
      await refresh();
      await refreshSetup?.();
    } finally { sending = false; update([]); }
  });
  conversation.append(history, load, pending, form);
  return [conversation];
}
async function onboarding(): Promise<HTMLElement[]> {
  const snapshot = await api<OnboardingSnapshot>("/onboarding"); let profile = snapshot.profile;
  const introduction = node("p", "Tell your assistant about your business, ask a question, or start with what you need help with. There’s no checklist to finish first.", "conversation-intro");
  const conversation = await chat(true);
  const saved = node("details", undefined, "setup-secondary"); saved.append(node("summary", "What I know so far"));
  const facts = node("div"); let factsFingerprint = "";
  const updateProfile = (current: OnboardingSnapshot): void => {
    profile = current.profile;
    const fingerprint = JSON.stringify(profile.facts);
    if (fingerprint === factsFingerprint || facts.contains(document.activeElement)) return;
    factsFingerprint = fingerprint; facts.replaceChildren();
    if (!profile.facts.length) facts.append(node("p", "Saved business facts and their sources will appear here as we talk."));
    for (const fact of profile.facts) facts.append(node("p", `${fact.key}: ${readable(fact.value)}`), link(`Source v${fact.citation.sourceVersion} · ${fact.citation.locator}`, `#sources/${fact.citation.sourceId}`));
  };
  updateProfile(snapshot);
  const advanced = node("details"); advanced.append(node("summary", "Advanced profile edits and sources"));
  const form = node("form"); const key = field(form, "Fact", "businessName"); key.required = true;
  const value = field(form, "Fact value", "", true); value.required = true; const scope = field(form, "Scope", "business"); scope.required = true;
  let editVersion: number | undefined;
  form.addEventListener("input", () => { editVersion ??= profile.version; });
  submit(form, "Save advanced profile edit", async () => { await api("/profile", "PATCH", { expectedVersion: editVersion ?? profile.version, facts: [{ key: key.value, value: value.value, scope: scope.value }] }); editVersion = undefined; notice("Profile saved"); await refreshSetup?.(); });
  const sources = details("Active sources", "Loading sources…");
  advanced.addEventListener("toggle", () => {
    if (advanced.open) void api<Profile>("/profile").then(current => { sources.querySelector("pre")!.textContent = readable(current.activeSources); }).catch(() => { sources.querySelector("pre")!.textContent = "Sources could not be loaded. Close and reopen advanced edits to try again."; });
  });
  advanced.append(node("p", "Owner facts establish rules; imported messages and summaries do not."), form, details("Follow-through defaults", profile.followThroughDefaults), sources);
  saved.append(facts, advanced);
  const apps = node("details", undefined, "setup-secondary"); apps.append(node("summary", "Connect apps and your computer"), setupConnections(snapshot, updateProfile));
  return [introduction, ...conversation, saved, apps];
}

function setupConnections(initial: OnboardingSnapshot, onRefresh?: (snapshot: OnboardingSnapshot) => void): HTMLElement {
  const section = node("section"); section.dataset.setup = ""; section.setAttribute("aria-label", "Apps and computer setup");
  section.append(node("h2", "Give me the tools you want help with"), node("p", "Connecting an app does not start routines or scan old messages. You choose what I work on."));
  const grid = node("div", undefined, "setup-apps"); section.append(grid);
  const views = new Map<string, { status: HTMLElement; outcome: HTMLElement; action: HTMLButtonElement }>();
  let revision = 0;
  let pendingOther: { toolkit: string; status: HTMLElement } | undefined;
  const update = (snapshot: OnboardingSnapshot): void => {
    for (const app of snapshot.apps) {
      const view = views.get(app.toolkit); if (!view) continue;
      const text = app.status === "connected" ? `Connected${app.identity ? ` as ${app.identity}` : ""}` : app.status === "waiting" ? "Waiting for sign-in confirmation. I’ll check automatically while this page is open." : app.status === "setup_required" ? "Sign-in is not enabled here yet. You can keep talking with me without connecting this app." : app.status === "unavailable" ? "Account status is temporarily unavailable. I’ll keep checking; our conversation can continue." : "Ready to connect when you are.";
      if (view.status.textContent !== text) view.status.textContent = text;
      view.status.dataset.status = app.status;
      const label = app.status === "connected" ? `${app.name} connected` : `Connect ${app.name}`;
      if (view.action.textContent !== label) view.action.textContent = label;
      view.action.disabled = app.status === "connected";
      if (app.status === "connected" && view.outcome.childNodes.length && !view.outcome.contains(document.activeElement)) view.outcome.replaceChildren();
    }
    const text = `${snapshot.computer.status === "ready" ? "Ready" : "Not enabled yet"} · ${snapshot.computer.description}`;
    if (computerStatus.textContent !== text) computerStatus.textContent = text;
  };
  const start = async (toolkit: string, outcome: HTMLElement): Promise<void> => {
    revision++;
    try {
      const result = await api<ConnectionStart>("/connections", "POST", { toolkit });
      revision++;
      outcome.replaceChildren(node("p", result.message));
      if (result.url) outcome.append(safeExternal("Continue private sign-in", result.url));
      if (!onRefresh) outcome.append(link("Continue in chat", "#chat"));
      const view = views.get(toolkit);
      if (view) { view.status.dataset.status = result.status; view.status.textContent = result.status === "waiting" ? "Waiting for sign-in confirmation." : result.status === "connected" ? result.message : "Sign-in is not enabled here yet."; view.action.disabled = result.status === "connected"; }
      if (!view) {
        pendingOther = undefined;
        if (result.status === "waiting") { const status = node("p", "Waiting for sign-in confirmation."); outcome.append(status); pendingOther = { toolkit, status }; }
      }
    } catch {
      revision++;
      outcome.replaceChildren(node("p", "I couldn’t start sign-in right now. Try again, or keep talking with me without connecting this app."));
      if (!onRefresh) outcome.append(link("Continue in chat", "#chat"));
    }
  };
  for (const app of initial.apps) {
    const panel = card(app.name, app.purpose); panel.dataset.app = app.toolkit;
    const status = node("p"); status.setAttribute("role", "status");
    const outcome = node("div"); outcome.setAttribute("aria-live", "polite");
    const action = button(`Connect ${app.name}`, async () => { await start(app.toolkit, outcome); });
    views.set(app.toolkit, { status, outcome, action }); panel.append(status, action, outcome); grid.append(panel);
  }
  const computer = card("Your hosted computer"); const computerStatus = node("p"); computerStatus.setAttribute("role", "status"); computer.append(computerStatus, link("Computer details", "#computer")); section.append(computer);
  const other = node("details"); other.append(node("summary", "Advanced: connect another app"));
  const form = node("form"); const toolkit = field(form, "Other app identifier"); toolkit.required = true;
  const outcome = node("div"); outcome.setAttribute("aria-live", "polite");
  submit(form, "Connect other app", async () => { await start(toolkit.value.trim(), outcome); });
  other.append(form, outcome); section.append(other);
  update(initial);
  const refresh = async (): Promise<void> => {
    const version = revision; const snapshot = await api<OnboardingSnapshot>("/onboarding");
    if (!section.isConnected || version !== revision) return;
    update(snapshot);
    onRefresh?.(snapshot);
    const pending = pendingOther;
    if (pending) {
      try {
        const data = await api<{ connections: Connection[] }>("/connections");
        if (!section.isConnected || pendingOther !== pending || version !== revision) return;
        const account = data.connections.find(item => item.toolkit === pending.toolkit && item.status === "connected" && item.verifiedAt !== null);
        const text = account ? `Connected as ${account.identity}` : "Waiting for sign-in confirmation. I’ll keep checking automatically.";
        if (pending.status.textContent !== text) pending.status.textContent = text;
        if (account) pendingOther = undefined;
      } catch { if (section.isConnected && pendingOther === pending) pending.status.textContent = "Account status is temporarily unavailable. I’ll keep checking automatically."; }
    }
  };
  section.append(button("Refresh account status", refresh));
  setupRefreshers.set(section, refresh);
  return section;
}
function artifactCard(artifact: Artifact): HTMLElement { const c = card(artifact.filename); c.append(node("p", `Version ${artifact.version} · ${artifact.deleted ? "removed from active knowledge" : "retained"} · ${readable(artifact.extraction)}`), node("p", artifact.error ?? ""), link("Source and versions", `#knowledge/${artifact.id}`), link("Download original", `/api/owner/files/${artifact.id}/download`)); return c; }
async function knowledge(id?: string, files = false): Promise<HTMLElement[]> {
  if (id) {
    const data = await api<{ artifact: Artifact; chunks: Array<{ locator: string; text: string }> }>(`/knowledge/${encodeURIComponent(id)}`); const a = data.artifact; const info = artifactCard(a);
    info.append(details("Source metadata and content hash", a));
    for (const chunk of data.chunks) { const c = card(chunk.locator); c.append(node("p", chunk.text)); info.append(c); }
    if (!data.chunks.length) empty(info, "No extracted text. Inspect extraction status; an empty extraction is not success.");
    info.append(button("Retry extraction", async () => { await api(`/knowledge/${id}/retry`, "POST", { expectedVersion: a.version }); await render(); }), button("Remove from active knowledge", async () => { const result = await api<{ retainedEvidence: string }>(`/knowledge/${id}`, "DELETE", { expectedVersion: a.version }); location.hash = "knowledge"; notice(result.retainedEvidence); }));
    if (a.supersedes) info.append(link("Previous source version", `#knowledge/${a.supersedes}`));
    return [info, upload(a)];
  }
  const data = await api<{ artifacts: Artifact[] }>(files ? "/files" : "/knowledge"); const list = node("section"); if (!data.artifacts.length) empty(list, "No files yet. Upload a source or delegate document creation."); for (const artifact of data.artifacts) list.append(artifactCard(artifact));
  if (files) return [node("p", "Originals and generated deliverables use the same versioned artifact store. Downloads are attachments, never active pages."), list];
  const search = node("form"); const query = field(search, "Search knowledge"); const results = node("section"); results.setAttribute("aria-live", "polite");
  submit(search, "Search", async () => {
    const result = await api<{ results: Array<{ sourceId: string; sourceVersion: number; locator: string; text: string }> }>(`/knowledge?q=${encodeURIComponent(query.value)}`);
    results.replaceChildren(node("h2", "Source-linked search results")); if (!result.results.length) empty(results, "No matching active source.");
    for (const item of result.results) { const hit = card(`Source v${item.sourceVersion} · ${item.locator}`); hit.append(node("pre", item.text), link("Open cited source", `#sources/${item.sourceId}`)); results.append(hit); }
  });
  return [link("Business profile", "#onboarding"), search, results, upload(), list];
}
async function sourceDetail(id: string): Promise<HTMLElement[]> {
  const source = await api<Versioned<{ id: string; sourceVersion: number; sha256: string; authority: string; scope: string; sourceLocator: string; supersedes: string | null; supersededBy: string | null; taskIds: string[]; chunks: Array<{ locator: string; text: string }> }> & { obsolete: boolean; activeLocators: string[] }>(`/sources/${encodeURIComponent(id)}`);
  const c = card(`Source version ${source.value.sourceVersion}`, `${source.value.authority} · scope ${source.value.scope}${source.obsolete ? " · superseded, not active authority" : ""}`);
  c.append(node("p", source.value.sourceLocator), details("Source content hash", source.value.sha256));
  for (const chunk of source.value.chunks) c.append(card(`${chunk.locator}${source.obsolete || !source.activeLocators.includes(chunk.locator) ? " · historical, not active authority" : " · active source"}`, chunk.text));
  for (const taskId of source.value.taskIds) c.append(link("Associated task", `#tasks/${taskId}`));
  if (source.value.supersedes) c.append(link("Previous source version", `#sources/${source.value.supersedes}`));
  if (source.value.supersededBy) c.append(link("Replacement source version", `#sources/${source.value.supersededBy}`));
  c.append(button("Remove source from active retrieval", async () => { const result = await api<{ retainedEvidence: string }>(`/sources/${encodeURIComponent(id)}`, "DELETE", { expectedVersion: source.version }); location.hash = "knowledge"; notice(result.retainedEvidence); }));
  return [c];
}
function upload(previous?: Artifact): HTMLFormElement {
  const form = node("form"); form.append(node("h2", previous ? "Replace source with a new version" : "Upload source"));
  const file = field(form, "Document (maximum 20 MiB)") as HTMLInputElement; file.type = "file"; file.required = true; file.accept = ".txt,.md,.csv,.pdf,.docx,.xlsx,.png,.jpg,.jpeg,.webp";
  const authoritative = checkbox(form, "Designate as authoritative business rules"); const scope = field(form, "Authority scope", previous?.scope ?? "business");
  submit(form, "Upload document", async () => {
    const selected = file.files?.[0]; if (!selected || selected.size > 20 * 1024 * 1024) throw new Error("Choose a file up to 20 MiB");
    const { promise, resolve, reject } = Promise.withResolvers<string>();
    const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",")[1]!); reader.onerror = () => reject(new Error("Unable to read selected file")); reader.readAsDataURL(selected);
    const base64 = await promise;
    const artifact = await api<Artifact>("/knowledge", "POST", { filename: selected.name, mimeType: selected.type || "application/octet-stream", base64, authoritative: authoritative.checked, scope: scope.value, ...(previous ? { supersedes: previous.id, expectedVersion: previous.version } : {}) }); location.hash = `knowledge/${artifact.id}`; if (previous?.id === artifact.id) await render();
  }); return form;
}
async function connections(): Promise<HTMLElement[]> {
  const snapshot = await api<OnboardingSnapshot>("/onboarding");
  const setup = setupConnections(snapshot);
  const management = node("details"); management.append(node("summary", "Manage connected accounts and permissions"));
  const list = node("section"); management.append(list);
  const load = async (): Promise<void> => {
    try {
      const data = await api<{ connections: Connection[] }>("/connections"); list.replaceChildren();
      if (!data.connections.length) empty(list, "No connected accounts yet. You can keep setting up your business without connecting an app.");
      for (const connection of data.connections) {
        const c = card(`${connection.toolkit}: ${connection.identity}`);
        c.append(node("p", `${connection.status} · account ${connection.accountId}`), node("p", `Routine source: ${connection.id},${connection.accountId}`), node("p", `Last verified: ${connection.verifiedAt === null ? "not verified" : new Date(connection.verifiedAt).toLocaleString()}`), node("p", `Upstream revocation: ${connection.revocation}. Requested does not mean verified revoked.`), details("Granted scopes", connection.scopes), button("Disconnect account", async () => { await api(`/connections/${connection.id}`, "DELETE", { expectedVersion: connection.version }); await load(); await refreshSetup?.(); })); list.append(c);
      }
    } catch { list.replaceChildren(node("p", "Account details are unavailable right now. You can continue setup or chat and try again later."), link("Continue setup", "#onboarding"), link("Continue in chat", "#chat")); }
  };
  management.addEventListener("toggle", () => { if (management.open) void load(); });
  management.append(node("p", "Disconnect disables future app actions first. Revocation can take time. Browser sign-ins are separate and need their own logout."), button("Reload account details", load));
  return [link("Continue in chat", "#chat"), setup, management];
}
async function computer(): Promise<HTMLElement[]> {
  const status = await api<{ status: string; description: string; takeoverUrl?: string | null; taskId?: string | null }>("/computer"); const c = card("Hosted computer", status.description);
  c.append(node("p", status.status), node("p", "A takeover is a provider challenge, not a routine approval. The assistant must verify provider status after you finish; saying done does not prove success."));
  if (status.takeoverUrl) c.append(safeExternal("Open private takeover", status.takeoverUrl)); if (status.taskId) c.append(link("Related task", `#tasks/${status.taskId}`));
  c.append(button("Check takeover status", async () => { await api("/computer/check", "POST", {}); await render(); }));
  const privacy = node("form"); privacy.append(node("h2", "Release sensitive-session privacy"), node("p", "After leaving human takeover, clear passwords, payment details and sensitive desktop fields or log out of the sensitive session. Screenshots and ordinary computer work can resume only after this explicit confirmation and a provider-mode check."));
  const confirmed = checkbox(privacy, "I cleared sensitive desktop fields and sessions"); confirmed.required = true;
  submit(privacy, "Allow computer screenshots again", async () => { if (!confirmed.checked) throw new Error("Confirm that sensitive fields and sessions were cleared"); await api("/computer/privacy", "POST", { sensitiveSessionCleared: true }); notice("Privacy release checked against provider state"); await render(); });
  return [c, privacy];
}
async function activity(): Promise<HTMLElement[]> {
  activityCursor = 0; const list = node("section");
  const load = async (): Promise<boolean> => { const data = await api<{ activity: Array<{ cursor: number; kind: string; taskId: string | null; actionId: string | null; detail: Json }>; notifications: Json[]; hasMore: boolean }>(`/activity?after=${activityCursor}`); for (const event of data.activity) { const c = card(event.kind); if (event.taskId) c.append(link("Task", `#tasks/${event.taskId}`)); c.append(node("p", event.actionId ?? ""), details("Recorded evidence", event.detail)); list.append(c); activityCursor = event.cursor; } notification.replaceChildren(node("h2", "Notification transport"), details("Delivery attempts (acceptance is not delivery)", data.notifications)); return data.hasMore; };
  const notification = node("section"); const more = button("Load more activity", async () => { more.hidden = !await load(); }); more.hidden = !await load(); if (!list.children.length) empty(list, "No activity recorded yet."); return [list, more, notification];
}
async function settings(): Promise<HTMLElement[]> {
  const data = await api<{ settings: Versioned<Settings>; allowances: Allowances; sessions: Json; routines: Versioned<Routine>[]; commitments: Versioned<Commitment>[]; backupAvailable: boolean; exportAvailable: boolean }>("/settings"); const s = data.settings.value;
  const form = node("form"); const timezone = field(form, "Timezone", s.timezone); const currency = field(form, "Currency", s.currency); const constraints = field(form, "Standing rules (one per line)", s.constraints.join("\n"), true);
  const purchase = field(form, `Purchase limit in ${s.currency} minor units (blank means no owner cap)`, s.limits.purchaseMinor?.toString() ?? ""); const model = field(form, "Model limit in USD cents (blank means no owner cap)", s.limits.modelMinor?.toString() ?? "");
  form.append(node("p", "Business currency applies to purchases only. Model usage and limits always use USD cents, independent of business currency. Unknown model pricing is not free; no exchange rate is assumed."));
  const retention = field(form, "Backups to retain", String(s.backupRetention)); const progress = checkbox(form, "Text meaningful progress", s.notificationPreferences.progress); const blockers = checkbox(form, "Text genuine blockers", s.notificationPreferences.blockers); const completion = checkbox(form, "Text completion", s.notificationPreferences.completion);
  submit(form, "Save settings", async () => { await api("/settings", "PATCH", { expectedVersion: data.settings.version, timezone: timezone.value, currency: currency.value, constraints: constraints.value.split("\n").filter(Boolean), limits: { purchaseMinor: purchase.value === "" ? null : Number(purchase.value), modelMinor: model.value === "" ? null : Number(model.value) }, backupRetention: Number(retention.value), notificationPreferences: { progress: progress.checked, blockers: blockers.checked, completion: completion.checked } }); notice("Settings saved"); await render(); });
  const session = card("Browser sessions", "Sessions expire after 24 hours or 30 minutes idle. Controller restart signs browsers out without deleting work."); session.append(details("Active sessions", data.sessions), button("Sign out all browser sessions", async () => { await api("/session", "DELETE", { all: true }); login("All browser sessions signed out."); }));
  const operations = card("Export and backup", "Exports exclude credentials and cookies. Backups stay on the controller. Deleting a source does not erase retained action evidence, backups or third-party data. Restore is an operator CLI action into a fresh, stopped directory.");
  if (data.backupAvailable) operations.append(button("Create backup", async () => { const result = await api<{ id: string; retention: number }>("/backup", "POST", {}); notice(`Backup ${result.id} created; retention ${result.retention}.`); }));
  if (data.exportAvailable) operations.append(button("Export business data", async () => {
    const response = await fetch("/api/owner/export", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-Workspace-CSRF": csrf! }, body: "{}" });
    if (!response.ok) { if (response.status === 401) login("Session expired. Sign in again to export."); throw new Error("Export failed"); }
    const url = URL.createObjectURL(await response.blob()); const a = link("Download export", url); a.download = /filename="([^"]+)"/.exec(response.headers.get("content-disposition") ?? "")?.[1] ?? "business-export.json"; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }));
  const routines = node("section"); routines.append(node("h2", "Standing routines"), node("p", "Enable only selected sources. Activation begins now, not a historical scan. Follow-through defaults are two unanswered chases, 72 elapsed hours apart, within contact hours."));
  for (const row of data.routines) {
    const r = row.value; const panel = node("details"); panel.append(node("summary", `${r.name}: ${r.enabled ? "enabled" : "disabled"}`));
    const routineForm = node("form"); const enabled = checkbox(routineForm, "Enable this routine", r.enabled);
    const objective = field(routineForm, "Routine objective", r.objective, true); const criteria = field(routineForm, "Routine done criteria (one per line)", r.doneCriteria.join("\n"), true);
    const sources = field(routineForm, "Source accounts (connection ID,account ID; one per line)", r.sources.map(source => `${source.connectionId},${source.accountId}`).join("\n"), true);
    const zone = field(routineForm, "Routine timezone", r.timezone); const cron = field(routineForm, "Recurrence (cron; blank for event-triggered)", r.cron ?? "");
    const maximum = field(routineForm, "Maximum unanswered chases", String(r.followUp.maxUnanswered)); const interval = field(routineForm, "Elapsed hours between chases", String(r.followUp.intervalHours));
    const days = field(routineForm, "Contact days (0 Sunday to 6 Saturday)", r.followUp.contactHours.days.join(",")); const start = field(routineForm, "Contact window start (minutes after midnight)", String(r.followUp.contactHours.startMinute)); const end = field(routineForm, "Contact window end (minutes after midnight)", String(r.followUp.contactHours.endMinute));
    routineForm.append(node("p", `Activation: ${r.activationAt === null ? "not active" : new Date(r.activationAt).toLocaleString()}`), link("Inspect connected account IDs", "#connections"));
    submit(routineForm, "Save routine", async () => {
      const selected = sources.value.split("\n").filter(Boolean).map(line => { const pair = line.split(",").map(value => value.trim()); if (pair.length !== 2 || !pair[0] || !pair[1]) throw new Error("Use connection ID,account ID for each selected source"); return { connectionId: pair[0], accountId: pair[1] }; });
      await api(`/routines/${encodeURIComponent(r.id)}`, "PATCH", { expectedVersion: row.version, routine: { kind: r.kind, name: r.name, objective: objective.value, doneCriteria: criteria.value.split("\n").filter(Boolean), enabled: enabled.checked, sources: selected, timezone: zone.value, cron: cron.value || null, followUp: { maxUnanswered: Number(maximum.value), intervalHours: Number(interval.value), contactHours: { days: days.value.split(",").map(Number), startMinute: Number(start.value), endMinute: Number(end.value) } } } }); notice("Standing routine saved"); await render();
    }); panel.append(routineForm); routines.append(panel);
  }
  const commitments = card("Commitments"); if (!data.commitments.length) empty(commitments, "No scheduled commitments.");
  for (const row of data.commitments) { const item = card(row.value.name, `${row.value.status}; next check ${row.value.nextCheck === null ? "none" : new Date(row.value.nextCheck).toLocaleString()}`); if (row.value.status === "active") item.append(button("Cancel commitment", async () => { await api(`/commitments/${encodeURIComponent(row.value.id)}`, "DELETE", { expectedVersion: row.version, reason: "Owner cancelled from workspace" }); await render(); })); commitments.append(item); }
  return [link("Edit business profile", "#onboarding"), form, allowanceCards(data.allowances), details(`Usage detail: purchaseMinor in ${s.currency} minor units; modelMinor in USD cents`, s.usage), routines, commitments, session, operations];
}
async function render(): Promise<void> {
  if (!csrf) { login(); return; }
  const generation = ++renderGeneration; const [route = "onboarding", id] = location.hash.slice(1).split("/"); const screen = route || "onboarding";
  content.dataset.screen = id ? `${screen}-detail` : screen;
  dirtyForm = false;
  refreshSetup = undefined;
  refreshConversation = undefined;
  shell(); content.replaceChildren(node("h1", id ? screen === "tasks" ? "Task detail" : "Knowledge source / version" : screen === "onboarding" ? "Onboarding" : screen[0]!.toUpperCase() + screen.slice(1)), node("p", "Loading…", "loading"));
  try {
    let children: HTMLElement[];
    switch (screen) { case "overview": children = await overview(); break; case "tasks": children = await tasks(id); break; case "chat": children = await chat(); break; case "onboarding": children = await onboarding(); break; case "knowledge": children = await knowledge(id); break; case "sources": children = id ? await sourceDetail(id) : [node("p", "Source ID required")]; break; case "files": children = await knowledge(undefined, true); break; case "connections": children = await connections(); break; case "computer": children = await computer(); break; case "activity": children = await activity(); break; case "settings": children = await settings(); break; default: children = [node("p", "Page not found"), link("Overview", "#overview")]; }
    if (generation !== renderGeneration) return; content.querySelector(".loading")?.remove(); content.append(...children);
    const setup = content.querySelector<HTMLElement>("[data-setup]"); refreshSetup = setup ? setupRefreshers.get(setup) : undefined;
    const conversation = content.querySelector<HTMLElement>(".conversation"); refreshConversation = conversation ? conversationRefreshers.get(conversation) : undefined;
    const history = conversation?.querySelector<HTMLElement>("#messages"); if (history) history.scrollTop = history.scrollHeight;
    if (refreshConversation) void refreshConversation().catch(showError);
    content.focus({ preventScroll: true });
  } catch (error) { if (generation !== renderGeneration) return; content.querySelector(".loading")?.remove(); showError(error); }
}
async function poll(): Promise<void> {
  if (polling || !csrf || document.hidden) return; polling = true;
  try {
    const current = await api<Overview>("/overview"); settingsVersion = current.settings.version; if (current.settings.value.stopped !== stopped) { stopped = current.settings.value.stopped; shell(); }
    await refreshConversation?.();
    const route = location.hash.slice(1);
    if (!route || route === "onboarding" || route === "connections") await refreshSetup?.();
    if (route === "overview" && overviewFingerprint !== JSON.stringify(current) && !content.querySelector(".loading")) await render();
    const taskId = document.querySelector<HTMLElement>("[data-task-id]")?.dataset.taskId;
    if (taskId) {
      const latest = await api<{ task: Task; actions: Action[]; waits: Json[] }>(`/tasks/${encodeURIComponent(taskId)}`);
      if (taskFingerprint !== JSON.stringify(latest)) {
        if (dirtyForm || document.activeElement?.closest("form")) { notice("Task evidence changed. Your draft is preserved; refresh task evidence before saving."); delay = 2000; return; }
        if (location.hash === `#tasks/${taskId}`) await render();
      }
    }
    delay = 2000; notice(`Connected · updated ${new Date().toLocaleTimeString()}${stopped ? " · globally stopped" : ""}`);
  } catch (error) { delay = Math.min(delay * 2, 30000); connectionState.textContent = error instanceof Error ? error.message : "Data may be stale"; connectionState.className = "error"; }
  finally { polling = false; }
}
async function tick(): Promise<void> { await poll(); setTimeout(() => { void tick(); }, delay); }
content.addEventListener("input", () => { dirtyForm = true; });
window.addEventListener("hashchange", () => { void render(); });
window.addEventListener("offline", () => { connectionState.textContent = "Offline. Displayed data may be stale; admitted work continues."; connectionState.className = "error"; });
window.addEventListener("online", () => { void poll(); });
document.addEventListener("visibilitychange", () => { if (!document.hidden) void poll(); });
void (async () => { try { const session = await api<{ csrf: string }>("/session"); csrf = session.csrf; await render(); } catch { login(); } void tick(); })();
