import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { apiKeyFor, boot, type BootResult } from "../src/boot.js";
import { BusinessStore } from "@open-instinct/core";
import { BusinessCoordinator } from "../src/business-coordinator.js";
import { businessUsageStream } from "../src/business-usage.js";

const roots: string[] = [];
const apps: BootResult[] = [];
const network = vi.fn(async () => { throw new Error("Unexpected network request in subscription boundary test"); });
beforeEach(() => {
  network.mockClear();
  vi.stubGlobal("fetch", network);
});
afterEach(async () => {
  try {
    for (const app of apps.splice(0)) await app.close();
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  }
});

async function serve(provider: "openai-codex" | "openai") {
  const root = mkdtempSync(join(tmpdir(), "instinct-subscription-boundary-"));
  roots.push(root);
  const model = getBuiltinModels(provider)[0]!;
  const env: NodeJS.ProcessEnv = {
    INSTINCT_DATA_DIR: root,
    INSTINCT_OWNER_NAME: "Synthetic subscription owner",
    INSTINCT_OWNER_PHONE: "+15555550123",
    INSTINCT_MODEL: `${provider}/${model.id}`,
    INSTINCT_COMPUTER: "none",
    INSTINCT_SKILLS_DIR: join(root, "no-skills"),
    OPENAI_API_KEY: "synthetic-personal-openai-api-key",
    OPENAI_CODEX_API_KEY: "synthetic-codex-environment-api-key",
  };
  // Both the handed-in env and ambient env are populated to expose either fallback.
  vi.stubEnv("OPENAI_API_KEY", env.OPENAI_API_KEY!);
  vi.stubEnv("OPENAI_CODEX_API_KEY", env.OPENAI_CODEX_API_KEY!);
  const faux = createFauxCore({ provider, api: model.api, models: [{ id: model.id }] });
  faux.setResponses([fauxAssistantMessage("Synthetic provider completed the request.")]);
  const stream = vi.fn(faux.streamSimple as unknown as StreamFn);
  const logs: string[] = [];
  // Do not override model: boot must resolve the selected provider from configuration.
  const app = await boot(env, { streamFn: stream, logger: message => logs.push(message) });
  apps.push(app);
  const request = () => app.runtime.handleInbound({
    id: "subscription-owner-request",
    channel: "chat",
    from: "owner",
    conversationKey: "chat:subscription-owner",
    text: "Summarize the appointment options.",
    replyRef: {},
    receivedAt: new Date().toISOString(),
  }, { waitForCompletion: true });
  return { app, env, root, stream, logs, request };
}

describe("subscription-only server authentication", () => {
  it("never maps Codex subscription requests to environment API keys while preserving personal OpenAI", () => {
    const env = { OPENAI_API_KEY: " synthetic-personal-api-key ", OPENAI_CODEX_API_KEY: "synthetic-codex-api-key" };
    expect(apiKeyFor("openai-codex", env)).toBeUndefined();
    expect(apiKeyFor("openai", env)).toBe("synthetic-personal-api-key");
    expect(apiKeyFor("openai-compatible", env)).toBe("synthetic-personal-api-key");
    expect(apiKeyFor("openai-codex", { OPENAI_CODEX_API_KEY: env.OPENAI_CODEX_API_KEY })).toBeUndefined();
    expect(apiKeyFor("openai-codex", { OPENAI_API_KEY: env.OPENAI_API_KEY })).toBeUndefined();
  });

  it("blocks a real runtime request before the injected model stream when private Codex auth is missing", async () => {
    const s = await serve("openai-codex");
    expect(s.app.modelSpec).toBe(s.env.INSTINCT_MODEL);
    const result = await s.request();
    expect(result.principal.kind).toBe("owner");
    expect(result.reply).toBeTruthy();
    expect(result.reply).not.toBe("Synthetic provider completed the request.");
    expect(s.stream).not.toHaveBeenCalled();
    const conversation = s.app.runtime.conversation("chat:subscription-owner", s.app.runtime.ownerPrincipal());
    expect(conversation.agent.state.messages.some(message => message.role === "assistant" && message.stopReason === "error")).toBe(true);
    const audit = readFileSync(join(s.root, "audit.jsonl"), "utf8");
    expect(audit.split("\n").filter(Boolean).map(line => JSON.parse(line)).some(entry => entry.kind === "error")).toBe(true);
    const visible = JSON.stringify({ result, logs: s.logs, audit });
    expect(visible).not.toContain(s.env.OPENAI_API_KEY!);
    expect(visible).not.toContain(s.env.OPENAI_CODEX_API_KEY!);
    expect(network).not.toHaveBeenCalled();
  });

  it("still supplies the personal OpenAI API key to a successful runtime request", async () => {
    const s = await serve("openai");
    expect(s.app.modelSpec).toBe(s.env.INSTINCT_MODEL);
    const result = await s.request();
    expect(result.reply).toBe("Synthetic provider completed the request.");
    expect(s.stream).toHaveBeenCalledTimes(1);
    expect(s.stream.mock.calls[0]![0].provider).toBe("openai");
    expect(s.stream.mock.calls[0]![2]?.apiKey).toBe(s.env.OPENAI_API_KEY);
    expect(network).not.toHaveBeenCalled();
  });

  it.each([false, true])("does not treat subscription catalog rates as billed API charges (cap=%s)", async capped => {
    const root = mkdtempSync(join(tmpdir(), "instinct-subscription-cost-")); roots.push(root);
    const store = new BusinessStore(join(root, "business")), coordinator = new BusinessCoordinator(store);
    try {
      if (capped) { const settings = store.settings(); store.updateSettings(settings.version, { ...settings.value, limits: { ...settings.value.limits, modelMinor: 1_000_000 } }); }
      const model = getBuiltinModels("openai-codex")[0]!;
      const faux = createFauxCore({ provider: model.provider, api: model.api, models: [{ id: model.id }] });
      const response = fauxAssistantMessage("Subscription response.");
      faux.setResponses([response]);
      const source = vi.fn(faux.streamSimple as unknown as StreamFn);
      const request = Promise.resolve(businessUsageStream(coordinator, undefined, source)(model, { messages: [{ role: "user", content: "Synthetic subscription request", timestamp: Date.now() }] }, {}));
      if (capped) { await expect(request).rejects.toThrow(); expect(source).not.toHaveBeenCalled(); }
      else {
        await request;
        expect(store.settings().value.usage.modelPriceUnknown).toBe(true);
        expect(store.list("usage")[0]!.value).toMatchObject({ costMinor: null, currency: null, status: "reported" });
      }
    } finally { await coordinator.close(); store.close(); }
  });
});
