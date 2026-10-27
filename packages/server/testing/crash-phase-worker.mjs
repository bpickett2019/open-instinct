import { StateDir, defaultConfig, saveConfig } from "@open-instinct/core";
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { McpClient, StreamableHttpTransport } from "@earendil-works/pi-mcp";
import { boot } from "../dist/boot.js";
import { BusinessCoordinator } from "../dist/business-coordinator.js";
import { join } from "node:path";

// This process owns the actual controller and SQLite connection, never the provider state.
// Only scheduling and callback boundaries are gated; registered tools, preparation,
// accounting, receipt persistence, recovery and reconciliation remain production code.
let app, options, armed = false, reservations = 0;
const nativeFetch = globalThis.fetch;
const violations = [];
const send = value => process.send(value);
const target = action => action.tool === (options.kind === "gmail" ? "business_google" : "computer") && (options.kind === "gmail" || action.arguments.action === "left_click");
function snapshot() {
  const store = app.business.coordinator.store;
  return { tasks: store.tasks(), actions: store.actions().filter(target), reservations, accounting: store.allowanceBalances(), violations };
}
function gate(phase, outcome) {
  if (!armed || options.phase !== phase) return;
  armed = false;
  // IPC writes are small and queued to the pipe before freezing. No finally/close runs.
  send({ event: "phase", phase, snapshot: snapshot(), ...(outcome ? { outcome } : {}) });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  throw new Error("A crash gate must only be exited by SIGKILL");
}
function submission(request, body) {
  return options.kind === "gmail"
    ? new URL(request.url).pathname.endsWith("/proxy_execute") && body.toolkit_slug === "gmail" && String(body.endpoint).endsWith("/messages/send")
    : body.method === "tools/call" && body.params?.name === "computer" && body.params.arguments?.action === "left_click";
}
async function isolatedFetch(input, init) {
  const request = new Request(input, init), url = new URL(request.url);
  if (!options.origins.includes(url.origin)) { violations.push(url.origin); throw new Error(`Unexpected outbound request: ${url.origin}`); }
  const body = request.method === "POST" ? await request.clone().json().catch(() => ({})) : {};
  const response = await nativeFetch(request, { redirect: "error" });
  if (submission(request, body)) gate("provider-accepted");
  return response;
}
function adapters() {
  async function request(path, method = "GET", value) {
    const response = await isolatedFetch(options.composio + path, { method, headers: { "x-api-key": "synthetic-composio-key", "content-type": "application/json" }, ...(value ? { body: JSON.stringify(value) } : {}) });
    if (!response.ok) throw new Error(`Fixture session request: ${response.status}`);
    return response.json();
  }
  function session(value) {
    const id = value.id;
    return { sessionId: id, mcp: { url: `${options.composio}/mcp/${id}` }, authorize: toolkit => request(`/fixture/sessions/${id}/authorize`, "POST", { toolkit }), toolkits: config => request(`/fixture/sessions/${id}/toolkits`, "POST", config ?? {}) };
  }
  return {
    createComposio: () => ({ sessions: { create: async (userId, config) => session(await request("/fixture/sessions", "POST", { userId, config })), use: async id => session(await request(`/fixture/sessions/${id}`)) } }),
    connectMcp: async endpoint => { const client = new McpClient({ name: "crash-fixture", version: "1" }); await client.connect(new StreamableHttpTransport({ url: endpoint.url, headers: endpoint.headers ?? {} })); return client; },
    fetchImpl: (input, init) => { const request = new Request(input, init), url = new URL(request.url); return isolatedFetch(url.origin === "https://backend.composio.dev" ? new Request(options.composio + url.pathname + url.search, request) : request); },
  };
}
const call = (name, args) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
function response() {
  const store = app.business.coordinator.store;
  const action = store.actions().find(target);
  if (action?.status === "verified") return call("task_finish", { result: "One message independently read back from Gmail.", criteriaEvidence: [{ criterion: 0, evidenceRefs: action.evidenceRefs }] });
  if (action && ["accepted", "unknown"].includes(action.status)) return call("task_wait", { kind: "reconciliation", correlationKey: "crash-browser-outcome" });
  return options.kind === "gmail"
    ? call("business_google", { operation: "send", input: { to: ["customer@fixture.test"], subject: "Crash phase quote", text: "One authorized quote, once." } })
    : call("computer", { action: "left_click", coordinate: [240, 160] });
}
async function initialize(value) {
  options = value;
  globalThis.fetch = isolatedFetch;
  const state = new StateDir(options.root); state.ensure();
  if (!options.reopen) {
    const config = defaultConfig(); config.business = { autonomy: "full" }; config.owner.name = "Synthetic Owner"; config.owner.emails = ["owner@fixture.test"]; config.owner.phones = ["+12025550101"]; config.agent.handle = "fixture-assistant"; config.apps.toolkits = ["gmail", "googlecalendar"]; config.apps.enabled = true; config.model = { primary: "faux/crash", thinking: "off" }; saveConfig(state, config);
  }
  const model = fauxProvider({ provider: "faux", models: [{ id: "crash" }] }), models = createModels(); models.setProvider(model.provider);
  // Explicit IPC sweep commands replace the periodic timer, not recovery or workers.
  BusinessCoordinator.prototype.start = function () { this.recover(); };
  app = await boot({ INSTINCT_DATA_DIR: options.root, INSTINCT_SKILLS_DIR: join(options.root, "no-skills"), COMPOSIO_API_KEY: "synthetic-composio-key", MARITIME_COMPUTER_API_KEY: "synthetic-maritime-computer", MARITIME_COMPUTERS_MCP_URL: options.maritime }, {
    model: model.getModel("crash"), streamFn: (selected, context, streamOptions) => { model.setResponses([response]); return models.streamSimple(selected, context, streamOptions); }, logger: () => {}, fetchImpl: isolatedFetch, appsAdapters: adapters(),
  });
  if (!app.business || !app.apps || app.computerKind !== "maritime") throw new Error("Real business provider boot failed");
  await app.ownerWorkspace.connections.list();
  const coordinator = app.business.coordinator, store = coordinator.store;
  const reserve = store.reserve.bind(store);
  store.reserve = action => { if (target(action)) reservations++; return reserve(action); };
  const transaction = store.transaction.bind(store);
  let depth = 0;
  store.transaction = fn => {
    depth++;
    let result;
    try { result = transaction(fn); } finally { depth--; }
    if (depth === 0 && store.actions().some(action => target(action) && action.status === "prepared")) gate("prepared");
    return result;
  };
  const dispatch = coordinator.dispatch.bind(coordinator);
  coordinator.dispatch = async (binding, action, invoke) => {
    if (!target(action)) return dispatch(binding, action, invoke);
    gate("before-preparation");
    return dispatch(binding, action, async signal => { const outcome = await invoke(signal); gate("before-commit", outcome); return outcome; });
  };
  armed = !options.reopen;
  send({ event: "ready", snapshot: snapshot() });
}
async function command(message) {
  if (message.command === "init") return initialize(message.options);
  if (message.command === "admit") {
    const coordinator = app.business.coordinator;
    const objective = options.kind === "gmail" ? "Send the authorized quote exactly once" : "Submit the prefilled hosted-browser quote form exactly once";
    const authority = coordinator.ownerAuthority({ kind: "owner", id: "owner", tier: "owner" }, "chat", "crash-owner-request", objective);
    coordinator.admitTask({ channel: "chat", conversationKey: "crash-owner", replyRef: {}, requester: "owner", audience: "owner" }, authority, { objective, doneCriteria: ["Independently verify the requested external outcome"] }, "crash-owner-request");
  }
  if (message.command === "admit" || message.command === "sweep") {
    await app.business.coordinator.sweep();
    // Wait on the actual worker condition, not a timing guess. Reconciliation sweeps
    // can start workers after their own promise resolves.
    while (app.business.coordinator.store.tasks().some(task => task.status === "running")) {
      const tick = Promise.withResolvers(); setImmediate(tick.resolve); await tick.promise;
    }
  }
  if (message.command === "close") { await app.close(); send({ event: "closed" }); process.disconnect(); return; }
  send({ event: "result", id: message.id, snapshot: snapshot() });
}
process.on("message", message => { void command(message).catch(error => { send({ event: "error", message: error.stack ?? String(error) }); }); });
