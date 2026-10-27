import type { BusinessStore } from "@open-instinct/core";
import { BusinessProfile } from "./business-profile.js";
import type { OwnerConnections } from "./workspace-http.js";

const APPS = [
  { toolkit: "gmail", name: "Gmail", purpose: "Read the email you ask about and send business messages on your behalf." },
  { toolkit: "googlecalendar", name: "Google Calendar", purpose: "Check availability and manage the appointments you ask for." },
] as const;
type PendingConnection = { toolkit: string; status: "waiting" | "verified" | "cancelled"; accountId: string | null };
export interface OnboardingSnapshot {
  profile: ReturnType<BusinessProfile["current"]>;
  apps: Array<{ toolkit: string; name: string; purpose: string; status: "setup_required" | "available" | "waiting" | "connected" | "unavailable"; identity: string | null }>;
  computer: { status: "ready" | "setup_required"; description: string };
  nextQuestion: { key: string; question: string } | null;
  canContinue: true;
}

/** One owner-only view for text and web. Readiness is not permission to scan accounts. */
export class BusinessOnboarding {
  private latest: OnboardingSnapshot | undefined;
  private checking: Promise<void> | undefined;
  constructor(private readonly store: BusinessStore, private readonly connections: OwnerConnections | undefined, private readonly computerReady: () => boolean, private readonly notify: (id: string, text: string) => Promise<void>) {}

  async snapshot(): Promise<OnboardingSnapshot> {
    let accounts: Awaited<ReturnType<OwnerConnections["list"]>> = [];
    let unavailable = false;
    if (this.connections) {
      try { accounts = await this.connections.list(); }
      catch { unavailable = true; }
    }
    const profile = new BusinessProfile(this.store).current();
    const apps: OnboardingSnapshot["apps"] = APPS.map(app => {
      const account = accounts.find(item => item.toolkit === app.toolkit && item.status === "connected" && item.verifiedAt !== null);
      const pending = this.store.get<PendingConnection>("cursor", `onboarding:connect:${app.toolkit}`);
      const cancelled = this.store.get<{ cancelled?: boolean }>("cursor", `connect:${app.toolkit}`)?.value.cancelled;
      return { ...app, status: !this.connections ? "setup_required" : unavailable ? "unavailable" : account ? "connected" : pending?.value.status === "waiting" && !cancelled ? "waiting" : "available", identity: account?.identity ?? null };
    });
    const ready = this.computerReady();
    this.latest = { profile, apps, computer: { status: ready ? "ready" : "setup_required", description: ready ? "An isolated computer is available for website and document work. Private sign-in is requested only when needed." : "Website sign-ins and office-computer work need the hosted computer enabled by the operator. We can keep setting up your business without it." }, nextQuestion: profile.nextQuestion, canContinue: true };
    return this.latest;
  }

  async connect(toolkit: string): Promise<{ url: string | null; status: "waiting" | "connected" | "setup_required"; message: string }> {
    if (!this.connections) return { url: null, status: "setup_required", message: "Email and calendar sign-in is not enabled on this installation yet. The operator needs to enable the app connection service. No password or API key belongs in this chat. We can keep setting up your business meanwhile." };
    const account = (await this.connections.list()).find(item => item.toolkit === toolkit && item.status === "connected" && item.verifiedAt !== null);
    if (account) return { url: null, status: "connected", message: `${toolkit} is already connected as ${account.identity}. To change accounts, disconnect this account first in Connections.` };
    const result = await this.connections.connect(toolkit);
    const id = `onboarding:connect:${toolkit}`;
    const prior = this.store.get<PendingConnection>("cursor", id);
    this.store.put("cursor", id, { toolkit, status: "waiting", accountId: null }, prior?.version ?? null);
    return { ...result, status: "waiting", message: result.url ? "Open this sign-in link and choose the account you want me to use. I will check the connection automatically; you do not need to reply done. Connecting does not enable routines or scan old messages." : "I am checking the account connection. A missing link does not mean sign-in succeeded." };
  }

