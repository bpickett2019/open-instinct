import { afterEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import { createScenarioApp, type ScenarioApp } from "../../testing/scenario-app.js";
import { toolCall as call } from "../../testing/document-lifecycle.js";
import type { OnboardingSnapshot } from "../../src/business-onboarding.js";
import { DatabaseSync } from "node:sqlite";
import { copyFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const instances: ScenarioApp[] = [];
afterEach(async () => { for (const scenario of instances.splice(0).reverse()) await scenario.close(); });
async function scenario() {
  const app = await createScenarioApp({ responses: [], foregroundResponses: [], now: () => new Date("2026-10-24T09:00:00Z") });
  instances.push(app);
  return app;
}
function textEvent(id: string, content: string) {
  return { id: `event-${id}`, event_type: "imessage.received", timestamp: "2026-10-24T09:00:00Z", data: { message: { id, conversation_id: "conversation-onboarding", remote_number: "+12025550101", content, is_group: false, participants: ["+12025550101"], media: [] }, contacts: [], agent_identities: [] } };
}
async function snapshot(s: ScenarioApp): Promise<OnboardingSnapshot> {
  const response = await s.owner("/onboarding");
  expect(response.status).toBe(200);
  return await response.json() as OnboardingSnapshot;
}
function expectNoAutomaticWork(s: ScenarioApp) {
  const store = s.app.business!.coordinator.store;
  expect(store.tasks()).toEqual([]);
  expect(store.list<{ enabled: boolean }>("routine").filter(row => row.value.enabled)).toEqual([]);
  expect(store.list("commitment")).toEqual([]);
  expect(s.providers.composio.invocations).toEqual([]);
  expect(s.providers.composio.proxyRequests.filter(request => /\/(?:messages|history|events)(?:\/|$)/.test(new URL(String(request.endpoint)).pathname))).toEqual([]);
  expect(s.providers.google.accepted).toEqual([]);
  expect(s.providers.calendar.events.size).toBe(0);
  expect(s.providers.maritime.invocations).toEqual([]);
}

// Script model choices, never service results: carrier acceptance, saved facts and
// OAuth identity are read back from the production application and stateful providers.
describe.sequential("assistant-led onboarding (emulated)", () => {
  it("opens once across concurrent calls and refresh, restores owner tools for natural replies, and retains shared history and facts across restart", async () => {
    const s = await scenario();
    await s.login();
    const gate = s.gate();
    let openingTurns = 0;
    let openingTools: string[] | undefined;
    const greeting = "Tell me about the business you want help with.";
    s.foregroundModel.setResponses([async transcript => {
      openingTurns++;
      openingTools = getCurrentTools(transcript.messages).map(tool => tool.name);
      await gate.promise;
      return fauxAssistantMessage(greeting);
    }]);
    const open = () => s.owner("/onboarding/conversation", { method: "POST", body: {} });
    const responses = await Promise.all([open(), open(), open()]);
    for (const response of responses) {
      expect(response.status).toBe(202);
      expect(await response.json()).toMatchObject({ accepted: true });
    }
    await s.waitFor(() => openingTurns === 1, "single guidance turn entered");
    expect(openingTools).toEqual([]);
    const store = s.app.business!.coordinator.store;
    expect(store.messages()).toEqual([expect.objectContaining({ id: "workspace-onboarding", role: "notice", channel: "chat", thread: "chat:business-owner" })]);
    expect(store.get("cursor", "inbound:workspace-onboarding")?.value).toMatchObject({ status: "processing" });
    expect(store.list("notification")).toEqual([]);
    expect((await snapshot(s)).profile).toMatchObject({ version: 0, facts: [] });
    expectNoAutomaticWork(s);
    gate.release();
    await s.waitFor(() => store.get<{ status: string }>("cursor", "inbound:workspace-onboarding")?.value.status === "answered", "durable guidance answer");
    expect(store.messages().map(message => message.role)).toEqual(["notice", "assistant"]);
    const initialHistory = await (await s.owner("/messages")).json();
    s.foregroundModel.setResponses([fauxAssistantMessage("Unexpected regenerated opening")]);
    expect(await (await open()).json()).toMatchObject({ accepted: true, reply: greeting });
    expect(await (await s.owner("/messages")).json()).toEqual(initialHistory);
    expect(openingTurns).toBe(1);
    expect(s.foregroundModel.getPendingResponseCount()).toBe(1);

    const sentence = "Cedar Plumbing provides leak repairs in Portland.";
    const facts = [{ key: "businessName", scope: "business", value: "Cedar Plumbing" }, { key: "services", scope: "business", value: "leak repairs" }, { key: "serviceArea", scope: "business", value: "Portland" }];
    let ownerTools: string[] = [];
    let sameConversation = false;
    s.foregroundModel.setResponses([transcript => {
      ownerTools = getCurrentTools(transcript.messages).map(tool => tool.name);
      sameConversation = transcript.messages.some(message => message.role === "assistant" && message.content.some(block => block.type === "text" && block.text === greeting));
      const latest = transcript.messages.findLast(message => message.role === "user");
      expect(latest?.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: "text", text: sentence })]));
      return call("business_profile_save", { expectedVersion: 0, facts });
    }, fauxAssistantMessage("Which timezone should I use for your business?")]);
    expect((await s.postMessage(sentence, "natural-owner-facts")).status).toBe(202);
    await s.waitFor(() => s.app.business!.coordinator.store.get<{ status: string }>("cursor", "inbound:web:natural-owner-facts")?.value.status === "answered", "natural owner reply persisted");
    expect(sameConversation).toBe(true);
    expect(ownerTools).toEqual(expect.arrayContaining(["business_profile_save", "business_delegate", "apps_connect"]));
    const before = await snapshot(s);
    expect(before.profile).toMatchObject({ version: 1, facts: expect.arrayContaining(facts.map(fact => expect.objectContaining(fact))) });
    expect(before.profile.facts).toHaveLength(3);
    for (const fact of before.profile.facts) {
      expect(s.app.business!.coordinator.store.get("knowledge", fact.citation.sourceId)?.value).toMatchObject({ source: "owner", sourceLocator: "owner:web:natural-owner-facts", authority: "owner" });
    }
    expect(before.nextQuestion?.key).toBe("timezone");
    const savedHistory = await (await s.owner("/messages")).json();
    expect(s.app.business!.coordinator.store.messages().filter(message => message.role === "owner")).toEqual([expect.objectContaining({ id: "web:natural-owner-facts", text: sentence })]);
    const notifications = s.app.business!.coordinator.store.list("notification");
    s.foregroundModel.setResponses([fauxAssistantMessage("Unexpected regenerated opening after restart")]);
    await s.restart();
    await s.login();
    await Promise.all([open(), open(), s.owner("/onboarding")]);
    await s.app.business!.coordinator.sweep();
    expect((await snapshot(s)).profile).toEqual(before.profile);
    expect(await (await s.owner("/messages")).json()).toEqual(savedHistory);
    expect(s.app.business!.coordinator.store.list("notification")).toEqual(notifications);
    expect(openingTurns).toBe(1);
    expect(s.foregroundModel.getPendingResponseCount()).toBe(1);
    expect(s.providers.inkbox.attempts).toEqual([]);
    expectNoAutomaticWork(s);
  }, 30000);

  it("rejects model-invented owner tools during the read-only welcome without changing business state", async () => {
    const s = await scenario();
    await s.login();
    expect((await s.webhook(textEvent("prior-carrier-route", "business status"))).status).toBe(204);
    await s.waitFor(() => s.providers.inkbox.accepted.length === 1, "prior authorized carrier reply");
    s.foregroundModel.setResponses([fauxAssistantMessage("I can help with your business.")]);
    await s.postMessage("What can you help with?", "prior-owner-turn");
    await s.waitFor(() => s.app.business!.coordinator.store.get<{ status: string }>("cursor", "inbound:web:prior-owner-turn")?.value.status === "answered", "ordinary owner turn settled");
    const priorCarrierAttempts = structuredClone(s.providers.inkbox.attempts);
    const store = s.app.business!.coordinator.store;
    const settings = store.settings();
    const accounts = structuredClone([...s.providers.composio.accounts.values()]);
    const attempts = [
      { name: "business_delegate", args: { objective: "Contact customers", doneCriteria: ["Send a message"] } },
      { name: "business_profile_save", args: { expectedVersion: 0, facts: [{ key: "businessName", scope: "business", value: "Invented Business" }] } },
      { name: "apps_connect", args: { toolkit: "gmail" } },
      { name: "business_control", args: { target: "workspace", operation: "pause", expectedVersion: settings.version } },
      { name: "business_google", args: { operation: "send", input: { to: ["customer@fixture.test"], subject: "Unrequested", text: "Must not send" } } },
    ];
    let denied: string[] = [];
    let advertised: string[] | undefined;
    s.foregroundModel.setResponses([transcript => {
      advertised = getCurrentTools(transcript.messages).map(tool => tool.name);
      return fauxAssistantMessage(attempts.map(attempt => fauxToolCall(attempt.name, attempt.args)), { stopReason: "toolUse" });
    }, transcript => {
      denied = transcript.messages.filter(message => message.role === "toolResult" && message.isError).map(message => message.role === "toolResult" ? message.toolName : "");
      return fauxAssistantMessage("What business are we setting up?");
    }]);
    expect((await s.owner("/onboarding/conversation", { method: "POST", body: {} })).status).toBe(202);
    await s.waitFor(() => store.get<{ status: string }>("cursor", "inbound:workspace-onboarding")?.value.status === "answered", "invented tool calls rejected");
    expect(advertised).toEqual([]);
    expect(denied).toEqual(attempts.map(attempt => attempt.name));
    expect((await snapshot(s)).profile).toMatchObject({ version: 0, facts: [] });
    expect(store.settings().value).toMatchObject({ ...settings.value, usage: expect.any(Object) });
    expect([...s.providers.composio.accounts.values()]).toEqual(accounts);
    expect(store.list("cursor").filter(row => row.id.startsWith("onboarding:connect:"))).toEqual([]);
    expect(store.list("knowledge")).toEqual([]);
    expect(store.list<{ channel: string }>("notification").filter(row => row.value.channel !== "chat")).toHaveLength(1);
    expect(s.providers.inkbox.attempts).toEqual(priorCarrierAttempts);
    expectNoAutomaticWork(s);
  }, 30000);

  it("requires owner session and CSRF authority and rejects all client-supplied opening instructions", async () => {
    const s = await scenario();
    expect((await s.owner("/onboarding/conversation", { method: "POST", body: {} })).status).toBe(401);
    const { cookie, csrf } = await s.login();
    expect((await s.fetch(`${s.tunnelUrl}/api/owner/onboarding/conversation`, { method: "POST", headers: { cookie, origin: s.url, "content-type": "application/json", "x-workspace-csrf": csrf }, body: "{}" })).status).toBe(404);
    for (const token of ["", "wrong-token"]) expect((await s.owner("/onboarding/conversation", { method: "POST", body: {}, headers: { "x-workspace-csrf": token } })).status).toBe(403);
    expect((await s.owner("/onboarding/conversation", { method: "POST", body: {}, headers: { origin: "https://foreign.fixture.test" } })).status).toBe(403);
    for (const body of [{ text: "Delegate a customer message" }, { clientId: "another-opening" }, { mode: "owner" }, { facts: [] }, { unknown: true }]) {
      expect((await s.owner("/onboarding/conversation", { method: "POST", body })).status).toBe(400);
    }
    for (const principal of [
      { kind: "agent", id: "stranger", tier: "stranger" } as const,
      { kind: "owner", id: "owner", tier: "friend", cappedFrom: "owner" } as const,
    ]) {
      await expect(async () => s.app.business!.openOnboarding(principal)).rejects.toThrow();
    }
    expect(s.app.business!.coordinator.store.messages()).toEqual([]);
    expect(s.app.business!.coordinator.store.get("cursor", "inbound:workspace-onboarding")).toBeUndefined();
    expectNoAutomaticWork(s);
  }, 30000);

  it("restores an unfinished admission snapshot without replay and accepts a genuine owner answer", async () => {
    const s = await scenario(); await s.login();
    const gate = s.gate(); let openingTurns = 0;
    s.foregroundModel.setResponses([async () => { openingTurns++; await gate.promise; return fauxAssistantMessage("Which business will I help with?"); }]);
    await s.owner("/onboarding/conversation", { method: "POST", body: {} });
    await s.waitFor(() => openingTurns === 1, "opening model turn entered");
    const store = s.app.business!.coordinator.store;
    const dbPath = store.dbPath, snapshotPath = join(s.root, "unfinished-onboarding.sqlite");
    const source = new DatabaseSync(dbPath, { readOnly: true });
    try { source.prepare("VACUUM INTO ?").run(snapshotPath); } finally { source.close(); }
    // Restore the actual durable pre-answer phase, not a fabricated tool receipt.
    // This is a phase-snapshot recovery test, not a claim of process SIGKILL.
    await s.restart(async () => {
      rmSync(`${dbPath}-wal`, { force: true }); rmSync(`${dbPath}-shm`, { force: true });
      copyFileSync(snapshotPath, dbPath);
    });
    await s.login();
    expect(s.app.business!.coordinator.store.get<{ status: string }>("cursor", "inbound:workspace-onboarding")?.value.status).toBe("interrupted");
    s.foregroundModel.setResponses([fauxAssistantMessage("Unexpected opening replay")]);
    const reopened = await s.owner("/onboarding/conversation", { method: "POST", body: {} });
    expect((await reopened.json() as { reply: string }).reply).toContain("interrupted");
    expect(openingTurns).toBe(1);
    expect(s.foregroundModel.getPendingResponseCount()).toBe(1);
    expect(s.app.business!.coordinator.store.message("answer:workspace-onboarding")).toBeUndefined();
    s.foregroundModel.setResponses([call("business_profile_save", { expectedVersion: 0, facts: [{ key: "businessName", scope: "business", value: "Cedar Plumbing" }] }), fauxAssistantMessage("What would you like help with at Cedar Plumbing?")]);
    await s.postMessage("The business is Cedar Plumbing.", "owner-after-interruption");
    await s.waitFor(() => s.app.business!.coordinator.store.get<{ status: string }>("cursor", "inbound:web:owner-after-interruption")?.value.status === "answered", "owner answer after interruption");
    expect((await snapshot(s)).profile.facts).toEqual([expect.objectContaining({ key: "businessName", value: "Cedar Plumbing" })]);
    expect(s.providers.inkbox.attempts).toEqual([]);
    expectNoAutomaticWork(s);
  }, 30000);

  it.each(["pause", "stop"] as const)("keeps workspace %s intact when setup opens and after a real restart", async operation => {
    const s = await scenario();
    await s.login();
    expect((await (operation === "pause"
      ? s.owner("/control", { method: "POST", body: { target: "workspace", operation } })
      : s.postMessage("stop", "stop-before-onboarding"))).status).toBe(operation === "pause" ? 200 : 202);
    const settings = s.app.business!.coordinator.store.settings();
    expect(settings.value.stopped).toBe(true);
    expect((await s.owner("/onboarding/conversation", { method: "POST", body: {} })).status).toBe(202);
    await s.waitFor(() => s.app.business!.coordinator.store.get<{ status: string }>("cursor", "inbound:workspace-onboarding")?.value.status === "answered", "stopped workspace guidance settled");
    expect(s.app.business!.coordinator.store.settings().value).toMatchObject({ ...settings.value, usage: expect.any(Object) });
    expectNoAutomaticWork(s);
    await s.restart();
    await s.login();
    const messages = s.app.business!.coordinator.store.messages();
    expect((await s.owner("/onboarding/conversation", { method: "POST", body: {} })).status).toBe(202);
    expect(s.app.business!.coordinator.store.settings().value).toMatchObject({ ...settings.value, usage: expect.any(Object) });
    expect(s.app.business!.coordinator.store.messages()).toEqual(messages);
    expectNoAutomaticWork(s);
  }, 30000);

  it("sends only the final greeting, deduplicates ingress and retains text-saved facts across restart", async () => {
    const s = await scenario();
    const gate = s.gate();
    let greetingTurns = 0;
    const greeting = "Hello, I'm your business assistant. What business are we setting up?";
    s.foregroundModel.setResponses([async () => { greetingTurns++; await gate.promise; return fauxAssistantMessage(greeting); }]);
    const hello = textEvent("onboarding-hello", "Hi");
    expect((await s.webhook(hello)).status).toBe(204);
    await s.waitFor(() => greetingTurns === 1, "foreground greeting entered");
    expect((await s.webhook(hello)).status).toBe(204);
    expect(s.providers.inkbox.attempts).toEqual([]);
    expect(s.app.business!.coordinator.store.messages().filter(message => message.role === "assistant")).toEqual([]);
    expect(s.app.business!.coordinator.store.list("notification")).toEqual([]);
    gate.release();
    await s.waitFor(() => s.providers.inkbox.accepted.length === 1 && s.app.runtime.stats().busy === 0, "single final greeting accepted");
    expect(s.providers.inkbox.attempts.map(attempt => attempt.body.text)).toEqual([greeting]);
    expect((await s.webhook(hello)).status).toBe(204);
    expect(greetingTurns).toBe(1);
    expect(s.providers.inkbox.attempts).toHaveLength(1);

    const facts = [{ key: "businessName", scope: "business", value: "Cedar Plumbing" }, { key: "services", scope: "business", value: "leak repairs" }, { key: "serviceArea", scope: "business", value: "Portland" }];
    const question = "Which timezone should I use for Cedar Plumbing?";
    s.foregroundModel.setResponses([call("business_profile_save", { expectedVersion: 0, facts }), fauxAssistantMessage(question)]);
    const details = textEvent("onboarding-facts", "My business is Cedar Plumbing. We do leak repairs in Portland.");
    expect((await s.webhook(details)).status).toBe(204);
    await s.waitFor(() => s.providers.inkbox.accepted.length === 2 && s.app.runtime.stats().busy === 0, "saved facts and next question accepted");
    await s.login();
    const before = await snapshot(s);
    expect(before.profile.version).toBe(1);
    expect(before.profile.facts).toHaveLength(3);
    expect(before.profile.facts).toEqual(expect.arrayContaining(facts.map(fact => expect.objectContaining(fact))));
    expect(before.nextQuestion?.key).toBe("timezone");
    expect(s.providers.inkbox.attempts.map(attempt => attempt.body.text)).toEqual([greeting, question]);
    expectNoAutomaticWork(s);

    await s.restart();
    await s.login();
    expect((await snapshot(s)).profile).toEqual(before.profile);
    expect((await s.webhook(details)).status).toBe(204);
    expect((await s.webhook(hello)).status).toBe(204);
    await s.app.business!.coordinator.sweep();
    expect(s.providers.inkbox.attempts.map(attempt => attempt.body.text)).toEqual([greeting, question]);
    expect(s.app.business!.coordinator.store.messages().filter(message => message.role === "assistant").map(message => message.text)).toEqual([greeting, question]);
    expectNoAutomaticWork(s);
  }, 30000);

  it("keeps OAuth waiting after owner done and restart, then sends one independently verified confirmation", async () => {
    const s = await scenario();
    await s.login();
    const account = [...s.providers.composio.accounts.values()].find(account => account.toolkit.slug === "gmail")!;
    expect(account).toBeDefined();
    s.providers.composio.revoke(account.id);
    expect((await snapshot(s)).apps.find(app => app.toolkit === "gmail")).toMatchObject({ status: "available", identity: null });
    s.providers.composio.reconnect(account.id);
    expect((await snapshot(s)).apps.find(app => app.toolkit === "gmail")).toMatchObject({ status: "available", identity: null });
    expect(s.app.business!.coordinator.store.get<{ status: string }>("connection", account.id)!.value.status).toBe("disabled");
    s.providers.composio.revoke(account.id);
    const connect = await s.owner("/connections", { method: "POST", body: { toolkit: "gmail" } });
    expect(connect.status).toBe(200);
    expect(await connect.json()).toMatchObject({ status: "waiting", url: `${s.providers.composio.url}/oauth/gmail` });
    expect((await snapshot(s)).apps.find(app => app.toolkit === "gmail")).toMatchObject({ status: "waiting", identity: null });
    s.foregroundModel.setResponses([call("business_onboarding", {}), fauxAssistantMessage("The account is still waiting for sign-in verification. We can keep setting up your business.")]);
    expect((await s.webhook(textEvent("oauth-owner-done", "done"))).status).toBe(204);
    await s.waitFor(() => s.providers.inkbox.accepted.length === 1 && s.app.runtime.stats().busy === 0, "pending OAuth owner reply");
    await s.app.business!.coordinator.sweep();
    expect((await snapshot(s)).apps.find(app => app.toolkit === "gmail")).toMatchObject({ status: "waiting", identity: null });
    expect(s.app.business!.coordinator.store.messages().filter(message => message.id.startsWith("onboarding-connected:"))).toEqual([]);
    expectNoAutomaticWork(s);

    await s.restart();
    await s.login();
    expect((await snapshot(s)).apps.find(app => app.toolkit === "gmail")).toMatchObject({ status: "waiting", identity: null });
    expect(s.providers.inkbox.attempts).toHaveLength(1);
    // OAuth reactivates the same provider account; swapping account IDs would hide
    // failures to refresh a previously disabled local connection.
    s.providers.composio.reconnect(account.id);
    await s.app.business!.coordinator.sweep();
    await s.waitFor(() => s.providers.inkbox.accepted.length === 2, "verified Gmail confirmation accepted");
    expect((await snapshot(s)).apps.find(app => app.toolkit === "gmail")).toMatchObject({ status: "connected", identity: "owner@fixture.test" });
    expect(s.providers.inkbox.attempts[1]!.body.text).toContain("Gmail is connected as owner@fixture.test");
    expect(s.app.business!.coordinator.store.messages().filter(message => message.id.startsWith("onboarding-connected:"))).toHaveLength(1);
    await Promise.all([s.app.business!.coordinator.sweep(), s.app.business!.coordinator.sweep()]);
    await s.restart();
    await s.app.business!.coordinator.sweep();
    expect(s.providers.inkbox.attempts).toHaveLength(2);
    expect(s.app.business!.coordinator.store.messages().filter(message => message.id.startsWith("onboarding-connected:"))).toHaveLength(1);
    expectNoAutomaticWork(s);
  }, 30000);

  it("exposes readiness only through authenticated owner routes, not the webhook tunnel or CSRF-less mutations", async () => {
    const s = await scenario();
    expect((await s.owner("/onboarding")).status).toBe(401);
    const { cookie } = await s.login();
    const initial = await snapshot(s);
    expect(initial).toMatchObject({ canContinue: true, computer: { status: "ready" }, profile: { version: 0, facts: [] }, nextQuestion: { key: "businessName" } });
    expect(initial.apps).toEqual(expect.arrayContaining([expect.objectContaining({ toolkit: "gmail", status: "connected", identity: "owner@fixture.test" }), expect.objectContaining({ toolkit: "googlecalendar", status: "connected", identity: "owner@fixture.test" })]));
    expect((await s.fetch(`${s.tunnelUrl}/api/owner/onboarding`, { headers: { cookie } })).status).toBe(404);
    expect((await s.owner("/connections", { method: "POST", body: { toolkit: "gmail" }, headers: { "x-workspace-csrf": "" } })).status).toBe(403);
    expect(s.app.business!.coordinator.store.list("cursor").filter(row => row.id.startsWith("onboarding:connect:"))).toEqual([]);
    expectNoAutomaticWork(s);
  }, 30000);
});
