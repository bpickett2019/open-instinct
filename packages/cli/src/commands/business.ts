import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { BusinessStore, createBusinessBackup, deleteBusinessWorkspace, exportBusinessWorkspace, loadConfig, restoreBusinessBackup } from "@open-instinct/core";
import { parse, requireStr, str, type OptionSpec } from "../args.js";
import type { CliContext } from "../context.js";
import { CliError, UsageError, fetchOf } from "../io.js";
import { DEFAULT_LOCAL_URL, localChat } from "../local.js";
import { chatWithAgent, maritimeBaseUrl } from "../maritime.js";
import { printChatResponse } from "./chat.js";

export const businessOptions: OptionSpec = {
  url: { type: "string" }, agent: { type: "string" },
  "business-dir": { type: "string" }, destination: { type: "string" },
  source: { type: "string" }, retention: { type: "string" },
  "confirm-workspace": { type: "string" },
};
const CONTROLS: Record<string, true> = { status: true, tasks: true, task: true, pause: true, resume: true, stop: true, close: true };

/** Fail before sending credentials to an unencrypted nonlocal server. */
function controlOrigin(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) throw new UsageError("Control URL must be an origin without credentials, path or query", "business");
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) throw new UsageError("Remote business controls require HTTPS", "business");
  return url.origin;
}

export async function runBusiness(ctx: CliContext, argv: string[]): Promise<number> {
  const { values, positionals } = parse("business", argv, businessOptions);
  const [operation, id, ...extra] = positionals;
  if (!operation || extra.length) throw new UsageError("Choose a business control or recovery operation", "business");
  if (Object.hasOwn(CONTROLS, operation)) {
    if (Object.keys(values).some(key => !["url", "agent"].includes(key))) throw new UsageError("Recovery flags do not apply to business controls", "business");
    if (["task", "close"].includes(operation) && !id) throw new UsageError(`${operation} needs a task ID`, "business");
    if (id && (!["task", "stop", "close"].includes(operation) || !/^[a-zA-Z0-9-]+$/.test(id))) throw new UsageError("Unexpected or invalid task ID", "business");
    const message = operation === "stop" && !id ? "business pause" : `business ${operation}${id ? ` ${id}` : ""}`;
    const agent = str(values, "agent");
    if (agent && str(values, "url")) throw new UsageError("Choose --agent or --url, not both", "business");
    if (agent) {
      const apiKey = ctx.env.MARITIME_API_KEY?.trim();
      if (!apiKey) throw new CliError("MARITIME_API_KEY is required for --agent.");
      return printChatResponse(ctx, await chatWithAgent({ apiKey, baseUrl: controlOrigin(maritimeBaseUrl(ctx.env)), fetchImpl: fetchOf(ctx.io) }, agent, message));
    }
    const token = ctx.env.INSTINCT_CHAT_TOKEN?.trim();
    if (!token) throw new CliError("INSTINCT_CHAT_TOKEN is required for business controls, including loopback.");
    return printChatResponse(ctx, await localChat(fetchOf(ctx.io), controlOrigin(str(values, "url") ?? DEFAULT_LOCAL_URL), { message, source: "cli" }, token));
  }
  if (id || str(values, "agent") || str(values, "url")) throw new UsageError("Recovery commands run on the controller filesystem, not a remote chat endpoint", "business");
  const allowed: Record<string, string[]> = {
    backup: ["business-dir", "destination", "retention"], export: ["business-dir", "destination"],
    restore: ["source", "destination"], delete: ["business-dir", "confirm-workspace"],
  };
  if (!Object.hasOwn(allowed, operation) || Object.keys(values).some(key => !allowed[operation]!.includes(key))) throw new UsageError("Unknown operation or incompatible recovery flag", "business");
  if (operation === "restore") {
    const result = restoreBusinessBackup({ source: requireStr(values, "source", "business"), destination: requireStr(values, "destination", "business") });
    ctx.print(JSON.stringify(result, null, 2));
    ctx.warn("Restored in safe mode. Reconcile provider history since the snapshot; never replay old effects. Credentials and browser sessions were not restored.");
    return 0;
  }
  const configured = existsSync(join(ctx.dataDir, "config.json")) ? loadConfig(ctx.state(), ctx.env).business?.stateDirectory : undefined;
  const directory = resolve(str(values, "business-dir") ?? configured ?? join(ctx.dataDir, "business"));
  if (!existsSync(join(directory, "business.sqlite"))) throw new CliError("No existing business database. Check --data-dir or --business-dir.");
  if (operation === "delete") {
    deleteBusinessWorkspace({ directory, confirmWorkspaceId: requireStr(values, "confirm-workspace", "business") });
    ctx.print("Business workspace deleted locally. Backups, provider data and separate browser sessions are not erased.");
    return 0;
  }
  const destination = requireStr(values, "destination", "business");
  const retention = operation === "backup" ? Number(requireStr(values, "retention", "business")) : undefined;
  const store = new BusinessStore(directory);
  try {
    const result = operation === "backup" ? createBusinessBackup(store, { destination, retention: retention! }) : exportBusinessWorkspace(store, { destination });
    ctx.print(JSON.stringify(result, null, 2));
  } finally { store.close(); }
  return 0;
}
