import fs from "node:fs";
import { describe, expect, it } from "vitest";
import type { RegisteredTool } from "@open-instinct/core";
import { CredentialVault, credentialScope } from "@open-instinct/core";
import type { CreateSpendRequestParams, LinkClientLike, PaymentMethod, SpendRequest } from "../src/link-types.js";
import { MIN_CONTEXT_CHARS, PAYMENTS_FILE, buildContext, paymentsTools, pickPaymentMethod, readPayments, toCents } from "../src/tools.js";
import { LinkWallet, TOKENS_FILE, writeSecret } from "../src/wallet.js";
import { NOW, ctxFor, fakeAudit, fakeOutbox, friend, isError, owner, tempState, testConfig, textOf, walletOpts, type TestState } from "./helpers.js";
import { paymentsGuidance } from "../src/guidance.js";

const CARD_NUMBER = "4000009990001984";
const APPROVAL_URL = "https://link.com/approve/abc123";

const methods: PaymentMethod[] = [
  { id: "pm_first", type: "card", is_default: false, name: "Visa 1111" },
  { id: "pm_default", type: "card", is_default: true, name: "Amex 2222" },
];

function spendRequest(overrides: Partial<SpendRequest> = {}): SpendRequest {
  return { id: "lsrq_1", status: "created", amount: 2599, currency: "usd", created_at: NOW.toISOString(), updated_at: NOW.toISOString(), ...overrides };
}

function approvedWithCard(): SpendRequest {
  return spendRequest({
    status: "approved",
    card: {
      id: "card_1",
      brand: "visa",
      number: CARD_NUMBER,
      exp_month: 3,
      exp_year: 2029,
      cvc: "123",
      billing_address: { name: "Maria G", line1: "1 Main St", city: "Boston", state: "MA", postal_code: "02110", country: "US" },
      valid_until: "2026-10-03T16:00:00Z",
    },
  });
}

interface StubLink {
  client: LinkClientLike;
  calls: { list: number; create: CreateSpendRequestParams[]; approval: string[]; retrieve: Array<{ id: string; opts: { include?: string[] } | undefined }> };
  retrieveAnswer: (id: string) => SpendRequest | null;
}

function stubLink(opts: { methods?: PaymentMethod[] } = {}): StubLink {
  const calls: StubLink["calls"] = { list: 0, create: [], approval: [], retrieve: [] };
  const stub: StubLink = {
    calls,
    retrieveAnswer: () => spendRequest({ status: "pending_approval" }),
    client: {
      paymentMethods: {
        list: async () => {
          calls.list += 1;
          return opts.methods ?? methods;
        },
      },
      spendRequests: {
        create: async (params) => {
          calls.create.push(params);
          return spendRequest({ context: params.context, merchant_name: params.merchant_name });
        },
        requestApproval: async (id) => {
          calls.approval.push(id);
          return { id, approval_url: APPROVAL_URL };
        },
        retrieve: async (id, o) => {
          calls.retrieve.push({ id, opts: o });
          return stub.retrieveAnswer(id);
        },
      },
      approvalPolicy: { retrieve: async () => ({ rules: [] }) },
    },
  };
  return stub;
}

function connect(state: TestState): void {
  writeSecret(state.path(...TOKENS_FILE), { accessToken: "at", refreshToken: "rt", expiresAt: new Date(NOW.getTime() + 3600_000).toISOString(), obtainedAt: NOW.toISOString() });
}

function setup(opts: { connected?: boolean; phone?: boolean; methods?: PaymentMethod[] } = {}) {
  const state = tempState();
  if (opts.connected !== false) connect(state);
  const link = stubLink(opts.methods ? { methods: opts.methods } : {});
  const wallet = new LinkWallet(walletOpts(state, { linkFactory: () => link.client }));
  const { outbox, sent } = fakeOutbox();
  const { audit, entries } = fakeAudit();
  const config = testConfig(opts.phone === false ? { phones: [] } : {});
  const vault = new CredentialVault(() => NOW.getTime());
  const tools = paymentsTools({ wallet, outbox, config, audit, state, credentialVault: vault, workspaceId: "workspace-test" });
  const byName = new Map(tools.map((t) => [t.spec.name, t]));
  const run = async (name: string, args: unknown, principal = owner) => {
    const tool = byName.get(name);
    if (!tool) throw new Error(`no tool ${name}`);
    return tool.spec.execute(args, ctxFor(principal));
  };
  const records = () => readPayments(state).requests;
  const paymentsText = () => (state.exists(PAYMENTS_FILE) ? fs.readFileSync(state.path(PAYMENTS_FILE), "utf8") : "");
  return { state, link, wallet, tools, byName, run, outbox, sent, entries, records, paymentsText, config, vault };
}

