import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createModels, fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { ApprovalStore, AuditLog, BusinessStore, MemoryStore, Scheduler, StateDir, ToolRegistry, coreTools, defaultConfig, type ToolContext } from "@open-instinct/core";
import { BusinessCoordinator } from "../src/business-coordinator.js";
import { businessUsageStream } from "../src/business-usage.js";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
const owner = { kind: "owner", id: "owner", tier: "owner" } as const;
async function fixture(limit: number | null) {
  const root = mkdtempSync(join(tmpdir(), "image-accounting-")), state = new StateDir(root); state.ensure();
  const workspace = join(root, "workspace");
  const store = new BusinessStore(join(root, "business")), coordinator = new BusinessCoordinator(store);
  cleanup.push(async () => { await coordinator.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const settings = store.settings(); store.updateSettings(settings.version, { ...settings.value, limits: { ...settings.value.limits, modelMinor: limit } });
  const authority = coordinator.ownerAuthority(owner, "chat", "image-request", "Create a synthetic image within my allowance");
  const task = coordinator.admitTask({ channel: "chat", conversationKey: "chat:owner", replyRef: {}, requester: "owner", audience: "owner" }, authority, { objective: "Create image", doneCriteria: ["Saved image"] }, "image-request");
  const binding = coordinator.claimRun(task.id)!;
  const faux = fauxProvider({ provider: "faux-priced", models: [{ id: "priced" }] }), models = createModels(); models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage("Known-priced conversational reasoning precedes image dispatch.")]);
  const model = { ...faux.getModel("priced")!, cost: { input: 0.01, output: 0.01, cacheRead: 0.01, cacheWrite: 0.01 } };
  await businessUsageStream(coordinator, binding, models.streamSimple.bind(models))(model, { messages: [] });
  expect(store.settings().value.usage.modelPriceUnknown).toBe(false);
  let requests = 0;
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4l8AAAAASUVORK5CYII=", "base64");
  const registry = new ToolRegistry();
  registry.registerMany(coreTools({ memory: new MemoryStore(state), scheduler: new Scheduler(state), approvals: new ApprovalStore(state), audit: new AuditLog(state), config: defaultConfig(), outbox: { send: async () => { throw new Error("Unexpected carrier effect"); } }, workspaceDir: workspace, images: { apiKey: "synthetic-image-key", baseUrl: "https://images.fixture.test/v1" }, fetchImpl: async input => {
    expect(String(input)).toBe("https://images.fixture.test/v1/images/generations"); requests++; return Response.json({ data: [{ b64_json: bytes.toString("base64") }] });
  } }));
  const ctx: ToolContext = { principal: owner, channel: "chat", conversationKey: "system:business:" + task.id, now: () => new Date(), taskRun: binding, businessDispatch: coordinator, nextBusinessStep: id => id };
  const image = registry.bind(ctx).find(tool => tool.name === "image_generate")!;
  return { store, root, bytes, requests: () => requests, run: () => image.execute("image-step", { path: "image.png", prompt: "Synthetic one-pixel fixture" }, new AbortController().signal) };
}
it("refuses an unpriced image endpoint under a configured model cap after a priced conversational turn", async () => {
  const f = await fixture(10_000); await expect(f.run()).rejects.toThrow(/price unavailable/);
  expect(f.requests()).toBe(0); expect(f.store.actions().filter(action => action.tool === "image_generate")).toEqual([]);
  expect(f.store.allowanceBalances().model.unknown).toBe(false);
});
it("records unknown image cost before uncapped provider dispatch rather than showing free known usage", async () => {
  const f = await fixture(null); await f.run();
  expect(f.requests()).toBe(1); expect(readFileSync(join(f.root, "workspace/image.png"))).toEqual(f.bytes);
  expect(f.store.allowanceBalances().model).toMatchObject({ unknown: true, remainingMinor: null });
  expect(f.store.actions().find(action => action.tool === "image_generate")).toMatchObject({ status: "verified", unpricedModel: true });
});
