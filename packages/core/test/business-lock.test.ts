import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { acquireBusinessLock } from "../src/business-lock.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("business controller ownership", () => {
  it("rejects concurrent ownership and permits normal reopening", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "business-lock-"))); roots.push(root);
    const directory = join(root, "business");
    const release = acquireBusinessLock(directory);
    try { expect(() => acquireBusinessLock(directory)).toThrow(/owned/); } finally { release(); }
    const next = acquireBusinessLock(directory); next(); next();
  });

  it("does not steal a live PID ownership record even if the mutex is available", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "business-lock-"))); roots.push(root);
    writeFileSync(join(root, ".business.controller-owner.json"), JSON.stringify({ pid: process.pid, token: "synthetic" }));
    expect(() => acquireBusinessLock(join(root, "business"))).toThrow(/owned/);
  });

  it("rejects a second process and recovers a killed controller without stale-lock replay", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "business-lock-"))); roots.push(root);
    const directory = join(root, "business");
    const module = new URL("../src/business-lock.ts", import.meta.url).href;
    const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `import { acquireBusinessLock } from ${JSON.stringify(module)}; acquireBusinessLock(${JSON.stringify(directory)}); process.stdin.resume(); process.stdout.write('ready');`], { stdio: ["pipe", "pipe", "pipe"] });
    let exited = false; child.once("exit", () => { exited = true; });
    try {
      await Promise.race([
        once(child.stdout, "data"),
        once(child, "exit").then(([code]) => { throw new Error(`Lock holder exited before ready: ${code}`); }),
      ]);
      expect(() => acquireBusinessLock(directory)).toThrow(/owned/);
      const exit = once(child, "exit"); child.kill("SIGKILL"); await exit;
      const recovered = acquireBusinessLock(directory); recovered();
    } finally {
      if (!exited) { const exit = once(child, "exit"); child.kill("SIGKILL"); await exit; }
    }
  });
});