const GOOD_REQUEST = { amountUsd: 25.99, merchantName: "Acme", merchantUrl: "https://acme.example/checkout", context: "Two pairs of wool socks Maria asked for this morning" };

function gate() {
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  return { entered: entered.promise, release: released.resolve, wait: async () => { entered.resolve(); await released.promise; } };
}

describe("paymentsTools registry", () => {
  it("exposes the four tools in group apps with the purchase capability", () => {
    const { tools } = setup();
    const summary = Object.fromEntries(tools.map((t: RegisteredTool) => [t.spec.name, [t.spec.meta.group, ...t.spec.meta.capabilities]]));
    expect(summary).toEqual({
      payment_connect: ["apps", "purchase"],
      payment_request: ["apps", "purchase"],
      payment_status: ["apps", "purchase"],
      payment_list: ["apps", "purchase"],
    });
  });

  it("reports the amount of a payment_request to the policy engine and zero for the others", () => {
    const { byName } = setup();
    expect(byName.get("payment_request")!.spec.meta.amountUsd?.({ amountUsd: 42.5 })).toBe(42.5);
    expect(byName.get("payment_request")!.spec.meta.amountUsd?.({ amountUsd: "42" })).toBeUndefined();
    expect(byName.get("payment_request")!.spec.meta.describe?.({ amountUsd: 42.5, merchantName: "Acme" })).toBe("pay Acme $42.50");
    for (const name of ["payment_connect", "payment_status", "payment_list"]) {
      expect(byName.get(name)!.spec.meta.amountUsd?.({})).toBe(0);
    }
    // payment_request is counted by the runtime when it runs (a hold within the daily limit);
    // the other tools carry no amount and must not add empty spend entries of their own.
    expect(byName.get("payment_request")!.spec.meta.recordsOwnSpend).toBeFalsy();
    for (const name of ["payment_connect", "payment_status", "payment_list"]) expect(byName.get(name)!.spec.meta.recordsOwnSpend, name).toBe(true);
  });
});

describe("payment_connect", () => {
  it("texts the owner the authorize URL and never a secret", async () => {
    const { run, sent, state, entries, wallet } = setup({ connected: false });
    const result = await run("payment_connect", {});
    expect(isError(result)).toBe(false);
    expect(textOf(result)).toContain("Sent to Maria by iMessage");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.msg.channel).toBe("imessage");
    expect(sent[0]!.msg.to).toBe("+16175550100");
    const url = sent[0]!.msg.text.match(/https:\/\/\S+/)?.[0];
    expect(url).toBeDefined();
    const u = new URL(url!);
    expect(u.origin + u.pathname).toBe("https://login.link.com/auth");
    expect(u.searchParams.get("client_id")).toBe("client_123");
    expect(sent[0]!.msg.text).not.toContain("secret_456");
    expect(fs.existsSync(wallet.pendingPath())).toBe(true);
    expect(fs.existsSync(state.path("secrets", "link-oauth.json"))).toBe(true);
    expect(entries).toEqual([{ kind: "outbound", conversationKey: "imessage:t", principal: "owner", detail: expect.objectContaining({ channel: "imessage", to: "+16175550100", via: "payment_connect" }) }]);
  });

  it("refuses anyone but the owner", async () => {
    const { run, sent, wallet } = setup({ connected: false });
    const result = await run("payment_connect", {}, friend);
    expect(isError(result)).toBe(true);
    expect(textOf(result)).toMatch(/Only the owner/);
    expect(sent).toHaveLength(0);
    expect(fs.existsSync(wallet.pendingPath())).toBe(false);
  });

  it("returns the URL in the result when the owner has no phone", async () => {
    const { run, sent } = setup({ connected: false, phone: false });
    const result = await run("payment_connect", {});
    expect(sent).toHaveLength(0);
    expect(textOf(result)).toContain("https://login.link.com/auth?");
  });

  it("says when a wallet is already connected", async () => {
    const { run } = setup();
    expect(textOf(await run("payment_connect", {}))).toContain("already connected");
  });
});

