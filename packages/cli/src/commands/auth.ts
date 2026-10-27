import { ChatGPTSubscription, StateDir } from "@open-instinct/core";
import { parse } from "../args.js";
import type { CliContext } from "../context.js";
import { CliError, UsageError } from "../io.js";

export type SubscriptionSession = Pick<ChatGPTSubscription, "login" | "status" | "logout" | "models">;

/** Read only from a raw terminal. Neither codes nor redirect URLs are echoed. */
function manualCode(ctx: CliContext, signal: AbortSignal, cancel: () => void): Promise<string> {
  const input = ctx.io.authInput ?? process.stdin;
  // ES2023 is the project's library target, before Promise.withResolvers.
  return new Promise((resolve, reject) => {
    let value = "";
    const terminal = input.isTTY === true && typeof input.setRawMode === "function";
    const wasRaw = input.isRaw;
    const wasPaused = input.isPaused();
    let listening = false;
    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
      if (listening) {
        input.removeListener("data", onData);
        input.removeListener("end", onEnd);
        input.removeListener("error", onEnd);
        input.setRawMode(wasRaw === true);
        if (wasPaused) input.pause();
      }
      value = "";
    };
    const onAbort = () => {
      cleanup();
      reject(new Error("Login cancelled"));
    };
    const onEnd = () => cancel();
    const onData = (chunk: Buffer | string) => {
      for (const char of chunk.toString()) {
        if (char === "\u0003" || char === "\u0004") {
          cancel();
          return;
        }
        if (char === "\r" || char === "\n") {
          if (!value.trim()) continue;
          const result = value.trim();
          cleanup();
          resolve(result);
          return;
        }
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else if (char >= " " && char !== "\u007f") value += char;
      }
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    if (terminal) {
      try {
        input.setRawMode(true);
        listening = true;
        input.on("data", onData);
        input.on("end", onEnd);
        input.on("error", onEnd);
        input.resume();
        ctx.print("Waiting for the browser callback. If it cannot reach this machine, paste the final redirect URL or code here and press Enter (input hidden). Ctrl-C cancels.");
      } catch {
        cleanup();
        reject(new Error("Secure terminal unavailable"));
      }
    } else {
      // Do not race the browser callback with an immediate prompt failure.
      ctx.print("Waiting for the browser callback. Manual input requires a terminal; use auth login --device on a headless host. Ctrl-C cancels.");
    }
  });
}

async function login(ctx: CliContext, subscription: SubscriptionSession, device: boolean): Promise<void> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const external = ctx.io.authSignal;
  const signal = external ? AbortSignal.any([controller.signal, external]) : controller.signal;
  const installSignals = ctx.io.installSignalHandlers !== false;
  if (installSignals) {
    process.on("SIGINT", cancel);
    process.on("SIGTERM", cancel);
  }
  try {
    signal.throwIfAborted();
    await subscription.login({
      signal,
      async prompt(prompt) {
        signal.throwIfAborted();
        if (prompt.type === "select") {
          const method = device ? "device_code" : "browser";
          if (!prompt.options.some((option) => option.id === method)) throw new Error("Unsupported login method");
          return method;
        }
        if (prompt.type !== "manual_code" || device) throw new Error("Unsupported login prompt");
        const promptSignal = prompt.signal ? AbortSignal.any([signal, prompt.signal]) : signal;
        return manualCode(ctx, promptSignal, cancel);
      },
      notify(event) {
        signal.throwIfAborted();
        if (event.type === "auth_url") {
          ctx.print(`Open this sign-in URL in your browser:\n${event.url}`);
        } else if (event.type === "device_code") {
          ctx.print(`Open ${event.verificationUri} and enter this one-time user code: ${event.userCode}`);
          ctx.print("Only enter it for this login. Waiting for approval; Ctrl-C cancels.");
        } else if (event.type === "progress") {
          // Provider messages and errors may contain token endpoint responses.
          ctx.print("Completing sign-in...");
        }
      },
    });
    signal.throwIfAborted();
  } catch {
    throw new CliError(signal.aborted
      ? "ChatGPT sign-in cancelled."
      : "ChatGPT sign-in failed. Retry auth login, or auth login --device on a headless host. Provider details were withheld to protect credentials.");
  } finally {
    controller.abort();
    if (installSignals) {
      process.removeListener("SIGINT", cancel);
      process.removeListener("SIGTERM", cancel);
    }
  }
  ctx.print(`ChatGPT subscription login saved for ${ctx.dataDir}.`);
  ctx.print("Model/configuration unchanged. No model request or entitlement check was made.");
  ctx.print("Choose an ID from instinct auth models, then export INSTINCT_MODEL=<that exact provider/model ID>. Check its tool and image support before live use.");
  ctx.print("Alternatively set config.json model.primary to an ID from instinct auth models.");
  ctx.print(`Restart the existing Open Instinct server with that model and the same data directory: ${ctx.dataDir}`);
  ctx.print("This uses Codex subscription access, not paid OpenAI API billing. There is no API-key fallback. Other services still need their own credentials.");
}

export async function runAuth(ctx: CliContext, argv: string[]): Promise<number> {
  let sub: string | undefined;
  let device = false;
  try {
    const parsed = parse("auth", argv, { device: { type: "boolean" } });
    [sub] = parsed.positionals;
    device = parsed.values.device === true;
    if (parsed.positionals.length !== 1 || !["login", "status", "logout", "models"].includes(sub ?? "")
      || (device && sub !== "login") || argv.filter((arg) => arg === "--device").length > 1) {
      throw new Error("Invalid arguments");
    }
  } catch {
    // Never repeat arbitrary arguments: a mistaken pasted code is still private.
    throw new UsageError("Use instinct auth login [--device], status, logout or models. All accept --data-dir <dir>.", "auth");
  }
  try {
    const state = new StateDir(ctx.dataDir);
    const subscription = await (ctx.io.openSubscription ?? ChatGPTSubscription.open)(state);
    switch (sub) {
      case "login":
        await login(ctx, subscription, device);
        break;
      case "status": {
        const status = await subscription.status();
        ctx.print(`Provider: ${status.provider}`);
        ctx.print(`Data directory: ${ctx.dataDir}`);
        ctx.print(`Local login stored: ${status.signedIn ? "yes" : "no"}`);
        ctx.print(`Access token expires: ${status.expiresAt === null ? "none" : new Date(status.expiresAt).toISOString()}`);
        ctx.print(`Refresh required: ${status.refreshRequired ? "yes" : "no"}`);
        ctx.print("Local metadata only. Live subscription eligibility and model entitlement have not been checked.");
        break;
      }
      case "models":
        ctx.print("Installed Codex subscription model catalog (not a live entitlement check):");
        for (const model of subscription.models()) ctx.print(model);
        break;
      case "logout":
        await subscription.logout();
        ctx.print(`Removed this data directory's ChatGPT login: ${ctx.dataDir}`);
        ctx.print("Global Codex credentials are unchanged. This does not revoke the provider session. Restart running servers to discard in-memory credentials.");
        break;
    }
    return 0;
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError("ChatGPT authentication operation failed. Check this data directory's private authentication storage and retry. Provider details were withheld to protect credentials.");
  }
}
