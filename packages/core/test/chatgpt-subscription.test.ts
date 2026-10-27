import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthInteraction, OAuthAuth, OAuthCredential } from "@earendil-works/pi-ai";
import { ChatGPTSubscription } from "../src/chatgpt-subscription.js";
import { BusinessStore } from "../src/business-store.js";
import { buildBusinessExport } from "../src/business-recovery.js";
import type { StateDir } from "../src/state.js";
import { tempState } from "./helpers.js";

const states: StateDir[] = [];
const interaction: AuthInteraction = {
  prompt: async () => { throw new Error("Synthetic OAuth does not prompt"); },
  notify: () => {},
};
const network = vi.fn(async () => { throw new Error("Unexpected network request in subscription test"); });
beforeEach(() => {
  network.mockClear();
  vi.stubGlobal("fetch", network);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const state of states.splice(0)) fs.rmSync(state.root, { recursive: true, force: true });
});
function stateDir(): StateDir {
  const state = tempState();
  states.push(state);
  return state;
}
function provider() {
  const initial: OAuthCredential = { type: "oauth", access: "synthetic-subscription-access", refresh: "synthetic-subscription-refresh", expires: Date.now() + 3_600_000 };
  const rotated: OAuthCredential = { type: "oauth", access: "synthetic-rotated-access", refresh: "synthetic-rotated-refresh", expires: Date.now() + 7_200_000 };
  const login = vi.fn(async () => ({ ...initial }));
  const refresh = vi.fn(async (_credential: OAuthCredential, _signal: AbortSignal) => ({ ...rotated }));
  const toAuth = vi.fn(async (credential: OAuthCredential) => ({ apiKey: credential.access }));
  const oauth: OAuthAuth = { name: "Synthetic subscription", isSubscription: true, login, refresh, toAuth };
  return { oauth, initial, rotated, login, refresh, toAuth };
}
function stored(state: StateDir): Record<string, OAuthCredential> {
  return JSON.parse(fs.readFileSync(state.path("model-auth", "auth.json"), "utf8"));
}
function expire(state: StateDir): void {
  const data = stored(state);
  data["openai-codex"]!.expires = Date.now() - 1_000;
  fs.writeFileSync(state.path("model-auth", "auth.json"), JSON.stringify(data), { mode: 0o600 });
}
async function failure(operation: Promise<unknown>): Promise<Error> {
  const error = await operation.then(() => undefined, (value: unknown) => value);
  expect(error).toBeInstanceOf(Error);
  return error as Error;
}