describe("payment_request", () => {
  it("creates a spend request on the default method, asks for approval, records it and texts the owner", async () => {
    const { run, link, sent, records, paymentsText } = setup();
    const result = await run("payment_request", { ...GOOD_REQUEST, idempotencyKey: "idem-1" });

    expect(isError(result)).toBe(false);
    const text = textOf(result);
    expect(text).toContain("lsrq_1");
    expect(text).toContain("waiting for approval");
    expect(text).toContain("payment_status");
    expect(text).not.toContain(APPROVAL_URL);

    expect(link.calls.list).toBe(1);
    expect(link.calls.create).toHaveLength(1);
    const params = link.calls.create[0]!;
    expect(params).toMatchObject({
      payment_details: "pm_default",
      credential_type: "card",
      amount: 2599,
      currency: "usd",
      merchant_name: "Acme",
      merchant_url: "https://acme.example/checkout",
      idempotency_key: "idem-1",
    });
    expect(params.context.length).toBeGreaterThanOrEqual(MIN_CONTEXT_CHARS);
    expect(params.context).toContain("Acme");
    expect(params.context).toContain("$25.99");
    expect(params.context).toContain("wool socks");
    expect(params.context).toContain("Maria");
    expect(link.calls.approval).toEqual(["lsrq_1"]);

    expect(records()).toEqual([
      {
        spendRequestId: "lsrq_1",
        amountUsd: 25.99,
        merchantName: "Acme",
        merchantUrl: "https://acme.example/checkout",
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
        status: "pending_approval",
        requestedBy: "owner",
        conversationKey: "imessage:t",
        cardDelivered: false,
      },
    ]);
    expect(paymentsText()).not.toContain(APPROVAL_URL);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.msg).toMatchObject({ channel: "imessage", to: "+16175550100" });
    expect(sent[0]!.msg.text).toContain("$25.99");
    expect(sent[0]!.msg.text).toContain("Acme");
    expect(sent[0]!.msg.text).toContain(APPROVAL_URL);
    expect(sent[0]!.msg.text).toContain("10 minutes");
  });

  it("omits optional fields it was not given", async () => {
    const { run, link, records } = setup();
    await run("payment_request", { amountUsd: 10, merchantName: "Corner Store", context: "Milk and bread for the week, as asked" });
    const params = link.calls.create[0]!;
    expect("merchant_url" in params).toBe(false);
    expect("idempotency_key" in params).toBe(false);
    expect("merchantUrl" in records()[0]!).toBe(false);
  });

  it("pads a short context past Link's 100 character minimum", async () => {
    const { run, link } = setup();
    await run("payment_request", { amountUsd: 5, merchantName: "A", context: "gum" });
    expect(link.calls.create[0]!.context.length).toBeGreaterThanOrEqual(MIN_CONTEXT_CHARS);
    expect(link.calls.create[0]!.context).toContain("gum");
  });

  it("names the requester when someone other than the owner asks", async () => {
    const { run, sent, records } = setup();
    await run("payment_request", GOOD_REQUEST, friend);
    expect(sent[0]!.msg.text).toContain("asked for by Alex Kim");
    expect(records()[0]!.requestedBy).toBe("contact:alex-kim");
  });

  it("hands the approval link to the model when the owner has no phone", async () => {
    const { run, sent } = setup({ phone: false });
    const text = textOf(await run("payment_request", GOOD_REQUEST));
    expect(sent).toHaveLength(0);
    expect(text).toContain(APPROVAL_URL);
    expect(text).toContain("no phone on file");
  });

  it("falls back to the first payment method when none is default", async () => {
    const { run, link } = setup({ methods: [{ id: "pm_only", type: "card", is_default: false, name: "Visa" }] });
    await run("payment_request", GOOD_REQUEST);
    expect(link.calls.create[0]!.payment_details).toBe("pm_only");
  });

  it("stops before creating anything when the wallet has no payment method", async () => {
    const { run, link, sent, records } = setup({ methods: [] });
    const result = await run("payment_request", GOOD_REQUEST);
    expect(isError(result)).toBe(true);
    expect(textOf(result)).toMatch(/no payment method/);
    expect(link.calls.create).toHaveLength(0);
    expect(sent).toHaveLength(0);
    expect(records()).toHaveLength(0);
  });

  it("refuses when no wallet is connected", async () => {
    const { run, link } = setup({ connected: false });
    const result = await run("payment_request", GOOD_REQUEST);
    expect(isError(result)).toBe(true);
    expect(textOf(result)).toMatch(/payment_connect/);
    expect(link.calls.list).toBe(0);
  });

  it("rejects bad amounts, merchants, URLs and empty context without touching Link", async () => {
    const { run, link } = setup();
    const bad: Array<Record<string, unknown>> = [
      { ...GOOD_REQUEST, amountUsd: 0 },
      { ...GOOD_REQUEST, amountUsd: -5 },
      { ...GOOD_REQUEST, amountUsd: 0.004 },
      { ...GOOD_REQUEST, amountUsd: Number.NaN },
      { ...GOOD_REQUEST, amountUsd: 1e9 },
      { ...GOOD_REQUEST, amountUsd: "25" },
      { ...GOOD_REQUEST, merchantName: "   " },
      { ...GOOD_REQUEST, merchantUrl: "acme.example" },
      { ...GOOD_REQUEST, merchantUrl: "javascript:alert(1)" },
      { ...GOOD_REQUEST, context: "   " },
    ];
    for (const args of bad) {
      const result = await run("payment_request", args);
      expect(isError(result), JSON.stringify(args)).toBe(true);
    }
    expect(link.calls.list).toBe(0);
    expect(link.calls.create).toHaveLength(0);
  });

  it("rounds to whole cents", async () => {
    const { run, link, records } = setup();
    await run("payment_request", { ...GOOD_REQUEST, amountUsd: 19.999 });
    expect(link.calls.create[0]!.amount).toBe(2000);
    expect(records()[0]!.amountUsd).toBe(20);
  });
});

