import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BusinessStore, type BusinessConnection, type StateDir } from "@open-instinct/core";
import { ComposioApps } from "../src/composio.js";
import { createBusinessProviders } from "../src/business-providers.js";
import { GmailIntake } from "../src/gmail-intake.js";
import { GoogleWorkspace } from "../src/google-workspace.js";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
function store() {
  const root = mkdtempSync(join(tmpdir(), "instinct-provider-"));
  const db = new BusinessStore(root);
  cleanups.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  return db;
}
describe("business provider state", () => {
  it("persists disable before revocation and reports asynchronous revocation requested", async () => {
    const db = store();
    const connection: BusinessConnection = { id: "account", accountId: "account", toolkit: "gmail", identity: "owner@example.test", scopes: [], status: "connected", epoch: 0, connectedBy: "owner", verifiedAt: 1, revocation: "none", revokeJobId: null };
    db.put("connection", connection.id, connection, null);
    const apps = new ComposioApps({ apiKey: "synthetic", userId: db.settings().value.workspaceId, toolkits: ["gmail"], state: {} as StateDir,
      adapters: { createComposio: () => ({ sessions: { create: async () => { throw new Error("unexpected create"); }, use: async () => { throw new Error("unexpected use"); } } }),
        fetchImpl: async (url, init) => {
          expect(init?.method).toBe("DELETE"); expect(String(url)).toContain("revoke_on_delete=true");
          expect(db.get<BusinessConnection>("connection", "account")?.value.status).toBe("disabled");
          return Response.json({ success: true, revoke_job_id: "revocation-job" });
        } },
    });
    const providers = createBusinessProviders({ apps, store: db });
    expect(await providers.connections.disconnect("account")).toMatchObject({ status: "disabled", epoch: 1, revocation: "requested", revokeJobId: "revocation-job" });
    expect(() => providers.googleForAccount("account")).toThrow("connection required");
  });
  it("persists intake discoveries before checkpoint and retries admission without losing a message", async () => {
    const db = store(); let attempts = 0;
    const google = new GoogleWorkspace({ request: async (request) => {
      if (request.endpoint.endsWith("profile")) return { status: 200, data: { historyId: "10" } };
      if (request.endpoint.endsWith("/messages")) return { status: 200, data: { messages: [{ id: "new" }, { id: "old" }, { id: "sent" }] } };
      if (request.endpoint.endsWith("/messages/new")) return { status: 200, data: { id: "new", internalDate: "2000", labelIds: ["INBOX"] } };
      if (request.endpoint.endsWith("/messages/old")) return { status: 200, data: { id: "old", internalDate: "500", labelIds: ["INBOX"] } };
      if (request.endpoint.endsWith("/messages/sent")) return { status: 200, data: { id: "sent", internalDate: "2000", labelIds: ["SENT"] } };
      throw new Error("Unexpected wire request");
    } });
    const intake = new GmailIntake(db, google, "account");
    await intake.activate(1000);
    await expect(intake.sweep(async () => { attempts++; throw new Error("controller interrupted"); })).rejects.toThrow("interrupted");
    expect(db.get<{ admitted: boolean }>("cursor", "gmail-message:account:new")?.value.admitted).toBe(false);
    await intake.sweep(async () => { attempts++; });
    expect(attempts).toBe(2);
    expect(db.get<{ admitted: boolean }>("cursor", "gmail-message:account:new")?.value.admitted).toBe(true);
    expect(db.get("cursor", "gmail-message:account:old")).toBeUndefined();
    expect(db.get("cursor", "gmail-message:account:sent")).toBeUndefined();
    expect(db.get<{ mode: string }>("cursor", "gmail-intake:account")?.value.mode).toBe("history");
  });
});
