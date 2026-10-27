import { businessHash } from "@open-instinct/core";
import type { BusinessStore, OutboundMessage, Outbox } from "@open-instinct/core";

/** Covers runtime, network fallback and core-tool sends outside dedicated provider adapters. */
export class BusinessOutbox implements Outbox {
  constructor(private readonly store: BusinessStore, private readonly inner: Outbox, private readonly redact: <T>(value: T) => T = value => value) {}
  async send(message: OutboundMessage, context: Parameters<Outbox["send"]>[1]): Promise<void> {
    message = this.redact(message);
    if (context.notificationId) {
      const record = this.store.get<{ text: string; status: string }>("notification", context.notificationId);
      if (!record || record.value.text !== message.text || record.value.status !== "dispatching") throw new Error("Outbound notification does not match its committed record");
      return this.inner.send(message, context);
    }
    const taskId = context.conversationKey.startsWith("system:business:") ? context.conversationKey.slice("system:business:".length) : null;
    const task = taskId ? this.store.task(taskId) : undefined;
    if (taskId && (!task || task.status !== "running" || this.store.settings().value.stopped)) throw new Error("Outbound task is stopped or no longer active");
    if (taskId && !context.assertBusinessDispatch) throw new Error("Task sends require a final dispatcher boundary");
    context.signal?.throwIfAborted(); context.assertBusinessDispatch?.();
    const route = { channel: message.channel, thread: message.conversationKey ?? context.conversationKey, to: message.to ?? null };
    if (!context.messageId) throw new Error("A stable logical message identity is required for business transport");
    const id = `transport:${businessHash({ messageId: context.messageId, principal: context.principal.id, route })}`;
    const prior = this.store.get<{ text: string; status: string }>("notification", id);
    if (prior) {
      if (prior.value.text !== message.text) throw new Error("Logical outbound message content changed");
      if (prior.value.status === "accepted" || prior.value.status === "browser-buffered") return;
      throw new Error("Prior notification acceptance is unknown; never automatically resend");
    }
    const record = this.store.put("notification", id, { id, taskId, route, text: message.text, status: "dispatching", at: this.store.now() }, null);
    // Browser projection is independent of whether a carrier accepts or delivers a message.
    if (context.principal.kind === "owner" && context.principal.tier === "owner" && !context.principal.cappedFrom) this.store.appendMessage({ id, channel: message.channel, thread: route.thread, role: "assistant", text: message.text, taskId, artifactIds: [], at: this.store.now() });
    try {
      await this.inner.send(message, { ...context, notificationId: id });
      this.store.put("notification", id, { ...record.value, status: message.channel === "chat" ? "browser-buffered" : "accepted", delivery: "unconfirmed" }, record.version);
    } catch (error) {
      this.store.put("notification", id, { ...record.value, status: "unknown", delivery: "unconfirmed" }, record.version);
      throw error;
    }
  }
  async typing(conversationKey: string, options?: Parameters<NonNullable<Outbox["typing"]>>[1]): Promise<void> { await this.inner.typing?.(conversationKey, options); }
  async markRead(conversationKey: string, options?: Parameters<NonNullable<Outbox["markRead"]>>[1]): Promise<void> {
    if (!this.inner.markRead) throw new Error("Read receipts are unavailable");
    await this.inner.markRead(conversationKey, options);
  }
  async react(conversationKey: string, messageId: string, reaction: string, options?: Parameters<NonNullable<Outbox["react"]>>[3]): Promise<void> {
    if (!this.inner.react) throw new Error("Reactions are unavailable");
    await this.inner.react(conversationKey, messageId, reaction, options);
  }
}