describe("payment_status", () => {
  async function requested() {
    const s = setup();
    await s.run("payment_request", GOOD_REQUEST);
    s.sent.length = 0;
    s.entries.length = 0;
    return s;
  }

  it("rejects ids it did not create", async () => {
    const { run, link } = await requested();
    const result = await run("payment_status", { spendRequestId: "lsrq_other" });
    expect(isError(result)).toBe(true);
    expect(link.calls.retrieve).toHaveLength(0);
  });

  it("refuses another principal or conversation before retrieving credentials", async () => {
    const { run, link, byName } = await requested();
    link.retrieveAnswer = approvedWithCard;
    expect(isError(await run("payment_status", { spendRequestId: "lsrq_1" }, friend))).toBe(true);
    const wrongThread = { ...ctxFor(owner), conversationKey: "chat:another" };
    expect(isError(await byName.get("payment_status")!.spec.execute({ spendRequestId: "lsrq_1" }, wrongThread))).toBe(true);
    expect(link.calls.retrieve).toHaveLength(0);
  });

  it("reports pending approval without any card data and updates the record", async () => {
    const { run, link, records } = await requested();
    link.retrieveAnswer = () => spendRequest({ status: "pending_approval" });
    const text = textOf(await run("payment_status", { spendRequestId: "lsrq_1" }));
    expect(text).toContain("pending_approval");
    expect(text).toMatch(/Waiting for the owner/);
    expect(link.calls.retrieve).toEqual([{ id: "lsrq_1", opts: { include: ["card"] } }]);
    expect(records()[0]!.status).toBe("pending_approval");
    expect(records()[0]!.cardDelivered).toBe(false);
  });

  it("returns a scoped reference once without persisting card details", async () => {
    const { run, link, records, entries, paymentsText, vault, state } = await requested();
    link.retrieveAnswer = approvedWithCard;

    const first = textOf(await run("payment_status", { spendRequestId: "lsrq_1" }));
    expect(first).not.toContain(CARD_NUMBER);
    expect(first).not.toContain("03/2029");
    expect(first).not.toContain("CVC: 123");
    const reference = first.match(/cred_[A-Za-z0-9_-]{43}/)?.[0];
    expect(reference).toBeDefined();
    expect(vault.createResolver("hosted-computer").resolve(reference!, "number", credentialScope(ctxFor(owner), "workspace-test"))).toBe(CARD_NUMBER);
    state.writeJson("transcript.json", { toolResult: first });
    expect(fs.readFileSync(state.path("transcript.json"), "utf8")).not.toContain(CARD_NUMBER);
    expect(link.calls.retrieve[0]).toEqual({ id: "lsrq_1", opts: { include: ["card"] } });

    const record = records()[0]!;
    expect(record.status).toBe("approved");
    expect(record.cardDelivered).toBe(true);
    expect(record.deliveredAt).toBe(NOW.toISOString());
    expect(paymentsText()).not.toContain(CARD_NUMBER);
    expect(paymentsText()).not.toContain("123");

    expect(entries).toEqual([
      {
        kind: "spend",
        conversationKey: "imessage:t",
        principal: "owner",
        detail: { spendRequestId: "lsrq_1", deliveredUsd: 25.99, merchantName: "Acme", currency: "usd", via: "link_agent_wallet" },
      },
    ]);
    expect(JSON.stringify(entries)).not.toContain(CARD_NUMBER);

    const second = textOf(await run("payment_status", { spendRequestId: "lsrq_1" }));
    expect(second).not.toContain(CARD_NUMBER);
    expect(second).not.toContain("CVC");
    expect(second).toContain("approved");
    expect(second).toMatch(/already delivered once/);
    // The second lookup does not even ask Link for the card.
    expect(link.calls.retrieve[1]).toEqual({ id: "lsrq_1", opts: undefined });
    expect(entries).toHaveLength(1);
  });

  it("does not mark delivery when Link says approved but sends no card yet", async () => {
    const { run, link, records, entries } = await requested();
    link.retrieveAnswer = () => spendRequest({ status: "approved" });
    const text = textOf(await run("payment_status", { spendRequestId: "lsrq_1" }));
    expect(text).toMatch(/not returned the card yet/);
    expect(records()[0]!.cardDelivered).toBe(false);
    expect(entries).toHaveLength(0);
    // A later call still asks for the card.
    link.retrieveAnswer = approvedWithCard;
    expect(textOf(await run("payment_status", { spendRequestId: "lsrq_1" }))).toContain("credentialRef cred_");
    expect(link.calls.retrieve[1]).toEqual({ id: "lsrq_1", opts: { include: ["card"] } });
  });

  it("releases the request's hold on the daily total once when Link denies it, and never after delivery", async () => {
    const { run, link, entries, records } = await requested();
    link.retrieveAnswer = () => spendRequest({ status: "denied" });
    await run("payment_status", { spendRequestId: "lsrq_1" });
    await run("payment_status", { spendRequestId: "lsrq_1" });
    expect(entries).toEqual([
      { kind: "spend", conversationKey: "imessage:t", principal: "owner", detail: { spendRequestId: "lsrq_1", amountUsd: -25.99, merchantName: "Acme", released: "denied", via: "link_agent_wallet" } },
    ]);
    expect(records()[0]!.released).toBe(true);

    const delivered = await requested();
    delivered.link.retrieveAnswer = approvedWithCard;
    await delivered.run("payment_status", { spendRequestId: "lsrq_1" });
    delivered.link.retrieveAnswer = () => spendRequest({ status: "failed" });
    await delivered.run("payment_status", { spendRequestId: "lsrq_1" });
    expect(delivered.entries.every((e) => typeof e.detail.amountUsd !== "number")).toBe(true);
  });

  it("explains denied, expired and failed outcomes", async () => {
    const { run, link } = await requested();
    link.retrieveAnswer = () => spendRequest({ status: "denied" });
    expect(textOf(await run("payment_status", { spendRequestId: "lsrq_1" }))).toMatch(/denied.*Do not retry/s);
    link.retrieveAnswer = () => spendRequest({ status: "expired" });
    expect(textOf(await run("payment_status", { spendRequestId: "lsrq_1" }))).toContain("expired");
    link.retrieveAnswer = () => spendRequest({ status: "failed", payment_status_details: { outcome: "failure", decline_code: "insufficient_funds", amount: 2599, currency: "usd" } as SpendRequest["payment_status_details"] });
    expect(textOf(await run("payment_status", { spendRequestId: "lsrq_1" }))).toContain("insufficient_funds");
  });

  it("surfaces a requires_action step the owner must take", async () => {
    const { run, link } = await requested();
    link.retrieveAnswer = () =>
      spendRequest({
        status: "requires_action",
        status_details: { requires_action: { next_action: { type: "identity_verification", resolution: "create_new_spend_request_after_completion", display_message: "Verify your identity in Link", action_url: "https://link.com/verify" } } },
      });
    const text = textOf(await run("payment_status", { spendRequestId: "lsrq_1" }));
    expect(text).toContain("Verify your identity in Link");
    expect(text).toContain("https://link.com/verify");
    link.retrieveAnswer = () =>
      spendRequest({ status: "requires_action", status_details: { requires_action: { next_action: { type: "three_d_secure", resolution: "auto_resume", display_message: "Checking", action_url: null } } } });
    expect(textOf(await run("payment_status", { spendRequestId: "lsrq_1" }))).toMatch(/again shortly/);
  });

  it("reports when Link no longer knows the request", async () => {
    const { run, link } = await requested();
    link.retrieveAnswer = () => null;
    const result = await run("payment_status", { spendRequestId: "lsrq_1" });
    expect(isError(result)).toBe(true);
  });
});