  /** Called by the existing coordinator sweep, not a second scheduler or assistant. */
  checkPending(): Promise<void> {
    if (this.checking) return this.checking;
    this.checking = this.verifyPending().finally(() => { this.checking = undefined; });
    return this.checking;
  }
  private async verifyPending(): Promise<void> {
    const pending = this.store.list<PendingConnection>("cursor").filter(row => row.id.startsWith("onboarding:connect:") && row.value.status === "waiting");
    if (!pending.length || !this.connections) return;
    let accounts: Awaited<ReturnType<OwnerConnections["list"]>>;
    try { accounts = await this.connections.list(); } catch { return; }
    for (const row of pending) {
      if (this.store.get<{ cancelled?: boolean }>("cursor", `connect:${row.value.toolkit}`)?.value.cancelled) {
        const current = this.store.get<PendingConnection>("cursor", row.id);
        if (current?.version === row.version) this.store.put("cursor", row.id, { ...row.value, status: "cancelled" }, row.version);
        continue;
      }
      const account = accounts.find(item => item.toolkit === row.value.toolkit && item.status === "connected" && item.verifiedAt !== null);
      if (!account) continue;
      const current = this.store.get<PendingConnection>("cursor", row.id);
      if (!current || current.version !== row.version) continue;
      const name = APPS.find(app => app.toolkit === row.value.toolkit)?.name ?? row.value.toolkit;
      const next = new BusinessProfile(this.store).current().nextQuestion?.question ?? "What would you like me to help with first?";
      await this.notify(`onboarding-connected:${row.id}:${row.version}`, `${name} is connected as ${account.identity}. I have not enabled any routines or scanned old messages. ${next}`);
      const after = this.store.get<PendingConnection>("cursor", row.id);
      if (after?.version === row.version) this.store.put("cursor", row.id, { toolkit: row.value.toolkit, status: "verified", accountId: account.accountId }, after.version);
    }
  }

  context(): string {
    const profile = new BusinessProfile(this.store).current();
    return `## Assistant-led onboarding\nYou are the assistant inside the owner's app and text thread. Lead a natural conversation, not a setup questionnaire. On a first greeting with no business facts, introduce yourself briefly and ask what business you are helping with. On later turns, acknowledge what the owner actually said, save all explicit business facts together with business_profile_save, then choose one useful follow-up based on their situation and goals. The missing-profile question below is only a completeness hint: do not recite fields in order, ask for facts already known, or require irrelevant details before being useful. If the owner says what they need help with, follow that thread rather than restarting setup. If they ask a question or change direction, answer them first. Do not treat an entire free-form reply as the answer to one field; distinguish business name, services, location and rules. Do not invent facts, infer authorization, or promote a suggestion into policy. Existing facts survive texting, browser use and restarts. Offer Gmail and Calendar when they help the owner's goal, explain the benefit, and use apps_connect after the owner chooses to connect. OAuth is private owner intervention, not an action approval. Never invent a sign-in URL, claim a pending connection succeeded, ask for secrets in chat, or make the owner type done/sent. Pending connections are checked automatically; business_connections or business_onboarding checks actual provider state. Missing infrastructure is an operator setup blocker, not an owner form. Explain an unavailable capability only when relevant and continue the conversation; do not prescribe environment variables or provider dashboards unless explicitly asked for operator instructions. Never describe task IDs, persistence, webhook machinery or acceptance rules in a greeting. Use task IDs when actual delegated work needs tracking. Connecting never enables routines or historic scans.\nMissing-profile hint: ${JSON.stringify(profile.nextQuestion)}\nConnection readiness: ${JSON.stringify(this.latest ? { apps: this.latest.apps, computer: this.latest.computer } : { status: "not_checked", instruction: "Call business_onboarding before discussing connection readiness." })}`;
  }
}
