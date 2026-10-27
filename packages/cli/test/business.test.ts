import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BusinessStore } from "@open-instinct/core";
import { fakeFetch, json, run } from "./helpers.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("business owner CLI", () => {
  it.each([
    [["status"], "business status"], [["tasks"], "business tasks"], [["task", "task-123"], "business task task-123"],
    [["pause"], "business pause"], [["resume"], "business resume"], [["stop"], "business pause"],
    [["stop", "task-123"], "business stop task-123"], [["close", "task-123"], "business close task-123"],
  ] as Array<[string[], string]>)("sends %j through authenticated deterministic owner intake", async (args, message) => {
    const f = fakeFetch({ "http://127.0.0.1:8080/chat": init => {
      expect(init.headers).toMatchObject({ Authorization: "Bearer synthetic-owner-token" });
      expect(JSON.parse(String(init.body))).toMatchObject({ message, source: "cli" });
      return json({ response: "Durable result" });
    } });
    const result = await run(["business", ...args], { INSTINCT_CHAT_TOKEN: "synthetic-owner-token" }, { fetchImpl: f.fetch });
    expect(result.code, result.err).toBe(0); expect(result.out).toBe("Durable result\n"); expect(f.calls).toHaveLength(1);
  });

  it("requires local authentication even on loopback and refuses insecure remote control", async () => {
    const f = fakeFetch({});
    expect((await run(["business", "pause"], {}, { fetchImpl: f.fetch })).code).toBe(1);
    expect((await run(["business", "pause", "--url", "http://controller.example.test"], { INSTINCT_CHAT_TOKEN: "synthetic" }, { fetchImpl: f.fetch })).code).toBe(2);
    expect((await run(["business", "pause", "--url", "https://user:password@controller.example.test"], { INSTINCT_CHAT_TOKEN: "synthetic" }, { fetchImpl: f.fetch })).code).toBe(2);
    expect(f.calls).toHaveLength(0);
  });

  it("uses authenticated Maritime relay without requiring a local token", async () => {
    const f = fakeFetch({ "https://api.maritime.sh/api/agents/agent-123/chat": init => {
      expect(init.headers).toMatchObject({ Authorization: "Bearer synthetic-maritime-key" });
      expect(JSON.parse(String(init.body)).message).toBe("business pause");
      return json({ pending: ["Earlier task finished"], response: "Stopped" });
    } });
    const result = await run(["business", "pause", "--agent", "agent-123"], { MARITIME_API_KEY: "synthetic-maritime-key" }, { fetchImpl: f.fetch });
    expect(result.code, result.err).toBe(0); expect(result.out).toBe("Earlier task finished\nStopped\n");
  });

  it.each([["task"], ["close"], ["pause", "task-123"], ["stop", "task;delete"], ["status", "--destination", "file"]])("rejects malformed control %j before network", async (...args) => {
    const f = fakeFetch({});
    const result = await run(["business", ...args], { INSTINCT_CHAT_TOKEN: "synthetic" }, { fetchImpl: f.fetch });
    expect(result.code).toBe(2); expect(f.calls).toHaveLength(0);
  });

  it("creates a local backup/export and restores fresh stopped state through operator commands", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "cli-business-"))); roots.push(root);
    const business = join(root, "business"); const store = new BusinessStore(business); store.close();
    const env = { INSTINCT_DATA_DIR: root };
    const backed = await run(["business", "backup", "--destination", join(root, "backups"), "--retention", "3"], env);
    expect(backed.code, backed.err).toBe(0);
    const manifest = JSON.parse(backed.out);
    const restored = await run(["business", "restore", "--source", join(root, "backups", manifest.id), "--destination", join(root, "restored")], env);
    expect(restored.code, restored.err).toBe(0); expect(JSON.parse(restored.out).stopped).toBe(true);
    const output = join(root, "export.json");
    const exported = await run(["business", "export", "--destination", output], env);
    expect(exported.code, exported.err).toBe(0); expect(existsSync(output)).toBe(true);
    expect(JSON.parse(readFileSync(output, "utf8")).format).toBe("open-instinct-business-export");
    expect((await run(["business", "backup", "--destination", join(root, "backups")], env)).code).toBe(2);
    expect((await run(["business", "delete", "--confirm-workspace", "wrong"], env)).code).toBe(1);
  });
});

describe("deferred chat replies", () => {
  it.each([false, true])("prints pending-only replies for Maritime=%s", async remote => {
    const f = fakeFetch({ [remote ? "https://api.maritime.sh/" : "http://127.0.0.1:8080/"]: () => json({ response: null, pending: ["First completed task", "Second completed task"] }) });
    const result = await run(["chat", "status", ...(remote ? ["--agent", "agent-123"] : [])], { MARITIME_API_KEY: "synthetic" }, { fetchImpl: f.fetch });
    expect(result.code, result.err).toBe(0); expect(result.out).toBe("First completed task\nSecond completed task\n");
  });
  it("keeps deferred replies when the current request reports an error", async () => {
    const f = fakeFetch({ "http://127.0.0.1:8080/": () => json({ response: null, pending: ["Earlier result"], error: "Current request failed" }) });
    const result = await run(["chat", "status"], {}, { fetchImpl: f.fetch });
    expect(result.code).toBe(1); expect(result.out).toBe("Earlier result\n"); expect(result.err).toContain("Current request failed");
  });
});