describe("payment_list", () => {
  it("is owner only", async () => {
    const { run } = setup();
    const result = await run("payment_list", {}, friend);
    expect(isError(result)).toBe(true);
  });

  it("lists recent requests newest first without card data", async () => {
    const s = setup();
    await s.run("payment_request", GOOD_REQUEST);
    s.link.retrieveAnswer = approvedWithCard;
    await s.run("payment_status", { spendRequestId: "lsrq_1" });
    // A second, later request from a friend.
    s.link.client.spendRequests.create = async (p) => spendRequest({ id: "lsrq_2", context: p.context });
    const later = s.byName.get("payment_request")!;
    await later.spec.execute({ amountUsd: 7, merchantName: "Cafe", context: "Coffee for the team meeting on Friday" }, ctxFor(friend, new Date(NOW.getTime() + 60_000)));

    const text = textOf(await s.run("payment_list", {}));
    const lines = text.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("lsrq_2");
    expect(lines[0]).toContain("$7.00 Cafe");
    expect(lines[0]).toContain("requested by contact:alex-kim");
    expect(lines[1]).toContain("lsrq_1");
    expect(lines[1]).toContain("$25.99 Acme approved (card delivered)");
    expect(text).not.toContain(CARD_NUMBER);
  });

  it("says so when there is nothing", async () => {
    const { run } = setup();
    expect(textOf(await run("payment_list", {}))).toBe("No payment requests yet.");
  });
});

