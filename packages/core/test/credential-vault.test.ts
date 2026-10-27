import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CredentialVault, credentialScope, redactSensitive, type CredentialScope } from "../src/credential-vault.js";

const scope: CredentialScope = { workspaceId: "workspace-a", principalId: "owner", conversationKey: "business:task-a", taskId: "task-a" };

describe("controller credential vault", () => {
  it("allows only the exact bound scope and expires without replay", () => {
    let now = 1_000;
    const vault = new CredentialVault(() => now);
    const { credentialRef } = vault.issue({ scope, adapter: "hosted-computer", fields: { password: "synthetic-password-only" }, expiresAt: 2_000 });
    const adapter = vault.createResolver("hosted-computer");
    for (const changed of [{ workspaceId: "workspace-b" }, { principalId: "contact:x" }, { conversationKey: "chat:other" }, { taskId: "task-b" }]) {
      expect(() => adapter.resolve(credentialRef, "password", { ...scope, ...changed })).toThrow("unavailable");
    }
    expect(() => adapter.resolve(credentialRef, "missing", scope)).toThrow("unavailable");
    expect(adapter.resolve(credentialRef, "password", scope)).toBe("synthetic-password-only");
    expect(adapter.sensitive(scope)).toBe(true);
    now = 2_000;
    expect(() => adapter.resolve(credentialRef, "password", scope)).toThrow("unavailable");
    expect(() => new CredentialVault().createResolver("hosted-computer").resolve(credentialRef, "password", scope)).toThrow("unavailable");
  });

  it("redacts known secrets even under innocent keys before persistence", () => {
    const vault = new CredentialVault();
    const reference = vault.issue({ scope, adapter: "hosted-computer", fields: { number: "4000009990001984", cvc: "123", password: "synthetic-nonheuristic-value", token: "synthetic-session-value" } });
    const raw = { arguments: reference, history: [{ text: "echo synthetic-nonheuristic-value / synthetic-session-value / 4000009990001984 / 123" }], audit: { innocent: "synthetic-nonheuristic-value" } };
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "credential-negative-"));
    try {
      fs.writeFileSync(path.join(directory, "boundary.json"), JSON.stringify(vault.redact(raw)));
      const persisted = fs.readFileSync(path.join(directory, "boundary.json"), "utf8");
      for (const secret of ["4000009990001984", "synthetic-nonheuristic-value", "synthetic-session-value"]) expect(persisted).not.toContain(secret);
      expect(persisted).toContain(reference.credentialRef);
      expect(vault.redact(raw).arguments).toEqual(reference);
      expect(JSON.stringify(vault)).not.toContain("synthetic-nonheuristic-value");
      vault.revoke(reference.credentialRef);
      expect(() => vault.createResolver("hosted-computer").resolve(reference.credentialRef, "number", scope)).toThrow("unavailable");
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });

  it("structurally redacts nested provider JSON and rejects nonowner credential scopes", () => {
    const value = redactSensitive({ content: [{ text: JSON.stringify({ card: { number: "4000009990001984", cvc: "123" }, password: "synthetic-secret", sessionToken: "synthetic-token" }) }] });
    expect(JSON.stringify(value)).not.toContain("synthetic-secret");
    expect(JSON.stringify(value)).not.toContain("synthetic-token");
    expect(JSON.stringify(value)).not.toContain("4000009990001984");
    expect(() => credentialScope({ principal: { kind: "owner", id: "owner", tier: "friend", displayName: "Owner in group" }, conversationKey: "imessage:group" }, "workspace-a")).toThrow("owner authority");
  });
});
