import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { ReadStream } from "node:tty";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StateDir } from "@open-instinct/core";
import type { SubscriptionSession } from "../src/commands/auth.js";
import { makeIo, run, tmpDir } from "./helpers.js";
import { runCli } from "../src/cli.js";

type Interaction = Parameters<SubscriptionSession["login"]>[0];
const dirs: string[] = [];
function directory(): string {
  const dir = tmpDir();
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function session(): SubscriptionSession {
  return {
    login: vi.fn(async () => {}),
    status: vi.fn(async () => ({ provider: "openai-codex" as const, signedIn: false, expiresAt: null, refreshRequired: false })),
    models: vi.fn(() => ["openai-codex/gpt-5.4"]),
    logout: vi.fn(async () => {}),
  };
}
function terminal() {
  const stream = new PassThrough();
  stream.pause();
  const input = Object.assign(stream, {
    isTTY: true,
    isRaw: false,
    setRawMode: vi.fn((raw: boolean): PassThrough => { input.isRaw = raw; return stream; }),
  });
  return input as unknown as ReadStream;
}
const methods = {
  type: "select" as const,
  message: "Select OpenAI Codex login method:",
  options: [{ id: "browser", label: "Browser" }, { id: "device_code", label: "Device" }],
};

describe("private ChatGPT subscription auth", () => {
  it.each([
    [], ["wat"], ["login", "private-pasted-code"], ["status", "--device"],
    ["logout", "extra"], ["models", "--token=private-pasted-code"], ["login", "--device", "--device"],
  ])("rejects invalid arguments before opening storage: %j", async (...args) => {
    const dir = path.join(directory(), "untouched");
    const openSubscription = vi.fn(async () => session());
    const result = await run(["auth", ...args, "--data-dir", dir], {}, { openSubscription });
    expect(result.code).toBe(2);
    expect(openSubscription).not.toHaveBeenCalled();
    expect(fs.existsSync(dir)).toBe(false);
    expect(result.out + result.err).not.toContain("private-pasted-code");
  });

  it.each([false, true])("selects Pi's actual method ID and preserves configuration (device=%s)", async (device) => {
    const dir = directory();
    const config = '{"model":{"primary":"anthropic/existing"}}\n';
    fs.writeFileSync(path.join(dir, "config.json"), config);
    const sub = session();
    sub.login = vi.fn(async (interaction: Interaction) => {
      expect(await interaction.prompt(methods)).toBe(device ? "device_code" : "browser");
      if (device) interaction.notify({ type: "device_code", verificationUri: "https://auth.openai.com/codex/device", userCode: "TEST-ONLY" });
      else interaction.notify({ type: "auth_url", url: "https://auth.openai.com/oauth/authorize?state=test" });
    });
    const openSubscription = vi.fn(async (state: StateDir) => {
      expect(state.path("model-auth")).toBe(path.join(dir, "model-auth"));
      return sub;
    });
    const result = await run(["--data-dir", dir, "auth", "login", ...(device ? ["--device"] : [])],
      { INSTINCT_DATA_DIR: "/unused", OPENAI_API_KEY: "not-used-private-api-key" },
      { openSubscription, installSignalHandlers: false });
    expect(result.code, result.err).toBe(0);
    expect(fs.readFileSync(path.join(dir, "config.json"), "utf8")).toBe(config);
    expect(sub.status).not.toHaveBeenCalled();
    expect(result.out).not.toContain("not-used-private-api-key");
    expect(result.out).toContain(device ? "TEST-ONLY" : "https://auth.openai.com/oauth/authorize");
  });

  it("finishes a browser callback without input and removes the pending terminal prompt", async () => {
    const input = terminal();
    const sub = session();
    sub.login = async (interaction) => {
      expect(await interaction.prompt(methods)).toBe("browser");
      const callbackWon = new AbortController();
      const prompt = interaction.prompt({ type: "manual_code", message: "ignored", signal: callbackWon.signal });
      const rejection = expect(prompt).rejects.toThrow("cancelled");
      expect(input.isRaw).toBe(true);
      callbackWon.abort();
      await rejection;
      expect(interaction.signal?.aborted).toBe(false);
    };
    const result = await run(["auth", "login"], { INSTINCT_DATA_DIR: directory() },
      { openSubscription: async () => sub, authInput: input, installSignalHandlers: false });
    expect(result.code, result.err).toBe(0);
    expect(input.isRaw).toBe(false);
    expect(input.listenerCount("data")).toBe(0);
    expect(input.listenerCount("end")).toBe(0);
    expect(input.listenerCount("error")).toBe(0);
    expect(input.isPaused()).toBe(true);
  });

  it("accepts a manual code without echo and restores terminal state", async () => {
    const input = terminal();
    const sub = session();
    sub.login = async (interaction) => {
      const pending = interaction.prompt({ type: "manual_code", message: "provider-private-message" });
      input.emit("data", Buffer.from("private-code\r"));
      expect(await pending).toBe("private-code");
    };
    const result = await run(["auth", "login"], { INSTINCT_DATA_DIR: directory() },
      { openSubscription: async () => sub, authInput: input, installSignalHandlers: false });
    expect(result.code, result.err).toBe(0);
    expect(result.out + result.err).not.toContain("private-code");
    expect(result.out + result.err).not.toContain("provider-private-message");
    expect(input.isRaw).toBe(false);
    expect(input.listenerCount("data")).toBe(0);
  });

  it("Ctrl-C aborts the provider flow and releases terminal and process listeners", async () => {
    const input = terminal();
    const sub = session();
    let providerSignal: AbortSignal | undefined;
    sub.login = async (interaction) => {
      providerSignal = interaction.signal;
      const pending = interaction.prompt({ type: "manual_code", message: "hidden" });
      input.emit("data", Buffer.from("\u0003"));
      await pending;
    };
    const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
    const result = await run(["auth", "login"], { INSTINCT_DATA_DIR: directory() },
      { openSubscription: async () => sub, authInput: input });
    expect(result.code).toBe(1);
    expect(providerSignal?.aborted).toBe(true);
    expect(result.err).toContain("cancelled");
    expect(input.isRaw).toBe(false);
    expect(input.listenerCount("data")).toBe(0);
    expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before);
  });

  it("cancels device polling through the injected signal without reading terminal input", async () => {
    const input = terminal();
    const cancel = new AbortController();
    const sub = session();
    sub.login = async (interaction) => {
      expect(await interaction.prompt(methods)).toBe("device_code");
      interaction.notify({ type: "device_code", verificationUri: "https://auth.openai.com/codex/device", userCode: "TEST-ONLY" });
      cancel.abort();
      interaction.signal!.throwIfAborted();
    };
    const result = await run(["auth", "login", "--device"], { INSTINCT_DATA_DIR: directory() },
      { openSubscription: async () => sub, authSignal: cancel.signal, authInput: input, installSignalHandlers: false });
    expect(result.code).toBe(1);
    expect(result.err).toContain("cancelled");
    expect(input.setRawMode).not.toHaveBeenCalled();
  });

  it("prints only local status metadata and catalog without login or logout", async () => {
    const sub = session();
    sub.status = vi.fn(async () => ({
      provider: "openai-codex" as const, signedIn: true, expiresAt: "2023-11-14T22:13:20.000Z", refreshRequired: true,
      access: "private-access", refresh: "private-refresh", accountId: "private-account",
    }));
    for (const command of ["status", "models"]) {
      const result = await run(["auth", command], { INSTINCT_DATA_DIR: directory() }, { openSubscription: async () => sub });
      expect(result.code, result.err).toBe(0);
      expect(result.out).toContain("entitlement");
      expect(result.out + result.err).not.toMatch(/private-(access|refresh|account)/);
    }
    expect(sub.login).not.toHaveBeenCalled();
    expect(sub.logout).not.toHaveBeenCalled();
    expect(sub.status).toHaveBeenCalledTimes(1);
  });

  it("logs out only through the selected directory's session", async () => {
    const dir = directory();
    const sub = session();
    const result = await run(["auth", "logout", `--data-dir=${dir}`], {}, {
      openSubscription: async (state) => {
        expect(state.path("model-auth")).toBe(path.join(dir, "model-auth"));
        return sub;
      },
    });
    expect(result.code).toBe(0);
    expect(sub.logout).toHaveBeenCalledOnce();
    expect(sub.login).not.toHaveBeenCalled();
    expect(result.out).toContain("does not revoke");
  });

  it.each(["open", "login", "status", "logout", "models"])("withholds private failures from %s even in debug mode", async (operation) => {
    const sub = session();
    const fail = () => { throw new Error("private-access private-refresh private-response"); };
    if (operation === "models") sub.models = fail;
    else if (operation !== "open") Object.assign(sub, { [operation]: fail });
    const { io, out, err } = makeIo({
      openSubscription: operation === "open" ? fail : async () => sub,
      installSignalHandlers: false,
    });
    const code = await runCli(["auth", operation === "open" ? "status" : operation],
      { INSTINCT_DATA_DIR: directory(), INSTINCT_DEBUG: "1" }, io);
    expect(code).toBe(1);
    expect(out() + err()).not.toMatch(/private-(access|refresh|response)/);
    expect(err()).toContain("withheld");
  });
});
