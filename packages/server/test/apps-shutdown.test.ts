import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("app SDK process lifecycle", () => {
  it("lets the controller finish asynchronous cleanup after SIGTERM", () => {
    const child = spawnSync(process.execPath, ["--input-type=module", "--eval", `
      // No real provider, telemetry, or npm requests may leave this child.
      globalThis.fetch = async () => new Response("{}", { status: 200 });
      const { ComposioApps } = await import("@open-instinct/apps");
      new ComposioApps({ apiKey: "synthetic-shutdown", userId: "synthetic-owner" });
      const deadline = setTimeout(() => process.exit(2), 2000);
      process.once("SIGTERM", () => {
        // Real OS signal delivery must race with asynchronous cleanup; fake timers
        // cannot exercise the SDK's process.kill re-signal in this subprocess.
        setTimeout(() => {
          process.stdout.write("cleanup-complete\\n");
          clearTimeout(deadline);
          process.exit(0);
        }, 100);
      });
      process.kill(process.pid, "SIGTERM");
    `], { cwd: new URL("..", import.meta.url), encoding: "utf8", timeout: 5000 });
    expect(child.error).toBeUndefined();
    expect(child.signal).toBeNull();
    expect(child.status).toBe(0);
    expect(child.stdout).toContain("cleanup-complete\n");
  });
});
