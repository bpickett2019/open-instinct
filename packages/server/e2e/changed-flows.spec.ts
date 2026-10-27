import { request as httpRequest } from "node:http";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { test, expect, navigate, assertAllowances } from "./fixtures.js";

for (const theme of ["light", "dark"] as const) {
  test(`settings errors offline and expired authentication ${theme}`, async ({ page, context, scenario, login, checkpoint }) => {
    await page.emulateMedia({ colorScheme: theme }); await login(); await scenario.login();
    await navigate(page, "settings", "Settings");
    const before = scenario.app.business!.coordinator.store.settings();
    await page.getByLabel("Timezone", { exact: true }).fill("Not/A_Real_Zone"); await page.getByRole("button", { name: "Save settings", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("Invalid timezone"); expect(scenario.app.business!.coordinator.store.settings()).toEqual(before); await checkpoint("validation-error", theme);
    await page.getByLabel("Timezone", { exact: true }).fill(before.value.timezone);
    await page.getByLabel(`Purchase limit in ${before.value.currency} minor units (blank means no owner cap)`, { exact: true }).fill("1000");
    await page.getByLabel("Model limit in USD cents (blank means no owner cap)", { exact: true }).fill("500");
    const settingsSaved = page.waitForResponse(r => r.url().endsWith("/api/owner/settings") && r.request().method() === "PATCH");
    await page.getByRole("button", { name: "Save settings", exact: true }).click(); expect((await settingsSaved).status()).toBe(200);
    await page.reload(); await expect(page.getByLabel("Model limit in USD cents (blank means no owner cap)", { exact: true })).toHaveValue("500");
    expect(scenario.app.business!.coordinator.store.allowanceBalances()).toMatchObject({
      purchase: { currency: before.value.currency, limitMinor: 1000 },
      model: { currency: "USD", limitMinor: 500 },
    });
    await assertAllowances(page, scenario); await checkpoint("allowance-balances", theme);
    await page.getByLabel(`Purchase limit in ${before.value.currency} minor units (blank means no owner cap)`, { exact: true }).fill("");
    await page.getByLabel("Model limit in USD cents (blank means no owner cap)", { exact: true }).fill("");
    const capsCleared = page.waitForResponse(r => r.url().endsWith("/api/owner/settings") && r.request().method() === "PATCH");
    await page.getByRole("button", { name: "Save settings", exact: true }).click(); expect((await capsCleared).status()).toBe(200);
    expect(scenario.app.business!.coordinator.store.settings().value.limits).toMatchObject({ purchaseMinor: null, modelMinor: null });
    await assertAllowances(page, scenario);
    await navigate(page, "chat", "Chat");
    await page.getByLabel("Message", { exact: true }).fill("business status"); await page.getByRole("button", { name: "Send message" }).click(); await expect(page.locator("#messages")).toContainText("Full autonomy");
    const count = scenario.app.business!.coordinator.store.messages().length;
    await context.setOffline(true); await expect(page.locator("#connection-state")).toContainText(/Offline|unreachable/); await expect(page.locator("#messages")).toContainText("business status"); await checkpoint("offline", theme);
    await context.setOffline(false); await expect(page.locator("#connection-state")).toContainText("Connected"); expect(scenario.app.business!.coordinator.store.messages()).toHaveLength(count);
    expect((await scenario.owner("/session", { method: "DELETE", body: { all: true } })).status).toBe(200);
    await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
    const response = await page.request.get(`${scenario.url}/api/owner/messages`); expect(response.status()).toBe(401); await checkpoint("authentication-expired", theme);
  });

  test(`direct stop fences active work and survives restart ${theme}`, async ({ page, scenario, login, checkpoint }) => {
    await page.emulateMedia({ colorScheme: theme }); await login();
    const gate = scenario.gate();
    scenario.model.setResponses([
      async () => { await gate.promise; return fauxAssistantMessage([fauxToolCall("write", { path: "must-not-dispatch.txt", content: "No write after stop" })], { stopReason: "toolUse" }); },
      fauxAssistantMessage("Stopped."),
    ]);
    await navigate(page, "chat", "Chat"); await page.getByLabel("Message", { exact: true }).fill("Create a synthetic file after the model gate opens."); await page.getByRole("button", { name: "Send message" }).click();
    await scenario.waitFor(() => scenario.app.business!.coordinator.store.tasks().some(t => t.status === "running"), "active gated task");
    const epoch = scenario.app.business!.coordinator.store.settings().value.globalControlEpoch;
    const calls = scenario.providers.maritime.invocations.length;
    await page.getByRole("button", { name: "Stop all work", exact: true }).click();
    await expect(page.getByRole("button", { name: "Resume work", exact: true })).toBeVisible();
    expect(scenario.app.business!.coordinator.store.settings().value.globalControlEpoch).toBeGreaterThan(epoch);
    gate.release(); await navigate(page, "overview", "Overview"); await expect(page.getByRole("heading", { name: "Globally stopped", exact: true })).toBeVisible();
    expect(scenario.app.business!.coordinator.store.actions().filter(a => a.tool === "write")).toHaveLength(0); expect(scenario.providers.maritime.invocations).toHaveLength(calls);
    await checkpoint("globally-stopped", theme);
    await scenario.restart(); await page.goto(`${scenario.url}/workspace`); await page.getByLabel("Workspace token").fill(scenario.token); await page.getByRole("button", { name: "Sign in", exact: true }).click(); await expect(page.getByRole("button", { name: "Resume work", exact: true })).toBeVisible();
    expect(scenario.app.business!.coordinator.store.settings().value.stopped).toBe(true); expect(scenario.app.business!.coordinator.store.actions().filter(a => a.tool === "write")).toHaveLength(0);
  });

  test(`unknown hosted effect and disconnected account remain honest ${theme}`, async ({ page, scenario, login, checkpoint }) => {
    await page.emulateMedia({ colorScheme: theme }); await login(); await scenario.login();
    const store = scenario.app.business!.coordinator.store;
    scenario.providers.maritime.acceptThenDrop();
    scenario.model.setResponses([
      fauxAssistantMessage([fauxToolCall("shell", { command: "synthetic-controlled-command" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("task_checkpoint", { checkpoint: { next: "Verify the hosted shell outcome. The response was lost; do not replay the command." } })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("task_wait", { kind: "reconciliation", correlationKey: "synthetic-shell-uncertainty" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("Uncertain remote command will not be replayed."),
    ]);
    await scenario.postMessage("Run the controlled synthetic hosted shell operation once.");
    await scenario.waitFor(() => store.actions().some(a => a.tool === "shell" && a.status === "unknown"), "unknown hosted shell outcome");
    const action = store.actions().find(a => a.tool === "shell")!;
    expect(scenario.providers.maritime.invocations.filter(i => i.name === "shell")).toHaveLength(1);
    await navigate(page, `tasks/${action.taskId}`, "Task detail"); await expect(page.getByText("unknown", { exact: true })).toBeVisible(); await checkpoint("action-unknown", theme);
    await page.reload(); await expect(page.getByText("unknown", { exact: true })).toBeVisible(); expect(scenario.providers.maritime.invocations.filter(i => i.name === "shell")).toHaveLength(1);
    await navigate(page, "connections", "Connections");
    await page.getByText("Manage connected accounts and permissions", { exact: true }).click();
    const accounts = await (await scenario.owner("/connections")).json() as { connections: Array<{ id: string; version: number; accountId: string; epoch: number; toolkit: string }> };
    const account = accounts.connections.find(c => c.toolkit === "gmail")!; expect(account).toBeDefined();
    await page.getByRole("article").filter({ has: page.getByRole("heading", { name: /^gmail:/ }) }).getByRole("button", { name: "Disconnect account" }).click();
    await expect(page.getByText(/disabled · account/).first()).toBeVisible();
    const disabled = store.get<{ status: string; epoch: number; revocation: string }>("connection", account.id)!;
    expect(disabled.value.status).toBe("disabled"); expect(disabled.value.epoch).toBeGreaterThan(account.epoch); expect(["requested", "failed"]).toContain(disabled.value.revocation);
    const coordinator = scenario.app.business!.coordinator;
    const owner = { kind: "owner", id: "owner", tier: "owner", displayName: "Synthetic Owner" } as const;
    const authority = coordinator.ownerAuthority(owner, "chat", "disconnect-negative-case", "Prove disabled connection dispatch is denied");
    const task = coordinator.admitTask({ channel: "chat", conversationKey: "chat:negative-case", requester: "owner", audience: "owner", replyRef: {} }, authority, { objective: "Prove disabled connection dispatch is denied", doneCriteria: ["No provider invocation"] }, "disconnect-negative-case");
    const binding = coordinator.claimRun(task.id)!; expect(binding).toBeDefined(); let invoked = false;
    await expect(coordinator.dispatch(binding, { stepId: "disabled-effect", tool: "gmail_send", arguments: {}, sourceRevisions: {}, effectful: true, connection: { id: account.id, version: account.version, accountId: account.accountId, epoch: account.epoch } }, async () => { invoked = true; throw new Error("Must never invoke disabled provider"); })).rejects.toThrow();
    expect(invoked).toBe(false); await checkpoint("provider-disconnected", theme);
  });
}

test("owner security boundary rejects origin CSRF Host tunnel and cookie legacy bypass", async ({ page, scenario, login }) => {
  await login(); const { cookie, csrf } = await scenario.login();
  const request = (path: string, headers: Record<string, string>, method = "GET", data?: unknown) => scenario.fetch(`${scenario.url}${path}`, { method, headers, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  expect((await request("/api/owner/overview", { cookie, origin: "https://foreign.test" })).status).toBe(403);
  // Fetch implementations may replace Host; use the exact allocated socket to send a hostile Host verbatim.
  expect(scenario.allowedOrigins.has(new URL(scenario.url).origin)).toBe(true);
  const hostileHost = await new Promise<number>((resolve, reject) => {
    const req = httpRequest(new URL("/api/owner/overview", scenario.url), { headers: { cookie, host: "foreign.test" } }, response => { response.resume(); response.once("end", () => resolve(response.statusCode ?? 0)); });
    req.once("error", reject); req.end();
  });
  expect(hostileHost).toBe(403);
  expect((await request("/api/owner/control", { cookie, origin: scenario.url, "content-type": "application/json" }, "POST", { target: "workspace", operation: "pause" })).status).toBe(403);
  expect((await request("/api/owner/control", { cookie, origin: scenario.url, "x-workspace-csrf": csrf, "content-type": "text/plain" }, "POST", {})).status).toBe(415);
  expect((await request("/api/owner/control", { cookie, "x-workspace-csrf": csrf, "content-type": "application/json" }, "POST", {})).status).toBe(403);
  expect((await request("/api/owner/overview", { authorization: `Bearer ${scenario.token}` })).status).toBe(401);
  expect((await request("/status", { cookie })).status).toBe(401);
  expect((await scenario.fetch(`${scenario.tunnelUrl}/workspace`)).status).toBe(404);
  expect((await scenario.fetch(`${scenario.tunnelUrl}/api/owner/overview`, { headers: { cookie } })).status).toBe(404);
  const shell = await request("/workspace", {}); expect(shell.headers.get("content-security-policy")).toContain("frame-ancestors 'none'"); expect(shell.headers.get("cache-control")).toBe("no-store"); expect(await shell.text()).not.toContain(scenario.token);
  expect((await request("/workspace/assets/../../package.json", {})).status).not.toBe(200);
  await navigate(page, "chat", "Chat"); await page.getByLabel("Message", { exact: true }).fill("business status"); await page.getByRole("button", { name: "Send message" }).click(); await expect(page.locator("#messages")).toContainText("Full autonomy");
  const historyA = await (await scenario.owner("/messages?after=0")).json(); const historyB = await (await scenario.owner("/messages?after=0")).json(); expect(historyB).toEqual(historyA);
});

test("owner changes and closes queued work without losing prior versions", async ({ page, scenario, login }) => {
  await login(); await page.getByRole("button", { name: "Stop all work", exact: true }).click(); await expect(page.getByRole("button", { name: "Resume work", exact: true })).toBeVisible();
  await navigate(page, "chat", "Chat"); await page.getByLabel("Message", { exact: true }).fill("Prepare an initial synthetic supplier comparison."); await page.getByRole("button", { name: "Send message" }).click();
  await scenario.waitFor(() => scenario.app.business!.coordinator.store.tasks().length === 1, "queued admission");
  const original = scenario.app.business!.coordinator.store.tasks()[0]!;
  await navigate(page, `tasks/${original.id}`, "Task detail"); await page.getByLabel("Objective", { exact: true }).fill("Prepare a synthetic supplier comparison with maintenance terms.");
  await page.getByRole("button", { name: "Save task changes" }).click(); await expect(page.getByRole("heading", { name: "Prepare a synthetic supplier comparison with maintenance terms.", exact: true })).toBeVisible();
  const current = scenario.app.business!.coordinator.store.task(original.id)!; expect(current.version).toBeGreaterThan(original.version);
  await scenario.login(); expect((await scenario.owner(`/tasks/${original.id}`, { method: "PATCH", body: { expectedVersion: original.version, objective: "Stale overwrite", doneCriteria: original.doneCriteria } })).status).toBe(409);
  await page.getByRole("button", { name: "Close task", exact: true }).click(); await expect(page.getByText("Status: cancelled", { exact: true })).toBeVisible();
  expect(scenario.app.business!.coordinator.store.actions(original.id)).toHaveLength(0);
});

test("hostile source content stays inert and selective deletion removes retrieval", async ({ page, scenario, login }) => {
  await login(); await scenario.login(); await navigate(page, "knowledge", "Knowledge");
  const hostile = "<img src=x onerror=\"document.body.dataset.injected='yes'\">\\nSynthetic searchable poisonousmarkup source.";
  await page.getByLabel("Document (maximum 20 MiB)").setInputFiles({ name: "hostile-source.txt", mimeType: "text/plain", buffer: Buffer.from(hostile) }); await page.getByRole("button", { name: "Upload document" }).click();
  await expect(page.getByRole("heading", { name: "Knowledge source / version", exact: true })).toBeVisible(); await expect(page.getByText(/poisonousmarkup source/)).toBeVisible();
  expect(await page.evaluate(() => document.body.dataset.injected)).toBeUndefined(); await expect(page.locator("main img")).toHaveCount(0);
  const id = new URL(page.url()).hash.split("/")[1]!; const before = await scenario.owner("/knowledge?q=poisonousmarkup"); expect(JSON.stringify(await before.json())).toContain(id);
  await page.getByRole("button", { name: "Remove from active knowledge", exact: true }).click(); await expect(page.getByRole("heading", { name: "Knowledge", exact: true })).toBeVisible();
  const after = await scenario.owner("/knowledge?q=poisonousmarkup"); expect(await after.json()).toEqual({ results: [] });
  const bad = await scenario.owner("/knowledge", { method: "POST", body: { filename: "../state.sqlite", mimeType: "text/plain", base64: Buffer.from("not allowed").toString("base64") } }); expect(bad.status).toBe(400);
});

if (process.env.INSTINCT_EVIDENCE_NEGATIVE_CASE === "1") {
  test("intentional semantic assertion failure proves evidence failure capture", async ({ page, scenario, login }) => {
    await login(); await navigate(page, "chat", "Chat");
    const canary = scenario.token;
    await page.getByLabel("Message", { exact: true }).fill(`Diagnostic credential must stay private: ${canary}`);
    await page.getByRole("button", { name: "Send message" }).click();
    await scenario.waitFor(() => scenario.app.business!.coordinator.store.messages().some(message => message.role === "owner"), "canary admission");
    expect(JSON.stringify(scenario.app.business!.coordinator.store.messages())).not.toContain(canary);
    await page.reload(); await navigate(page, "tasks", "Tasks");
    await expect(page.locator("body")).not.toContainText(canary);
    await navigate(page, "chat", "Chat");
    await page.getByLabel("Message", { exact: true }).fill(`Unsubmitted private diagnostic: ${canary}`);
    await page.screenshot(); // Exercise raw private pixels before failure; public traces must omit them.
    expect(await page.getByRole("button", { name: "Send message" }).count(), `Intentional negative assertion; redact diagnostic credential ${canary}`).toBe(2);
  });
}