describe("helpers", () => {
  it("toCents accepts dollars and rejects nonsense", () => {
    expect(toCents(25.99)).toBe(2599);
    expect(toCents(0.01)).toBe(1);
    expect(toCents(0.004)).toBeUndefined();
    expect(toCents(-1)).toBeUndefined();
    expect(toCents(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(toCents("1")).toBeUndefined();
    expect(toCents(100_000)).toBe(10_000_000);
    expect(toCents(100_000.01)).toBeUndefined();
  });

  it("pickPaymentMethod prefers the default", () => {
    expect(pickPaymentMethod(methods)?.id).toBe("pm_default");
    expect(pickPaymentMethod([methods[0]!])?.id).toBe("pm_first");
    expect(pickPaymentMethod([])).toBeUndefined();
  });

  it("buildContext always reaches 100 characters and collapses whitespace", () => {
    const text = buildContext({ agentName: "I", ownerName: "M", requester: "M", merchantName: "A", amountUsd: 1, context: "  x\n\n y ", at: NOW });
    expect(text.length).toBeGreaterThanOrEqual(MIN_CONTEXT_CHARS);
    expect(text).toContain("Reason: x y.");
    expect(text).toContain(NOW.toISOString());
  });
});

describe("business provider consent", () => {
  it("still requests Link consent for dispatched business purchases and keeps secrets out of failures", async () => {
    const { byName, link, sent, config } = setup();
    config.business = { autonomy: "full" };
    const worker = { ...ctxFor(owner), businessInvocation: true, taskRun: { taskId: "task-a", runId: "run-a", taskRevision: 1, executionEpoch: 1, globalControlEpoch: 0, authorityRef: "owner:a" } };
    const request = byName.get("payment_request")!.spec;
    await expect(request.execute(GOOD_REQUEST, { ...worker, businessInvocation: false })).rejects.toThrow("task dispatch");
    expect(link.calls.create).toHaveLength(0);
    await request.execute(GOOD_REQUEST, worker);
    expect(link.calls.approval).toEqual(["lsrq_1"]);
    expect(sent[0]!.msg.text).toContain("provider payment consent");
    link.retrieveAnswer = () => { throw new Error(`provider echo ${CARD_NUMBER} password=synthetic-sensitive`); };
    const error = await byName.get("payment_status")!.spec.execute({ spendRequestId: "lsrq_1" }, worker).catch((caught: unknown) => caught);
    expect(String(error)).toContain("provider outcome may be unknown");
    expect(String(error)).not.toContain(CARD_NUMBER);
    expect(String(error)).not.toContain("synthetic-sensitive");
    expect(paymentsGuidance(true, true)).toContain("provider consent");
    expect(paymentsGuidance(true)).toContain("Personal spend policy");
  });

  it.each(["signal", "dispatch"] as const)("blocks creation after a payment-method prerequisite is revoked through %s", async (fence) => {
    const s = setup();
    const pending = gate();
    const controller = new AbortController();
    let active = true;
    const ctx = { ...ctxFor(owner), assertBusinessDispatch: () => { if (!active) throw new Error("source or authority revoked"); } };
    s.link.client.paymentMethods.list = async () => {
      s.link.calls.list += 1;
      await pending.wait();
      return methods;
    };
    const result = s.byName.get("payment_request")!.spec.execute(GOOD_REQUEST, ctx, controller.signal).catch((error: unknown) => error);
    await pending.entered;
    if (fence === "signal") controller.abort();
    else active = false;
    pending.release();
    expect(await result).toBeInstanceOf(Error);
    expect(s.link.calls.create).toHaveLength(0);
    expect(s.link.calls.approval).toHaveLength(0);
    expect(s.sent).toHaveLength(0);
    expect(s.records()).toHaveLength(0);
  });

  it.each(["signal", "dispatch"] as const)("preserves accepted creation but blocks consent after %s revocation", async (fence) => {
    const s = setup();
    const pending = gate();
    const controller = new AbortController();
    let active = true;
    const receipts: unknown[] = [];
    const ctx = {
      ...ctxFor(owner),
      assertBusinessDispatch: () => { if (!active) throw new Error("source or authority revoked"); },
      recordBusinessReceipt: (receipt: unknown) => { receipts.push(receipt); },
    };
    s.link.client.spendRequests.create = async (params) => {
      s.link.calls.create.push(params);
      await pending.wait();
      return spendRequest();
    };
    const result = s.byName.get("payment_request")!.spec.execute(GOOD_REQUEST, ctx, controller.signal).catch((error: unknown) => error);
    await pending.entered;
    if (fence === "signal") controller.abort();
    else active = false;
    pending.release();
    expect(await result).toBeInstanceOf(Error);
    expect(s.link.calls.create).toHaveLength(1);
    expect(s.link.calls.approval).toHaveLength(0);
    expect(s.sent).toHaveLength(0);
    expect(s.records()).toMatchObject([{ spendRequestId: "lsrq_1", status: "created", cardDelivered: false }]);
    expect(receipts).toEqual([{ spendRequestId: "lsrq_1", status: "created", amountUsd: 25.99, merchantName: "Acme" }]);
    expect(s.paymentsText()).not.toContain(APPROVAL_URL);
  });

  it("persists creation before awaiting consent and blocks notification after stop", async () => {
    const s = setup();
    const pending = gate();
    const controller = new AbortController();
    s.link.client.spendRequests.requestApproval = async (id) => {
      s.link.calls.approval.push(id);
      await pending.wait();
      return { id, approval_url: APPROVAL_URL };
    };
    const result = s.byName.get("payment_request")!.spec.execute(GOOD_REQUEST, ctxFor(owner), controller.signal).catch((error: unknown) => error);
    await pending.entered;
    expect(s.records()).toMatchObject([{ spendRequestId: "lsrq_1", status: "created" }]);
    controller.abort();
    pending.release();
    expect(await result).toBeInstanceOf(Error);
    expect(s.link.calls.approval).toEqual(["lsrq_1"]);
    expect(s.records()).toMatchObject([{ spendRequestId: "lsrq_1", status: "pending_approval" }]);
    expect(s.sent).toHaveLength(0);
  });

  it.each(["signal", "dispatch"] as const)("forwards notification fences through outbox prerequisites for %s revocation", async (fence) => {
    const s = setup();
    const pending = gate();
    const controller = new AbortController();
    let active = true;
    let submitted = 0;
    const receipts: unknown[] = [];
    const ctx = {
      ...ctxFor(owner),
      assertBusinessDispatch: () => { if (!active) throw new Error("authority revoked"); },
      recordBusinessReceipt: (receipt: unknown) => { receipts.push(receipt); },
    };
    s.outbox.send = async (_message, dispatch) => {
      expect(dispatch.signal).toBe(controller.signal);
      expect(dispatch.recordBusinessReceipt).toBe(ctx.recordBusinessReceipt);
      expect(dispatch.assertBusinessDispatch).toBeTypeOf("function");
      await pending.wait();
      dispatch.assertBusinessDispatch!();
      submitted += 1;
    };
    const result = s.byName.get("payment_request")!.spec.execute(GOOD_REQUEST, ctx, controller.signal).catch((error: unknown) => error);
    await pending.entered;
    if (fence === "signal") controller.abort();
    else active = false;
    pending.release();
    expect(await result).toBeInstanceOf(Error);
    expect(submitted).toBe(0);
    expect(s.records()).toMatchObject([{ spendRequestId: "lsrq_1", status: "pending_approval" }]);
    expect(receipts).toMatchObject([{ status: "created" }, { status: "pending_approval" }]);
    expect(s.entries.filter((entry) => entry.kind === "outbound")).toHaveLength(0);
  });

  it("keeps creation evidence when consent has an unknown provider outcome", async () => {
    const s = setup();
    s.link.client.spendRequests.requestApproval = async () => {
      throw new Error(`uncertain consent response ${CARD_NUMBER}`);
    };
    await expect(s.run("payment_request", GOOD_REQUEST)).rejects.toThrow("provider outcome may be unknown");
    expect(s.records()).toMatchObject([{ spendRequestId: "lsrq_1", status: "created", cardDelivered: false }]);
    expect(s.sent).toHaveLength(0);
    expect(s.paymentsText()).not.toContain(CARD_NUMBER);
    s.link.retrieveAnswer = () => spendRequest();
    const status = textOf(await s.run("payment_status", { spendRequestId: "lsrq_1" }));
    expect(status).toContain("provider approval status has not been verified");
  });

  it("does not create a connect flow for an already canceled owner invocation", async () => {
    const s = setup({ connected: false });
    const controller = new AbortController();
    controller.abort();
    await expect(s.byName.get("payment_connect")!.spec.execute({}, ctxFor(owner), controller.signal)).rejects.toThrow();
    expect(fs.existsSync(s.wallet.pendingPath())).toBe(false);
    expect(s.sent).toHaveLength(0);
  });

  it("does not issue credentials after authority changes during card retrieval", async () => {
    const s = setup();
    await s.run("payment_request", GOOD_REQUEST);
    const pending = gate();
    let active = true;
    const ctx = { ...ctxFor(owner), assertBusinessDispatch: () => { if (!active) throw new Error("source revoked"); } };
    s.link.client.spendRequests.retrieve = async () => {
      await pending.wait();
      return approvedWithCard();
    };
    const result = s.byName.get("payment_status")!.spec.execute({ spendRequestId: "lsrq_1" }, ctx).catch((error: unknown) => error);
    await pending.entered;
    active = false;
    pending.release();
    expect(await result).toBeInstanceOf(Error);
    expect(s.records()[0]!.cardDelivered).toBe(false);
    expect(s.entries.filter((entry) => entry.kind === "spend")).toHaveLength(0);
    expect(s.paymentsText()).not.toContain(CARD_NUMBER);
    // A later authorized read can still deliver exactly one opaque reference.
    s.link.client.spendRequests.retrieve = async () => approvedWithCard();
    const later = await s.run("payment_status", { spendRequestId: "lsrq_1" });
    expect(textOf(later)).toContain("credentialRef");
    expect(textOf(later)).not.toContain(CARD_NUMBER);
  });
});
