import type { BusinessStore, Json } from "@open-instinct/core";
import { GoogleWorkspace, type GoogleData } from "./google-workspace.js";
import { GoogleProviderError } from "./google-transport.js";
interface IntakeCursor { activatedAt: number; historyId: string; pageToken: string | null; mode: "history" | "window"; baseline: string; openThreads: string[] }
/** Activation is explicit. Connecting a mailbox alone never creates this cursor. */
export class GmailIntake {
  constructor(private readonly store: BusinessStore, private readonly google: GoogleWorkspace, private readonly accountId: string) {}
  async activate(activatedAt: number, openThreads: string[] = []): Promise<void> {
    if (!Number.isSafeInteger(activatedAt) || activatedAt < 0) throw new Error("Invalid activation time");
    const id = `gmail-intake:${this.accountId}`;
    if (this.store.get("cursor", id)) throw new Error("Intake already activated");
    const profile = await this.google.profile();
    if (typeof profile.historyId !== "string") throw new Error("Gmail baseline unavailable");
    this.store.put<IntakeCursor>("cursor", id, { activatedAt, historyId: profile.historyId, pageToken: null, mode: "window", baseline: profile.historyId, openThreads }, null);
  }
  async sweep(admit: (event: { id: string; message: Json }) => Promise<void>, openThreads?: string[]): Promise<void> {
    const id = `gmail-intake:${this.accountId}`;
    let cursor = this.store.get<IntakeCursor>("cursor", id);
    if (!cursor) return;
    // The production caller supplies current account-bound work on every poll.
    // Replacing, rather than merging, drops closed work and stale account bindings.
    if (openThreads !== undefined) {
      const current = [...new Set(openThreads)].sort();
      if (current.length !== cursor.value.openThreads.length || current.some((thread, index) => thread !== cursor!.value.openThreads[index])) {
        cursor = this.store.put("cursor", id, { ...cursor.value, openThreads: current }, cursor.version);
      }
    }
    // Retry durable discoveries before fetching/advancing more pages.
    for (const pending of this.store.list<{ message: Json; admitted: boolean }>("cursor").filter((r) => r.id.startsWith(`gmail-message:${this.accountId}:`) && !r.value.admitted)) {
      await admit({ id: pending.id, message: pending.value.message });
      this.store.put("cursor", pending.id, { ...pending.value, admitted: true }, pending.version);
    }
    let page: GoogleData;
    try {
      page = cursor.value.mode === "history" ? await this.google.history(cursor.value.historyId, cursor.value.pageToken ?? undefined)
        : await this.google.messages({ q: `after:${Math.floor(cursor.value.activatedAt / 1000)} -in:sent -in:drafts -in:spam -in:trash`, maxResults: "100", ...(cursor.value.pageToken ? { pageToken: cursor.value.pageToken } : {}) });
    } catch (error) {
      if (!(error instanceof GoogleProviderError) || error.status !== 404 || cursor.value.mode !== "history") throw error;
      const baseline = await this.google.profile();
      if (typeof baseline.historyId !== "string") throw new Error("Gmail baseline unavailable");
      cursor = this.store.put("cursor", id, { ...cursor.value, mode: "window" as const, baseline: baseline.historyId, pageToken: null }, cursor.version);
      return;
    }
    const ids = new Set<string>();
    const direct = new Map<string, string>();
    for (const message of page.messages ?? []) if (typeof message.id === "string") ids.add(message.id);
    for (const history of page.history ?? []) for (const added of history.messagesAdded ?? []) if (typeof added.message?.id === "string") ids.add(added.message.id);
    for (const threadId of cursor.value.openThreads) {
      const thread = await this.google.thread(threadId);
      for (const message of thread.messages ?? []) if (typeof message.id === "string") {
        ids.add(message.id);
        direct.set(message.id, threadId);
      }
    }
    for (const messageId of ids) {
      const key = `gmail-message:${this.accountId}:${messageId}`;
      if (this.store.get("cursor", key)) continue;
      const message = await this.google.message(messageId);
      // Old messages are evidence for existing open work, never permission to
      // replay mailbox history as new requests. The routine admission boundary
      // remains responsible for rejecting pre-activation request creation.
      const openThreadEvidence = typeof message.threadId === "string" && direct.get(messageId) === message.threadId;
      if (!Number.isFinite(Number(message.internalDate)) || (Number(message.internalDate) < cursor.value.activatedAt && !openThreadEvidence) || (message.labelIds ?? []).some((label: string) => ["SENT", "DRAFT", "SPAM", "TRASH"].includes(label))) continue;
      const saved = this.store.put("cursor", key, { message: message as Json, admitted: false }, null);
      await admit({ id: key, message: saved.value.message });
      this.store.put("cursor", key, { ...saved.value, admitted: true }, saved.version);
    }
    const next = typeof page.nextPageToken === "string" ? page.nextPageToken : null;
    this.store.put("cursor", id, { ...cursor.value, pageToken: next, ...(next ? {} : { mode: "history", historyId: cursor.value.mode === "window" ? cursor.value.baseline : page.historyId ?? cursor.value.historyId }) }, cursor.version);
  }
}
