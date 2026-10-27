import { mkdtempSync, rmSync, mkdirSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { fauxProvider } from "@earendil-works/pi-ai";
import { BusinessStore, StateDir, defaultConfig, saveConfig } from "@open-instinct/core";
import { boot } from "../src/boot.js";
import { BusinessCoordinator } from "../src/business-coordinator.js";
import { BusinessService } from "../src/business-service.js";
import { BusinessKnowledge } from "../src/business-knowledge.js";
import { BusinessOutbox } from "../src/business-outbox.js";
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const owner = { kind: "owner", id: "owner", tier: "owner" } as const;
function root() { const path = mkdtempSync(join(tmpdir(), "business-acceptance-")); cleanup.push(() => rmSync(path, { recursive: true, force: true })); return path; }
function fixture() {
  const directory = join(root(), "private"), store = new BusinessStore(directory), coordinator = new BusinessCoordinator(store);
  cleanup.push(async () => { await coordinator.close(); store.close(); });
  const authority = coordinator.ownerAuthority(owner, "chat", "source", "Resolve separate owner facts");
  const task = coordinator.admitTask({ channel: "chat", conversationKey: "chat:owner", replyRef: {}, requester: "owner", audience: "owner" }, authority, { objective: "Resolve separate owner facts", doneCriteria: ["Both facts resolved"] }, "request");
  return { directory, store, coordinator, authority, task };
}
it.each(["workspace", "descendant", "ancestor", "symlink"])("rejects %s private state overlap before exposing a controller database", async placement => {
  const directory = root(), state = new StateDir(directory); state.ensure();
  const workspace = state.path("workspace");
  const target = placement === "ancestor" ? directory : placement === "workspace" ? workspace : join(workspace, "private-business");
  let configured = target;
  if (placement === "symlink") { mkdirSync(target); configured = join(directory, "private-alias"); symlinkSync(target, configured, "dir"); }
  const config = defaultConfig(); config.business = { autonomy: "full", stateDirectory: configured }; config.apps.enabled = false; saveConfig(state, config);
  const faux = fauxProvider({ provider: "faux", models: [{ id: "boundary" }] });
  const attempt = boot({ INSTINCT_DATA_DIR: directory, INSTINCT_SKILLS_DIR: join(directory, "no-skills") }, { model: faux.getModel("boundary"), logger: () => {} }).then(app => { cleanup.push(() => app.close()); return app; });
  await expect(attempt).rejects.toThrow();
  expect(existsSync(join(target, "business.sqlite"))).toBe(false);
});
it("boots a nonoverlapping sibling even when its name shares the workspace prefix", async () => {
  const directory = root(), state = new StateDir(directory); state.ensure();
  const config = defaultConfig(); config.business = { autonomy: "full", stateDirectory: join(directory, "workspace-private") }; config.apps.enabled = false; saveConfig(state, config);
  const faux = fauxProvider({ provider: "faux", models: [{ id: "boundary" }] });
  const app = await boot({ INSTINCT_DATA_DIR: directory, INSTINCT_SKILLS_DIR: join(directory, "no-skills") }, { model: faux.getModel("boundary"), logger: () => {} });
  cleanup.push(() => app.close());
  expect(app.business!.coordinator.store.settings().value.autonomy).toBe("full");
  expect(existsSync(join(directory, "workspace-private", "business.sqlite"))).toBe(true);
});
it("consumes each owner answer once across successive waits while preserving event-before-wait", async () => {
  const { store, coordinator, task } = fixture();
  const correlationKey = `owner-reply:${task.id}`;
  coordinator.appendEvent({ id: "answer-one", channel: "chat", correlationKey, kind: "owner.reply", content: { text: "First fact" }, at: store.now(), verified: true });
  const first = coordinator.wait(coordinator.claimRun(task.id)!, { kind: "missing_information", correlationKey, eventCursor: 0, deadline: null, requiresVerification: false });
  expect(first).toMatchObject({ status: "satisfied", satisfiedBy: "answer-one" });
  const second = coordinator.wait(coordinator.claimRun(task.id)!, { kind: "missing_information", correlationKey, eventCursor: 0, deadline: null, requiresVerification: false });
  expect(second).toMatchObject({ status: "waiting", satisfiedBy: null });
  coordinator.appendEvent({ id: "answer-two", channel: "chat", correlationKey, kind: "owner.reply", content: { text: "Second fact" }, at: store.now(), verified: true });
  expect(store.waits(task.id).find(wait => wait.id === second.id)).toMatchObject({ status: "satisfied", satisfiedBy: "answer-two" });
});
it("removes deleted profile facts from active foreground and worker context while retaining history", async () => {
  const { store, coordinator, authority } = fixture(), knowledge = new BusinessKnowledge(store); cleanup.push(() => knowledge.close());
  const service = new BusinessService(coordinator, { send: async () => {} });
  const profile = knowledge.profiles.save({ expectedVersion: 0, facts: [{ key: "services", value: "Retired synthetic service with private rate 9127", scope: "business" }] }, authority);
  expect(service.context()).toContain("9127");
  const sourceId = profile.facts[0]!.citation.sourceId, source = knowledge.source(sourceId);
  knowledge.deleteSource(sourceId, source.version);
  expect(JSON.stringify(store.get("profile", "current")!.value)).toContain("9127");
  expect(service.context("foreground")).not.toContain("9127"); expect(service.context("worker")).not.toContain("9127");
});
it("recovers interrupted notification attempts as unknown without carrier replay", async () => {
  const { store, coordinator } = fixture(); let sends = 0;
  store.put("notification", "notice", { id: "notice", text: "Synthetic notice", channel: "imessage", thread: "imessage:test", taskId: null, status: "dispatching", at: store.now() }, null);
  coordinator.recover();
  expect(store.get<{ status: string }>("notification", "notice")!.value.status).toBe("unknown");
  const service = new BusinessService(coordinator, { send: async () => { sends++; } });
  await service.notify("notice", "Synthetic notice", { channel: "imessage", conversationKey: "imessage:test", replyRef: {} }, owner);
  expect(sends).toBe(0);
});
it("deduplicates fallback transport by logical message identity but permits a new owner occurrence", async () => {
  const { store } = fixture(); const sent: string[] = [];
  const outbox = new BusinessOutbox(store, { send: async message => { sent.push(message.text); } });
  const message = { channel: "imessage", conversationKey: "imessage:test", text: "Synthetic answer" } as const;
  const context = { principal: owner, conversationKey: "imessage:test", messageId: "reply:inbound-one" };
  await outbox.send(message, context); await outbox.send(message, context);
  expect(sent).toEqual(["Synthetic answer"]);
  await outbox.send(message, { ...context, messageId: "reply:inbound-two" });
  expect(sent).toEqual(["Synthetic answer", "Synthetic answer"]);
});
