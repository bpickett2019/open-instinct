import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { simpleParser } from "mailparser";
import { GoogleWorkspace, type CalendarInput, type MailInput } from "../src/google-workspace.js";
import { googleToolkit, type GoogleRequest, type GoogleTransport } from "../src/google-transport.js";

describe("typed Google boundary", () => {
  it("refuses alternate hosts, user identities, encoded traversal and unsupported writes", () => {
    for (const endpoint of ["https://evil.test/gmail/v1/users/me/messages/send", "https://gmail.googleapis.com/gmail/v1/users/other/messages/send", "https://gmail.googleapis.com/gmail/v1/users/me/messages/%2fadmin", "https://gmail.googleapis.com/gmail/v1/users/me/messages/send?key=x"]) {
      expect(() => googleToolkit({ method: "POST", endpoint })).toThrow();
    }
    expect(() => googleToolkit({ method: "DELETE", endpoint: "https://gmail.googleapis.com/gmail/v1/users/me/messages/x" })).toThrow();
  });
  it("prepares deterministic UTF-8 MIME and Bcc with exact attachment bytes before send", async () => {
    const calls: GoogleRequest[] = [];
    const workspace = new GoogleWorkspace({ request: async (r) => { calls.push(r); return { status: 200, data: {} }; } });
    const bytes = Buffer.from("café attachment");
    const input = { from: "owner@example.test", to: ["client@example.test"], bcc: ["archive@example.test"], subject: "Café", text: "Bonjour café", inReplyTo: "<previous@example.test>", references: ["<previous@example.test>"], attachments: [{ filename: "note.txt", contentType: "text/plain", content: bytes.toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex") }] };
    const prepared = await workspace.prepareMail(input, "task:step");
    expect(await workspace.prepareMail(input, "task:step")).toEqual(prepared);
    expect(calls).toHaveLength(0);
    const parsed = await simpleParser(Buffer.from(prepared.raw, "base64url"));
    expect(parsed.subject).toBe("Café"); expect(parsed.bcc).toBeDefined(); expect(parsed.attachments[0]?.content).toEqual(bytes);
    await expect(workspace.prepareMail({ ...input, subject: "Injected\r\nBcc: evil@example.test" }, "x")).rejects.toThrow();
    await expect(workspace.prepareMail({ ...input, attachments: [{ ...input.attachments[0]!, sha256: "bad" }] }, "x")).rejects.toThrow();
  });
  it("hashes only deterministic serialized mail, including serializer-equivalent headers and bodies", async () => {
    const workspace = new GoogleWorkspace({ request: async () => { throw new Error("Preparation must stay offline"); } });
    const bytes = Buffer.from("attachment bytes");
    const attachment = { filename: "note.txt", contentType: "text/plain", content: bytes.toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex") };
    const base: MailInput = { from: "owner@example.test", to: ["client@example.test"], subject: "Canonical message", text: "First line\nSecond line", html: "<p>First line</p>\n<p>Second line</p>", inReplyTo: "previous@example.test", references: ["previous@example.test"], attachments: [attachment] };
    const expected = await workspace.prepareMail(base, "task:send:account", 1234567890000);
    const equivalents: MailInput[] = [
      { ...base, to: ["CLIENT@example.test", "client@example.test"] },
      { ...base, inReplyTo: "<previous@example.test>" },
      { ...base, references: ["<previous@example.test>"] },
      { ...base, references: [" \t< previous@example.test >\t "] },
      { ...base, text: "First line\r\nSecond line", html: "<p>First line</p>\r\n<p>Second line</p>" },
      { ...base, text: "First line\rSecond line", html: "<p>First line</p>\r<p>Second line</p>" },
      { ...base, cc: [], bcc: [], threadId: "" },
      { ...base, retryTag: "untrusted", raw: "untrusted", messageId: "<untrusted>" } as MailInput,
    ];
    for (const equivalent of equivalents) expect(await workspace.prepareMail(equivalent, "task:send:account", 1234567890000)).toEqual(expected);
    expect(Object.keys(expected).sort()).toEqual(["messageId", "raw"]);
    expect((await workspace.prepareMail(base, "task:send:account", 2345678900000)).messageId).toBe(expected.messageId);
    for (const changed of [{ ...base, text: "Changed authorized content" }, { ...base, to: ["other@example.test"] }, { ...base, threadId: "other-thread" }, { ...base, references: ["other@example.test"] }]) {
      expect((await workspace.prepareMail(changed, "task:send:account", 1234567890000)).messageId).not.toBe(expected.messageId);
    }
    expect((await workspace.prepareMail(base, "different-owner-task:send:account", 1234567890000)).messageId).not.toBe(expected.messageId);
  });
  it("collapses omitted and empty wire fields without retaining raw optional values", async () => {
    const workspace = new GoogleWorkspace({ request: async () => { throw new Error("Preparation must stay offline"); } });
    const base: MailInput = { to: ["client@example.test"], subject: "", text: "Body" };
    const expected = await workspace.prepareMail(base, "task:send:account");
    for (const fields of [{ references: [] }, { inReplyTo: "" }, { html: "" }, { attachments: [] }, { cc: [], bcc: [], threadId: "" }, { subject: " \t " }, { text: "Body\n" }, { text: "Body\r\n" }]) {
      expect(await workspace.prepareMail({ ...base, ...fields }, "task:send:account")).toEqual(expected);
    }
  });
  it("keeps missing Sent search unknown and never sends during reconciliation", async () => {
    const calls: GoogleRequest[] = [];
    const workspace = new GoogleWorkspace({ request: async (request) => { calls.push(request); return { status: 200, data: { messages: [] } }; } });
    const prepared = await workspace.prepareMail({ to: ["client@example.test"], subject: "Subject", text: "Body" }, "task:step");
    expect(await workspace.verifyMail(prepared)).toEqual({ verified: false, id: null });
    expect(calls.every((r) => r.method === "GET")).toBe(true);
  });
  it("verifies SENT content not provider success alone", async () => {
    let raw = "";
    const workspace = new GoogleWorkspace({ request: async () => ({ status: 200, data: { id: "m1", raw, labelIds: ["SENT"] } }) });
    const prepared = await workspace.prepareMail({ to: ["client@example.test"], subject: "Subject", text: "Body" }, "task:step");
    raw = prepared.raw;
    expect((await workspace.verifyMail(prepared, "m1")).verified).toBe(true);
    raw = (await workspace.prepareMail({ to: ["other@example.test"], subject: "Subject", text: "Body" }, "task:step")).raw;
    expect((await workspace.verifyMail(prepared, "m1")).verified).toBe(false);
  });
  it("uses stable event IDs, live freebusy and conditional writes", async () => {
    const calls: GoogleRequest[] = [];
    const transport: GoogleTransport = { request: async (r) => {
      calls.push(r);
      if (r.endpoint.endsWith("freeBusy")) return { status: 200, data: { calendars: { primary: { busy: [] } } } };
      if (r.method === "GET") return { status: 200, data: { id: "event", etag: "current" } };
      return { status: 412, data: {} };
    } };
    const workspace = new GoogleWorkspace(transport);
    const input: CalendarInput = { summary: "Meeting", start: { dateTime: "2026-11-02T10:00:00Z", timeZone: "UTC" }, end: { dateTime: "2026-11-02T11:00:00Z", timeZone: "UTC" }, attendees: [{ email: "client@example.test" }], sendUpdates: "all" };
    const prepared = workspace.prepareEvent(input, "task:step");
    expect(prepared.id).toMatch(/^[0-9a-v]{5,1024}$/);
    expect(workspace.prepareEvent(input, "task:step").id).toBe(prepared.id);
    await expect(workspace.insert("primary", prepared)).rejects.toThrow("412");
    expect(calls[0]?.endpoint.endsWith("freeBusy")).toBe(true);
    await expect(workspace.update("primary", "event", "stale", input)).rejects.toThrow("conflict");
    await expect(workspace.update("primary", "event", "current", input)).rejects.toThrow("412");
    expect(calls.at(-1)?.ifMatch).toBe("current");
    expect(calls.filter((r) => r.method === "POST" && r.endpoint.endsWith("events"))).toHaveLength(1);
  });
});
