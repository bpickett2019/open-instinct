import { createHash } from "node:crypto";
import MailComposer from "nodemailer/lib/mail-composer";
import { simpleParser } from "mailparser";
import { GoogleProviderError, type GoogleRequest, type GoogleTransport } from "./google-transport.js";
import { businessHash } from "@open-instinct/core";

export interface GoogleData {
  [key: string]: unknown;
  id?: string; emailAddress?: string; historyId?: string; nextPageToken?: string; raw?: string; data?: string; threadId?: string;
  etag?: string; status?: string; summary?: string; description?: string; location?: string; internalDate?: string;
  labelIds?: string[]; messages?: GoogleData[]; history?: Array<{ messagesAdded?: Array<{ message?: GoogleData }> }>;
  start?: { dateTime: string; timeZone: string }; end?: { dateTime: string; timeZone: string };
  attendees?: Array<{ email: string }>; calendars?: Record<string, { errors?: unknown[]; busy: unknown[] }>;
}
export interface MailAttachment { filename: string; contentType: string; content: string; sha256: string }
export interface MailInput { from?: string; to: string[]; cc?: string[]; bcc?: string[]; subject: string; text: string; html?: string; threadId?: string; inReplyTo?: string; references?: string[]; attachments?: MailAttachment[] }
export interface PreparedMail { messageId: string; raw: string; threadId?: string }
export interface CalendarInput { summary: string; description?: string; location?: string; start: { dateTime: string; timeZone: string }; end: { dateTime: string; timeZone: string }; attendees: Array<{ email: string }>; sendUpdates: "all" | "externalOnly" | "none" }
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const CALENDAR = "https://www.googleapis.com/calendar/v3";
const segment = (value: string) => encodeURIComponent(value);
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function header(value: string): string { if (/[\r\n\0]/.test(value)) throw new Error("Invalid mail header"); return value; }
function address(value: string): string { header(value); if (!/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(value)) throw new Error("Invalid recipient"); return value.trim().toLowerCase(); }
function record(data: unknown): GoogleData {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid Google response");
  for (const name of ["id", "emailAddress", "historyId", "nextPageToken", "raw", "data", "threadId", "etag", "status", "summary", "description", "location", "internalDate"]) {
    if (name in data && typeof Reflect.get(data, name) !== "string") throw new Error(`Invalid Google ${name}`);
  }
  for (const name of ["messages", "history", "labelIds", "attendees"]) {
    if (name in data && !Array.isArray(Reflect.get(data, name))) throw new Error(`Invalid Google ${name}`);
  }
  return data as GoogleData;
}
export class GoogleWorkspace {
  constructor(readonly transport: GoogleTransport) {}
  async request(input: GoogleRequest): Promise<GoogleData> {
    const response = await this.transport.request(input);
    if (response.status < 200 || response.status >= 300) throw new GoogleProviderError(response.status);
    return response.status === 204 ? {} : record(response.data);
  }
  profile() { return this.request({ method: "GET", endpoint: `${GMAIL}/profile` }); }
  labels() { return this.request({ method: "GET", endpoint: `${GMAIL}/labels` }); }
  messages(query: Record<string, string> = {}) { return this.request({ method: "GET", endpoint: `${GMAIL}/messages`, query }); }
  history(startHistoryId: string, pageToken?: string) { return this.request({ method: "GET", endpoint: `${GMAIL}/history`, query: { startHistoryId, ...(pageToken ? { pageToken } : {}) } }); }
  message(id: string, format = "full") { return this.request({ method: "GET", endpoint: `${GMAIL}/messages/${segment(id)}`, query: { format } }); }
  thread(id: string) { return this.request({ method: "GET", endpoint: `${GMAIL}/threads/${segment(id)}` }); }
  threads(query: Record<string, string> = {}) { return this.request({ method: "GET", endpoint: `${GMAIL}/threads`, query }); }
  async attachment(messageId: string, attachmentId: string): Promise<Buffer> {
    const result = await this.request({ method: "GET", endpoint: `${GMAIL}/messages/${segment(messageId)}/attachments/${segment(attachmentId)}` });
    if (typeof result.data !== "string") throw new Error("Missing attachment bytes");
    if (result.data.length > Math.ceil(20 * 1024 * 1024 / 3) * 4) throw new Error("Attachment exceeds 20 MiB");
    return Buffer.from(result.data, "base64url");
  }
  async prepareMail(input: MailInput, stableKey: string, preparedAt = 0): Promise<PreparedMail> {
    // Normalize text line endings before the serializer chooses transfer encodings.
    const normalized: MailInput = { to: [...new Set(input.to.map(address))].sort(), subject: input.subject, text: input.text.replace(/\r\n?/g, "\n"),
      ...(input.cc?.length ? { cc: [...new Set(input.cc.map(address))].sort() } : {}), ...(input.bcc?.length ? { bcc: [...new Set(input.bcc.map(address))].sort() } : {}),
      ...(input.html ? { html: input.html.replace(/\r\n?/g, "\n") } : {}),
      ...(input.inReplyTo ? { inReplyTo: input.inReplyTo } : {}), ...(input.references ? { references: input.references } : {}) };
    if (!normalized.to.length) throw new Error("Recipient required");
    if (input.from) normalized.from = address(input.from);
    header(input.subject);
    if (input.inReplyTo) header(input.inReplyTo);
    input.references?.forEach(header);
    const attachments = (input.attachments ?? []).map((attachment) => {
      header(attachment.filename); header(attachment.contentType);
      if (attachment.content.length > Math.ceil(20 * 1024 * 1024 / 3) * 4) throw new Error("Attachment exceeds 20 MiB");
      const content = Buffer.from(attachment.content, "base64");
      if (hash(content) !== attachment.sha256) throw new Error("Attachment hash mismatch");
      return { filename: attachment.filename, contentType: attachment.contentType, content };
    });
    const compose = async (messageId: string, baseBoundary: string, date: number) => {
      const mime = new MailComposer({ ...normalized, attachments, messageId, baseBoundary, date: new Date(date),
        newline: "win", disableFileAccess: true, disableUrlAccess: true }).compile();
      mime.keepBcc = true;
      return mime.build();
    };
    // Nodemailer 10.2.1 owns header/encoding normalization. Hash its actual bytes,
    // with fixed generated fields, rather than trying to duplicate that contract.
    const canonical = await compose("<canonical@business.open-instinct.invalid>", "business-canonical", 0);
    const thread = input.threadId ? { threadId: input.threadId } : {};
    const identity = businessHash({ occurrence: stableKey, wireSha256: hash(canonical), ...thread });
    const messageId = `<${identity}@business.open-instinct.invalid>`;
    const raw = await compose(messageId, identity, preparedAt);
    // The dispatcher hashes every prepared field: never reintroduce raw inputs here.
    return { ...thread, messageId, raw: raw.toString("base64url") };
  }
  send(input: PreparedMail) { return this.request({ method: "POST", endpoint: `${GMAIL}/messages/send`, body: { raw: input.raw, ...(input.threadId ? { threadId: input.threadId } : {}) } }); }
  async verifyMail(input: PreparedMail, providerId?: string): Promise<{ verified: boolean; id: string | null }> {
    let id = providerId;
    if (!id) {
      const found = await this.messages({ q: `in:sent rfc822msgid:${input.messageId}`, maxResults: "100" });
      if (!Array.isArray(found.messages) || found.messages.length !== 1 || found.nextPageToken) return { verified: false, id: null };
      id = found.messages[0]?.id;
    }
    if (!id) return { verified: false, id: null };
    const actual = await this.message(id, "raw");
    if (!actual.labelIds?.includes("SENT") || typeof actual.raw !== "string") return { verified: false, id };
    const parsed = await simpleParser(Buffer.from(actual.raw, "base64url"), { skipHtmlToText: true, skipTextToHtml: true });
    const expected = await simpleParser(Buffer.from(input.raw, "base64url"), { skipHtmlToText: true, skipTextToHtml: true });
    const recipients = (v: typeof parsed.to) => (Array.isArray(v) ? v.flatMap((a) => a.value) : v?.value ?? []).map((a) => a.address?.toLowerCase()).sort();
    const attachments = (p: typeof parsed) => p.attachments.map((a) => `${a.filename}:${a.contentType}:${hash(a.content)}`).sort();
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    return { id, verified: parsed.messageId === input.messageId && parsed.subject === expected.subject && parsed.text === expected.text && parsed.html === expected.html
      && same(recipients(parsed.from), recipients(expected.from)) && same(recipients(parsed.to), recipients(expected.to)) && same(recipients(parsed.cc), recipients(expected.cc))
      && same(recipients(parsed.bcc), recipients(expected.bcc)) && parsed.inReplyTo === expected.inReplyTo && same(parsed.references, expected.references)
      && same(attachments(parsed), attachments(expected)) && (!input.threadId || actual.threadId === input.threadId) };
  }
  calendars() { return this.request({ method: "GET", endpoint: `${CALENDAR}/users/me/calendarList` }); }
  calendar(id: string) { return this.request({ method: "GET", endpoint: `${CALENDAR}/calendars/${segment(id)}` }); }
  events(id: string, query: Record<string, string> = {}) { return this.request({ method: "GET", endpoint: `${CALENDAR}/calendars/${segment(id)}/events`, query }); }
  event(calendarId: string, id: string) { return this.request({ method: "GET", endpoint: `${CALENDAR}/calendars/${segment(calendarId)}/events/${segment(id)}` }); }
  freebusy(calendarId: string, start: string, end: string, timeZone: string) { return this.request({ method: "POST", endpoint: `${CALENDAR}/freeBusy`, body: { timeMin: start, timeMax: end, timeZone, items: [{ id: calendarId }] } }); }
  prepareEvent(input: CalendarInput, stableKey: string) {
    for (const value of [input.start, input.end]) {
      const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: value.timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
      if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value.dateTime) || !Number.isFinite(Date.parse(value.dateTime))) throw new Error("Calendar requires explicit offset and timezone");
      const parts = Object.fromEntries(formatter.formatToParts(new Date(value.dateTime)).map((part) => [part.type, part.value]));
      const local = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
      if (local !== value.dateTime.slice(0, 19)) throw new Error("Calendar offset does not match timezone");
    }
    if (Date.parse(input.start.dateTime) >= Date.parse(input.end.dateTime)) throw new Error("Invalid event duration");
    if (!["all", "externalOnly", "none"].includes(input.sendUpdates)) throw new Error("Notification intent required");
    const normalized = { summary: input.summary, ...(input.description ? { description: input.description } : {}), ...(input.location ? { location: input.location } : {}),
      start: { dateTime: input.start.dateTime, timeZone: input.start.timeZone }, end: { dateTime: input.end.dateTime, timeZone: input.end.timeZone },
      sendUpdates: input.sendUpdates, attendees: [...new Set(input.attendees.map(a => address(a.email)))].sort().map(email => ({ email })) };
    return { ...normalized, id: businessHash({ occurrence: stableKey, event: normalized }) };
  }
  async insert(calendarId: string, input: CalendarInput & { id: string }) {
    const busy = await this.freebusy(calendarId, input.start.dateTime, input.end.dateTime, input.start.timeZone);
    const calendar = busy.calendars?.[calendarId];
    if (!calendar || calendar.errors?.length || !Array.isArray(calendar.busy)) throw new Error("Availability unavailable");
    if (calendar.busy.length) throw new Error("Calendar availability conflict");
    const { sendUpdates, ...body } = input;
    return this.request({ method: "POST", endpoint: `${CALENDAR}/calendars/${segment(calendarId)}/events`, query: { sendUpdates }, body });
  }
  async update(calendarId: string, id: string, etag: string, input: CalendarInput) {
    if (!etag) throw new Error("Current etag required");
    const current = await this.event(calendarId, id);
    if (current.etag !== etag) throw new Error("Calendar etag conflict");
    const availability = await this.freebusy(calendarId, input.start.dateTime, input.end.dateTime, input.start.timeZone);
    const busy = availability.calendars?.[calendarId];
    if (!busy || busy.errors?.length || !Array.isArray(busy.busy)) throw new Error("Availability unavailable");
    if (busy.busy.length && (current.start?.dateTime !== input.start.dateTime || current.end?.dateTime !== input.end.dateTime)) {
      let pageToken: string | undefined;
      do {
        const page = await this.events(calendarId, { timeMin: input.start.dateTime, timeMax: input.end.dateTime, singleEvents: "true", ...(pageToken ? { pageToken } : {}) });
        if (!Array.isArray(page.items)) throw new Error("Availability details unavailable");
        if (page.items.some((item: unknown) => !item || typeof item !== "object" || !("id" in item) || item.id !== id)) throw new Error("Calendar availability conflict");
        pageToken = page.nextPageToken;
      } while (pageToken);
    }
    const { sendUpdates, ...body } = input;
    return this.request({ method: "PUT", endpoint: `${CALENDAR}/calendars/${segment(calendarId)}/events/${segment(id)}`, ifMatch: etag, query: { sendUpdates }, body });
  }
  cancel(calendarId: string, id: string, etag: string, sendUpdates: string) {
    if (!etag || !["all", "externalOnly", "none"].includes(sendUpdates)) throw new Error("Current etag and notification intent required");
    return this.request({ method: "DELETE", endpoint: `${CALENDAR}/calendars/${segment(calendarId)}/events/${segment(id)}`, ifMatch: etag, query: { sendUpdates } });
  }
  async verifyEvent(calendarId: string, id: string, expected: CalendarInput | null): Promise<boolean> {
    let actual: GoogleData;
    try { actual = await this.event(calendarId, id); } catch (error) { if (expected === null && error instanceof GoogleProviderError && [404, 410].includes(error.status)) return true; throw error; }
    if (expected === null) return actual.status === "cancelled";
    const emails = (items: Array<{ email: string }>) => items.map((a) => a.email.toLowerCase()).sort().join(",");
    return actual.status !== "cancelled" && actual.id === id && actual.summary === expected.summary && (actual.description ?? "") === (expected.description ?? "")
      && (actual.location ?? "") === (expected.location ?? "") && Date.parse(actual.start?.dateTime ?? "") === Date.parse(expected.start.dateTime)
      && Date.parse(actual.end?.dateTime ?? "") === Date.parse(expected.end.dateTime) && actual.start?.timeZone === expected.start.timeZone && actual.end?.timeZone === expected.end.timeZone
      && emails(actual.attendees ?? []) === emails(expected.attendees);
  }
}
