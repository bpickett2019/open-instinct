import { readFile } from "node:fs/promises";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { test, expect, navigate, assertAllowances } from "./fixtures.js";

for (const theme of ["light", "dark"] as const) {
  test(`owner workspace complete screen matrix ${theme}`, async ({ page, context, scenario, checkpoint }) => {
    await page.emulateMedia({ colorScheme: theme });
    const welcome = "Welcome. Tell me about your business and what you would like help with.";
    const welcomeGate = scenario.gate();
    scenario.foregroundModel.setResponses([async () => { await welcomeGate.promise; return fauxAssistantMessage(welcome); }]);
    const onboardingRequests: unknown[] = []; const profileWrites: string[] = [];
    page.on("request", request => {
      if (request.url().endsWith("/api/owner/onboarding/conversation") && request.method() === "POST") onboardingRequests.push(request.postDataJSON());
      if (request.url().endsWith("/api/owner/profile") && request.method() === "PATCH") profileWrites.push(request.postData() ?? "");
    });
    await page.goto(`${scenario.url}/workspace`);
    await page.getByLabel("Workspace token").fill("invalid-synthetic-token");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("Invalid workspace token");
    await checkpoint("login", theme);
    await page.getByLabel("Workspace token").fill(scenario.token);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("button", { name: "Stop all work", exact: true })).toBeVisible();
    const cookies = await context.cookies();
    expect(cookies.find(c => c.name === "instinct-owner-dev")).toMatchObject({ httpOnly: true, sameSite: "Strict" });
    expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
    await expect(page.getByRole("heading", { level: 1, name: "Onboarding", exact: true })).toBeVisible();
    await expect(page.locator(".conversation-pending")).toContainText(/getting ready|thinking/);
    welcomeGate.release();
    await expect(page.locator("#messages")).toContainText(welcome);
    await expect(page.locator(".conversation-pending")).toBeHidden();
    expect(onboardingRequests).toEqual([{}]);
    await expect(page.getByLabel("Answer", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Connect Gmail", exact: true })).not.toBeVisible();
    await checkpoint("onboarding-welcome", theme);
    await navigate(page, "tasks", "Tasks");
    await expect(page.getByText("No work in this state.")).toBeVisible();
    expect(scenario.app.business!.coordinator.store.tasks()).toHaveLength(0);
    await checkpoint("empty", theme);

    await navigate(page, "onboarding", "Onboarding");
    const description = "I run Harbor Field Services. We provide commercial roof inspections in Bristol. Can you help me keep up with customer enquiries?";
    const followUp = "I’ve remembered Harbor Field Services, commercial roof inspections, and Bristol. Which customer enquiries would you like help with first?";
    const replyGate = scenario.gate();
    scenario.foregroundModel.setResponses([
      async () => { await replyGate.promise; return fauxAssistantMessage([fauxToolCall("business_profile_save", { expectedVersion: 0, facts: [
        { key: "businessName", value: "Harbor Field Services", scope: "business" },
        { key: "services", value: "commercial roof inspections", scope: "business" },
        { key: "serviceArea", value: "Bristol", scope: "business" },
      ] })], { stopReason: "toolUse" }); },
      fauxAssistantMessage(`${followUp}\nOptional private sign-in: https://accounts.fixture.test/oauth?state=synthetic.\n<img src=x onerror="document.body.dataset.injected='yes'">`),
      fauxAssistantMessage("This extra opening must never run."),
    ]);
    const setupAdmission = page.waitForResponse(r => r.url().endsWith("/api/owner/messages") && r.request().method() === "POST");
    await page.getByLabel("Message", { exact: true }).fill(description);
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    const setupAccepted = await setupAdmission;
    expect(setupAccepted.status()).toBe(202);
    expect(setupAccepted.request().postDataJSON()).toMatchObject({ text: description });
    await expect(page.locator("#messages")).toContainText(description);
    await expect(page.locator(".conversation-pending")).toContainText("thinking");
    await page.getByLabel("Message", { exact: true }).fill("My next question is still a draft");
    replyGate.release();
    await expect(page.locator("#messages")).toContainText(followUp);
    await expect(page.locator(".conversation-pending")).toBeHidden();
    await expect(page.getByLabel("Message", { exact: true })).toHaveValue("My next question is still a draft");
    await expect(page.getByLabel("Message", { exact: true })).toBeFocused();
    const oauthLink = page.locator('#messages a[href="https://accounts.fixture.test/oauth?state=synthetic"]');
    await expect(oauthLink).toHaveAttribute("rel", "noopener noreferrer");
    await expect(oauthLink).toHaveAttribute("target", "_blank");
    await expect(page.locator("#messages img")).toHaveCount(0);
    expect(await page.locator("body").getAttribute("data-injected")).toBeNull();
    await page.getByText("What I know so far", { exact: true }).click();
    await expect(page.getByText("businessName: Harbor Field Services", { exact: true })).toBeVisible();
    await expect(page.getByText("services: commercial roof inspections", { exact: true })).toBeVisible();
    await expect(page.getByText("serviceArea: Bristol", { exact: true })).toBeVisible();
    await scenario.login();
    const profile = await (await scenario.owner("/profile")).json() as { facts: Array<{ key: string; value: unknown }> };
    expect(profile.facts).toEqual(expect.arrayContaining([{ key: "businessName", value: "Harbor Field Services", scope: "business", citation: expect.any(Object) }]));
    expect(profileWrites).toEqual([]);
    await navigate(page, "tasks", "Tasks");
    await navigate(page, "onboarding", "Onboarding");
    await expect(page.locator("#messages")).toContainText(followUp);
    expect(onboardingRequests).toEqual([{}]);
    const reopening = page.waitForResponse(r => r.url().endsWith("/api/owner/onboarding/conversation") && r.request().method() === "POST");
    await page.reload(); expect((await reopening).status()).toBe(202);
    await expect(page.locator("#messages")).toContainText(welcome);
    await expect(page.locator("#messages")).toContainText(followUp);
    await expect(page.locator(".conversation-pending")).toBeHidden();
    await expect.poll(() => page.locator("#messages").evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThanOrEqual(2);
    expect(scenario.foregroundModel.getPendingResponseCount()).toBe(1);
    expect(scenario.app.business!.coordinator.store.messages().filter(message => message.id === "answer:workspace-onboarding")).toHaveLength(1);
    expect(scenario.app.business!.coordinator.store.messages().filter(message => message.role === "owner").map(message => message.text)).toEqual([description]);
    scenario.foregroundModel.setResponses([]);
    await page.getByText("What I know so far", { exact: true }).click();
    await expect(page.getByText("businessName: Harbor Field Services", { exact: true })).toBeVisible();
    await checkpoint("onboarding", theme);
    await expect(page.getByLabel("Fact", { exact: true })).not.toBeVisible();
    await page.getByText("Connect apps and your computer", { exact: true }).click();
    const gmailAccount = [...scenario.providers.composio.accounts.values()].find(account => account.toolkit.slug === "gmail")!;
    scenario.providers.composio.revoke(gmailAccount.id);
    await page.getByRole("button", { name: "Refresh account status" }).click();
    const gmailSetup = page.locator('[data-app="gmail"]');
    await expect(gmailSetup.locator('[role="status"]')).toHaveAttribute("data-status", "available");
    await gmailSetup.getByRole("button", { name: "Connect Gmail", exact: true }).click();
    await expect(gmailSetup.getByRole("link", { name: "Continue private sign-in" })).toHaveAttribute("href", `${scenario.providers.composio.url}/oauth/gmail`);
    await expect(gmailSetup.locator('[role="status"]')).toHaveAttribute("data-status", "waiting");
    await page.getByLabel("Message", { exact: true }).fill("My unsaved service description");
    await checkpoint("onboarding-waiting", theme);
    scenario.providers.composio.reconnect(gmailAccount.id);
    await expect(gmailSetup.locator('[role="status"]')).toHaveAttribute("data-status", "connected");
    await expect(gmailSetup.locator('[role="status"]')).toContainText("owner@fixture.test");
    await expect(page.getByLabel("Message", { exact: true })).toHaveValue("My unsaved service description");
    await expect(page.getByLabel("Message", { exact: true })).toBeFocused();
    expect(scenario.app.business!.coordinator.store.tasks()).toEqual([]);
    expect(scenario.app.business!.coordinator.store.list<{ enabled: boolean }>("routine").some(row => row.value.enabled)).toBe(false);
    await checkpoint("onboarding-connected", theme);
    await page.getByRole("link", { name: "Source v1 · fact:1", exact: true }).click();
    await expect(page.getByRole("heading", { name: "fact:1 · active source", exact: true })).toBeVisible();
    await expect(page.getByText('businessName: "Harbor Field Services"', { exact: true })).toBeVisible();

    await navigate(page, "chat", "Chat");
    const admission = page.waitForResponse(r => r.url().endsWith("/api/owner/messages") && r.request().method() === "POST");
    await page.getByLabel("Message", { exact: true }).fill("Create scenario-result.txt with the synthetic verified result and verify its bytes.");
    await page.getByRole("button", { name: "Send message" }).click();
    const accepted = await admission; expect(accepted.status()).toBe(202);
    const admitted = accepted.request().postDataJSON() as { clientId: string; text: string };
    const store = scenario.app.business!.coordinator.store;
    expect(store.messages().some(m => m.role === "owner" && m.text === admitted.text)).toBe(true);
    await scenario.waitFor(() => store.tasks().length === 1, "durable task admission");
    const task = store.tasks()[0]!;
    expect(task.objective).toContain("scenario-result.txt");
    await expect(page.locator("#messages")).toContainText(task.id);
    await scenario.login();
    expect((await scenario.owner("/messages", { method: "POST", body: admitted })).status).toBe(202);
    await scenario.waitFor(() => store.task(task.id)?.status === "completed", "file task completion");
    expect(store.tasks()).toHaveLength(1);
    expect(store.actions(task.id).some(a => a.tool === "write" && a.status === "verified")).toBe(true);
    expect(await readFile(`${scenario.root}/workspace/scenario-result.txt`, "utf8")).toBe("Synthetic verified result\n");
    const event = { id: "browser-matrix-owner-text", event_type: "imessage.received", timestamp: new Date().toISOString(), data: { message: { id: "browser-matrix-owner-message", conversation_id: "conversation-owner", remote_number: "+12025550101", content: "business status", is_group: false, participants: ["+12025550101"], media: [] }, contacts: [], agent_identities: [] } };
    expect((await scenario.webhook(event)).status).toBe(204);
    await scenario.waitFor(() => store.messages().some(m => m.channel === "imessage" && m.role === "assistant"), "durable texting reply");
    await scenario.waitFor(() => scenario.providers.inkbox.accepted.length > 0, "carrier acceptance");
    const acceptedCarrierMessages = scenario.providers.inkbox.accepted.length;
    await page.reload();
    await expect(page.locator("#messages")).toContainText(admitted.text);
    const otherTab = await context.newPage(); await otherTab.goto(`${scenario.url}/workspace#chat`);
    await expect(otherTab.locator("#messages")).toContainText(admitted.text); await otherTab.close();
    await expect(page.locator("#messages")).toContainText("Text message");
    expect(scenario.providers.inkbox.accepted).toHaveLength(acceptedCarrierMessages);
    expect(scenario.providers.inkbox.receipts).toHaveLength(0);
    await checkpoint("chat", theme);
    await navigate(page, "tasks", "Tasks"); await expect(page.getByRole("heading", { name: task.objective, exact: true })).toBeVisible(); await checkpoint("task-list", theme);
    await page.getByRole("link", { name: "Inspect task" }).click();
    await expect(page.getByRole("heading", { name: "Action evidence", exact: true })).toBeVisible();
    await expect(page.getByText("verified", { exact: true }).first()).toBeVisible(); await checkpoint("task-detail", theme);
    await navigate(page, "overview", "Overview"); await expect(page.getByRole("heading", { name: "Recent results", exact: true })).toBeVisible(); await expect(page.getByRole("heading", { name: task.objective, exact: true })).toBeVisible(); await assertAllowances(page, scenario); await checkpoint("overview", theme);

    await navigate(page, "knowledge", "Knowledge");
    const original = "Harbor service guide\nStandard inspection includes a written condition report.\n";
    await page.getByLabel("Document (maximum 20 MiB)").setInputFiles({ name: "service-guide.txt", mimeType: "text/plain", buffer: Buffer.from(original) });
    await page.getByLabel("Designate as authoritative business rules").check();
    await page.getByRole("button", { name: "Upload document" }).click();
    await expect(page.getByRole("heading", { name: "Knowledge source / version", exact: true })).toBeVisible();
    await expect(page.getByText(/Standard inspection includes/)).toBeVisible();
    const originalId = new URL(page.url()).hash.split("/")[1]!;
    const originalDownload = await scenario.owner(`/files/${originalId}/download`);
    expect(originalDownload.headers.get("content-disposition")).toContain("attachment"); expect(await originalDownload.text()).toBe(original);
    await page.getByLabel("Document (maximum 20 MiB)").setInputFiles({ name: "service-guide-v2.txt", mimeType: "text/plain", buffer: Buffer.from("Harbor service guide\nInspection includes a written condition report and photographs.\n") });
    await page.getByLabel("Designate as authoritative business rules").check(); await page.getByRole("button", { name: "Upload document" }).click();
    await expect(page.getByRole("heading", { name: "service-guide-v2.txt", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Previous source version" })).toHaveAttribute("href", `#knowledge/${originalId}`);
    await page.getByText("Source metadata and content hash", { exact: true }).click();
    await checkpoint("knowledge-detail", theme);
    await navigate(page, "knowledge", "Knowledge"); await page.getByLabel("Search knowledge").fill("photographs"); await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Source-linked search results" })).toBeVisible(); await expect(page.locator("pre")).toContainText("photographs"); await checkpoint("knowledge-list", theme);
    await navigate(page, "files", "Files");
    const generated = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "scenario-result.txt", exact: true }) });
    const downloadEvent = page.waitForEvent("download"); await generated.getByRole("link", { name: "Download original" }).click(); const download = await downloadEvent; const downloaded = await download.path(); expect(downloaded).not.toBeNull(); expect(await readFile(downloaded!, "utf8")).toBe("Synthetic verified result\n"); await checkpoint("files", theme);

    await navigate(page, "connections", "Connections");
    await page.getByRole("button", { name: "Refresh account status" }).click();
    await expect(page.getByText(/owner@fixture\.test/).first()).toBeVisible(); await checkpoint("connections", theme);
    const workspaceId = store.settings().value.workspaceId;
    scenario.model.setResponses([
      fauxAssistantMessage([fauxToolCall("get_computer", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("request_takeover", { reason: "Synthetic provider login requires owner intervention" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("task_wait", { kind: "provider_challenge", correlationKey: `computer:${workspaceId}`, question: "Complete the synthetic provider login in takeover." })], { stopReason: "toolUse" }),
      fauxAssistantMessage("Waiting for verified takeover status."),
    ]);
    await scenario.postMessage("Open the hosted computer and request takeover for the synthetic provider login.");
    await scenario.waitFor(() => scenario.providers.maritime.computers.get(workspaceId)?.mode === "human", "human takeover");
    await navigate(page, "computer", "Computer");
    await expect(page.getByText(/waiting|human|takeover/i).first()).toBeVisible();
    expect(scenario.providers.maritime.invocations.some(i => i.name === "request_takeover")).toBe(true);
    await expect(page.getByRole("link", { name: "Open private takeover", exact: true })).toHaveAttribute("href", `${scenario.providers.maritime.url}/viewer/${workspaceId}`);
    await expect(page.getByText("Local provider fixture: protocol-only evidence, not a real hosted desktop or live-provider verification.", { exact: true })).toBeVisible();
    expect((await scenario.owner("/computer/privacy", { method: "POST", body: { sensitiveSessionCleared: false } })).status).toBe(400);
    await checkpoint("computer", theme);
    scenario.providers.maritime.finishTakeover(workspaceId);
    const checksBefore = scenario.providers.maritime.invocations.filter(i => i.name === "takeover_status").length;
    const checked = page.waitForResponse(r => r.url().endsWith("/api/owner/computer/check") && r.request().method() === "POST");
    await page.getByRole("button", { name: "Check takeover status" }).click(); expect((await checked).ok()).toBe(true);
    expect(scenario.providers.maritime.invocations.filter(i => i.name === "takeover_status").length).toBeGreaterThan(checksBefore);
    expect(scenario.providers.maritime.computers.get(workspaceId)?.mode).toBe("agent");
    await expect(page.getByRole("button", { name: "Check takeover status" })).toBeEnabled();
    await page.getByLabel("I cleared sensitive desktop fields and sessions").check();
    const released = page.waitForResponse(r => r.url().endsWith("/api/owner/computer/privacy") && r.request().method() === "POST");
    await page.getByRole("button", { name: "Allow computer screenshots again" }).click(); expect((await released).ok()).toBe(true);
    await expect(page.getByRole("button", { name: "Allow computer screenshots again" })).toBeEnabled();

    await navigate(page, "activity", "Activity");
    await expect(page.getByRole("heading", { name: "action.verified", exact: true }).first()).toBeVisible(); await checkpoint("activity", theme);
    await navigate(page, "settings", "Settings");
    await page.getByLabel("Timezone", { exact: true }).fill("Europe/London");
    await page.getByLabel("Currency", { exact: true }).fill("EUR");
    await page.getByLabel("Standing rules (one per line)").fill("Do not contact customers outside configured contact hours.");
    await page.getByRole("button", { name: "Save settings", exact: true }).click(); await expect(page.getByLabel("Timezone", { exact: true })).toHaveValue("Europe/London");
    await page.reload(); await expect(page.getByLabel("Timezone", { exact: true })).toHaveValue("Europe/London");
    await expect(page.getByLabel("Purchase limit in EUR minor units (blank means no owner cap)", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Model limit in USD cents (blank means no owner cap)", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Purchase limit in EUR minor units (blank means no owner cap)", { exact: true })).toHaveValue("");
    await expect(page.getByLabel("Model limit in USD cents (blank means no owner cap)", { exact: true })).toHaveValue("");
    await assertAllowances(page, scenario);
    expect(store.settings().value.currency).toBe("EUR");
    expect(store.settings().value.constraints).toEqual(["Do not contact customers outside configured contact hours."]); await checkpoint("settings", theme);
    await page.getByRole("button", { name: "Sign out", exact: true }).click(); await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
  });
}