// Only the remote OAuth provider is synthetic. Pi's public ModelRuntime and its
// file-backed credential store perform all login, locking, refresh and logout work.
describe("private ChatGPT subscription authentication", () => {
  it("reports an unsigned installation without network or ambient API-key authentication", async () => {
    const state = stateDir();
    vi.stubEnv("OPENAI_API_KEY", "synthetic-paid-api-key");
    vi.stubEnv("OPENAI_CODEX_API_KEY", "synthetic-codex-api-key");
    const p = provider();
    const auth = await ChatGPTSubscription.open(state, { oauth: p.oauth });
    expect(await auth.status()).toEqual({ provider: "openai-codex", signedIn: false, expiresAt: null, refreshRequired: false });
    await expect(auth.key()).rejects.toThrow();
    expect(p.login).not.toHaveBeenCalled();
    expect(p.refresh).not.toHaveBeenCalled();
    expect(p.toAuth).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  });

  it("persists OAuth privately, exposes metadata only and reopens without logging in again", async () => {
    const state = stateDir();
    const p = provider();
    const secrets: string[] = [];
    const auth = await ChatGPTSubscription.open(state, { oauth: p.oauth, onSecrets: values => secrets.push(...values) });
    await auth.login(interaction);
    expect(fs.statSync(state.path("model-auth")).mode & 0o777).toBe(0o700);
    expect(fs.statSync(state.path("model-auth", "auth.json")).mode & 0o777).toBe(0o600);
    expect(stored(state)).toEqual({ "openai-codex": p.initial });
    const metadata = await auth.status();
    expect(metadata).toEqual({ provider: "openai-codex", signedIn: true, expiresAt: new Date(p.initial.expires).toISOString(), refreshRequired: false });
    expect(JSON.stringify(metadata)).not.toContain(p.initial.access);
    expect(JSON.stringify(metadata)).not.toContain(p.initial.refresh);
    expect(secrets).toEqual(expect.arrayContaining([p.initial.access, p.initial.refresh]));
    const reopened = await ChatGPTSubscription.open(state, { oauth: p.oauth });
    expect(await reopened.status()).toEqual(metadata);
    expect(await reopened.key()).toBe(p.initial.access);
    expect(p.login).toHaveBeenCalledTimes(1);
    expect(p.refresh).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  });

  it("reports near expiry without refreshing during status and retains rotated credentials after a request", async () => {
    const state = stateDir();
    const p = provider();
    const auth = await ChatGPTSubscription.open(state, { oauth: p.oauth, now: () => p.initial.expires - 60_000 });
    await auth.login(interaction);
    expect((await auth.status()).refreshRequired).toBe(true);
    expect(p.refresh).not.toHaveBeenCalled();
    expire(state);
    expect(await auth.key()).toBe(p.rotated.access);
    expect(p.refresh).toHaveBeenCalledTimes(1);
    expect(p.refresh.mock.calls[0]![0].refresh).toBe(p.initial.refresh);
    expect(stored(state)["openai-codex"]).toEqual(p.rotated);
    const reopened = await ChatGPTSubscription.open(state, { oauth: p.oauth });
    expect(await reopened.key()).toBe(p.rotated.access);
    expect(p.refresh).toHaveBeenCalledTimes(1);
    expect(fs.statSync(state.path("model-auth", "auth.json")).mode & 0o777).toBe(0o600);
    expect(network).not.toHaveBeenCalled();
  });

  it("serializes refresh across independently opened instances so a rotating token is used only once", async () => {
    const state = stateDir();
    const p = provider();
    const first = await ChatGPTSubscription.open(state, { oauth: p.oauth });
    await first.login(interaction);
    const second = await ChatGPTSubscription.open(state, { oauth: p.oauth });
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    let used = false;
    p.refresh.mockImplementation(async credential => {
      if (used || credential.refresh !== p.initial.refresh) throw new Error("Synthetic single-use refresh token was reused");
      used = true;
      await hold;
      return { ...p.rotated };
    });
    expire(state);
    const keys = Promise.all([first.key(), second.key()]);
    // Attach rejection handling immediately while the provider's first exchange is held.
    const result = keys.then(value => ({ value }), error => ({ error }));
    try {
      await vi.waitFor(() => expect(p.refresh).toHaveBeenCalledTimes(1));
    } finally { release(); }
    expect(await result).toEqual({ value: [p.rotated.access, p.rotated.access] });
    expect(p.refresh).toHaveBeenCalledTimes(1);
    expect(stored(state)["openai-codex"]).toEqual(p.rotated);
    expect(network).not.toHaveBeenCalled();
  });

  it("makes logout visible to an already-open instance instead of returning its previous access token", async () => {
    const state = stateDir();
    const p = provider();
    const first = await ChatGPTSubscription.open(state, { oauth: p.oauth });
    await first.login(interaction);
    const second = await ChatGPTSubscription.open(state, { oauth: p.oauth });
    expect(await second.key()).toBe(p.initial.access);
    await first.logout();
    expect(await second.status()).toEqual({ provider: "openai-codex", signedIn: false, expiresAt: null, refreshRequired: false });
    await expect(second.key()).rejects.toThrow();
    const disk = fs.readFileSync(state.path("model-auth", "auth.json"), "utf8");
    expect(disk).not.toContain(p.initial.access);
    expect(disk).not.toContain(p.initial.refresh);
    expect(p.toAuth).toHaveBeenCalledTimes(1);
  });

  it("fails closed after refresh failure without returning stale auth, paid API keys or provider secret text", async () => {
    const state = stateDir();
    const p = provider();
    const auth = await ChatGPTSubscription.open(state, { oauth: p.oauth });
    await auth.login(interaction);
    expire(state);
    vi.stubEnv("OPENAI_API_KEY", "synthetic-paid-api-key");
    vi.stubEnv("OPENAI_CODEX_API_KEY", "synthetic-codex-api-key");
    p.refresh.mockRejectedValue(new Error(`Rejected refresh ${p.initial.refresh}`));
    const error = await failure(auth.key());
    expect(error.message).not.toContain(p.initial.refresh);
    expect(error.message).not.toContain(p.initial.access);
    expect(error.message).not.toContain("synthetic-paid-api-key");
    expect(error.cause).toBeUndefined();
    expect(p.refresh).toHaveBeenCalledTimes(1);
    expect(p.toAuth).not.toHaveBeenCalled();
    expect((await auth.status()).refreshRequired).toBe(true);
    expect(network).not.toHaveBeenCalled();
  });

  it.each(["same", "workspace-parent", "workspace-child"])("refuses %s overlap with the worker-readable workspace", async kind => {
    const state = stateDir();
    fs.mkdirSync(state.path("model-auth"), { mode: 0o700 });
    fs.rmSync(state.path("workspace"), { recursive: true });
    const target = kind === "same" ? state.path("model-auth") : kind === "workspace-parent" ? state.root : state.path("model-auth", "readable");
    fs.mkdirSync(target, { recursive: true });
    fs.symlinkSync(target, state.path("workspace"), "dir");
    await expect(ChatGPTSubscription.open(state)).rejects.toThrow();
    expect(network).not.toHaveBeenCalled();
  });

  it("refuses a symlinked authentication directory", async () => {
    const state = stateDir();
    fs.mkdirSync(state.path("elsewhere"));
    fs.symlinkSync(state.path("elsewhere"), state.path("model-auth"), "dir");
    await expect(ChatGPTSubscription.open(state)).rejects.toThrow();
    expect(fs.readdirSync(state.path("elsewhere"))).toEqual([]);
  });

  it.each(["auth.json", "models.json"])("refuses symlinked and hardlinked %s without modifying the linked target", async filename => {
    const state = stateDir();
    const p = provider();
    const target = state.path("outside.json");
    const content = JSON.stringify({ "openai-codex": p.initial });
    fs.writeFileSync(target, content, { mode: 0o644 });
    fs.chmodSync(target, 0o644);
    fs.mkdirSync(state.path("model-auth"), { mode: 0o700 });
    const file = state.path("model-auth", filename);
    for (const link of [fs.symlinkSync, fs.linkSync]) {
      link(target, file);
      await expect(ChatGPTSubscription.open(state, { oauth: p.oauth })).rejects.toThrow();
      expect(fs.readFileSync(target, "utf8")).toBe(content);
      expect(fs.statSync(target).mode & 0o777).toBe(0o644);
      fs.unlinkSync(file);
    }
  });

  it.each(["invalid-json", "invalid-oauth", "unexpected-provider"])("rejects %s credentials without quoting their contents", async kind => {
    const state = stateDir();
    const p = provider();
    const auth = await ChatGPTSubscription.open(state, { oauth: p.oauth });
    await auth.login(interaction);
    const content = kind === "invalid-json" ? `{"openai-codex": "${p.initial.refresh}`
      : kind === "invalid-oauth" ? JSON.stringify({ "openai-codex": { ...p.initial, expires: "not-a-date" } })
      : JSON.stringify({ "openai-codex": p.initial, unexpected: p.initial });
    fs.writeFileSync(state.path("model-auth", "auth.json"), content);
    for (const operation of [() => auth.status(), () => auth.key(), () => ChatGPTSubscription.open(state, { oauth: p.oauth })]) {
      const error = await failure(operation());
      expect(error.message).not.toContain(p.initial.refresh);
      expect(error.message).not.toContain(p.initial.access);
      expect(error.cause).toBeUndefined();
    }
    expect(p.toAuth).not.toHaveBeenCalled();
  });

  it("rejects API-key credentials before Pi can execute command-valued keys", async () => {
    const state = stateDir();
    const p = provider();
    const auth = await ChatGPTSubscription.open(state, { oauth: p.oauth });
    await auth.login(interaction);
    const marker = state.path("command-executed");
    const command = `!touch '${marker.replaceAll("'", "'\\''")}'`;
    fs.writeFileSync(state.path("model-auth", "auth.json"), JSON.stringify({ "openai-codex": { type: "api_key", key: command } }));
    await expect(auth.key()).rejects.toThrow();
    await expect(ChatGPTSubscription.open(state, { oauth: p.oauth })).rejects.toThrow();
    // Drain asynchronous provider-registration work too, not only synchronous validation.
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(fs.existsSync(marker)).toBe(false);
    expect(p.toAuth).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  });

  it("keeps model authentication outside the business export while retaining business content", async () => {
    const state = stateDir();
    const p = provider();
    const auth = await ChatGPTSubscription.open(state, { oauth: p.oauth });
    await auth.login(interaction);
    const store = new BusinessStore(state.path("business"));
    try {
      store.appendMessage({ id: "subscription-export", role: "notice", text: "Synthetic business content", channel: "chat", thread: "chat:owner", taskId: null, artifactIds: [], at: Date.now() });
      const exported = Buffer.from(buildBusinessExport(store).bytes).toString("utf8");
      expect(exported).toContain("Synthetic business content");
      expect(exported).not.toContain(p.initial.access);
      expect(exported).not.toContain(p.initial.refresh);
      expect(exported).not.toContain("model-auth");
      expect(await auth.key()).toBe(p.initial.access);
    } finally { store.close(); }
  });
});
