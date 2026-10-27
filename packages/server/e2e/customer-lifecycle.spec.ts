import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { BusinessConnection } from "@open-instinct/core";
import { ExtractionPool } from "../dist/business-extraction.js";
import { assessmentRates, assessmentObjective, importAssessmentRequest, importAssessmentReply, scriptAssessmentQuote, storedMail, toolCall, toolResult, finishFromEvidence } from "../testing/document-lifecycle.js";
import { test as base, expect, navigate } from "./fixtures.js";

const test = base.extend<{ lifecycleClock: { time: number } }>({
  lifecycleClock: async ({}, use) => { await use({ time: Date.parse("2026-10-19T10:00:00Z") }); },
  scenarioOptions: async ({ lifecycleClock }, use) => { await use({ responses: [], now: () => new Date(lifecycleClock.time) }); },
});
async function delegate(page: Page, objective: string) {
  await navigate(page, "chat", "Chat");
  await page.getByLabel("Message", { exact: true }).fill(objective);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
}
async function openAction(page: Page, id: string, status: string, ref?: string) {
  const action = page.locator(`[data-action-id="${id}"]`);
  await expect(action.locator(".badge")).toHaveText(status);
  await action.getByText("Receipt", { exact: true }).click();
  await action.getByText("Evidence references", { exact: true }).click();
  if (ref) await expect(action.locator("pre").last()).toContainText(ref);
  return action;
}

for (const theme of ["light", "dark"] as const) {
  test(`source quote PDF Gmail and reply suppression survive refresh and restart ${theme}`, async ({ page, scenario, lifecycleClock, login, checkpoint }, testInfo) => {
    await page.emulateMedia({ colorScheme: theme }); await login(); await scenario.login();
    const store = scenario.app.business!.coordinator.store;
    await navigate(page, "knowledge", "Knowledge");
    await page.getByLabel("Document (maximum 20 MiB)").setInputFiles({ name: "fictional-service-rates.txt", mimeType: "text/plain", buffer: Buffer.from(assessmentRates) });
    await page.getByLabel("Designate as authoritative business rules").check();
    await page.getByRole("button", { name: "Upload document", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Knowledge source / version", exact: true })).toBeVisible();
    const sourceId = new URL(page.url()).hash.split("/")[1]!;
    await expect(page.locator("main")).toContainText(assessmentRates);
    const connection = store.list<BusinessConnection>("connection").find(c => c.value.toolkit === "gmail")!;
    const routineName = store.get<{ name: string }>("routine", "follow-through")!.value.name;
    await navigate(page, "settings", "Settings");
    const routine = page.locator("details").filter({ has: page.locator("summary", { hasText: `${routineName}: disabled` }) });
    await routine.locator("summary").click();
    await routine.getByLabel("Enable this routine", { exact: true }).check();
    await routine.getByLabel("Source accounts (connection ID,account ID; one per line)", { exact: true }).fill(`${connection.id},${connection.value.accountId}`);
    const savedRoutine = page.waitForResponse(r => r.url().endsWith("/api/owner/routines/follow-through") && r.request().method() === "PATCH");
    await routine.getByRole("button", { name: "Save routine", exact: true }).click(); expect((await savedRoutine).status()).toBe(200);
    expect(store.get<{ enabled: boolean }>("routine", "follow-through")!.value.enabled).toBe(true);
    const customer = await importAssessmentRequest(scenario, lifecycleClock.time);
    const quote = scriptAssessmentQuote(scenario, sourceId, customer, () => lifecycleClock.time, {
      source: chunk => expect(chunk.text).toContain("250.00"),
      price: price => { expect(price.minimumMinor).toBe(25000); expect(price.maximumMinor).toBe(25000); },
    });
    await delegate(page, assessmentObjective);
    await scenario.waitFor(() => store.tasks().some(t => t.status === "completed") && scenario.app.runtime.stats().busy === 0, "source-backed quote completion");
    const task = store.tasks().find(t => t.status === "completed")!;
    expect(scenario.providers.google.accepted).toHaveLength(1);
    const sent = scenario.providers.google.accepted[0]!;
    const { message, parsed } = await storedMail(scenario, sent.id);
    expect(message.labelIds).toContain("SENT"); expect(message.threadId).toBe(customer.threadId);
    expect(parsed.to.value.map(address => address.address)).toEqual(["customer@fixture.test"]);
    expect(parsed.subject).toBe("Assessment quote"); expect(parsed.text).toContain(quote.quoteText);
    expect(parsed.attachments).toHaveLength(1); expect(parsed.attachments[0]!.filename).toBe("quote.pdf"); expect(parsed.attachments[0]!.contentType).toBe("application/pdf");
    const send = store.actions(task.id).find(a => a.tool === "business_google" && a.effectful && a.status === "verified")!;
    expect(send.sourceRevisions[`knowledge:${sourceId}`]).toBe(store.get("knowledge", sourceId)!.version);
    await navigate(page, `tasks/${task.id}`, "Task detail"); await page.reload();
    await expect(page.getByText("Status: completed", { exact: true })).toBeVisible();
    await expect(page.locator(`[data-task-id="${task.id}"]`)).toContainText("verified its attached Gmail send");
    await openAction(page, send.id, "verified", `gmail:${sent.id}`);
    await checkpoint("quote-gmail-verified", theme);

    await navigate(page, "files", "Files");
    const file = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "quote.pdf", exact: true }) });
    const downloading = page.waitForEvent("download"); await file.getByRole("link", { name: "Download original", exact: true }).click();
    const download = await downloading; expect(download.suggestedFilename()).toBe("quote.pdf");
    const pdf = await readFile((await download.path())!); expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf).toEqual(parsed.attachments[0]!.content);
    expect(store.get<{ sha256: string }>("artifact", quote.artifactId)!.value.sha256).toBe(createHash("sha256").update(pdf).digest("hex"));
    const extraction = new ExtractionPool();
    try {
      const extracted = await extraction.extract(pdf, "pdf"); expect(extracted.status).toBe("ready");
      const text = extracted.chunks.map(chunk => chunk.text).join(" ");
      expect(text).toContain("Assessment only"); expect(text).toContain("250.00"); expect(text).toContain(sourceId);
      await testInfo.attach("downloaded-quote-text", { body: Buffer.from(text), contentType: "text/plain" });
    } finally { await extraction.close(); }
    await testInfo.attach("downloaded-quote.pdf", { body: pdf, contentType: "application/pdf" });
    await file.getByRole("link", { name: "Source and versions", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Knowledge source / version", exact: true })).toBeVisible();
    await expect(page.locator("main")).toContainText("Assessment only"); await expect(page.locator("main")).toContainText("250.00");
    await checkpoint("quote-pdf-download", theme);

    const commitments = store.list<{ parentTaskId: string; status: string }>("commitment").filter(c => c.value.parentTaskId === task.id);
    expect(commitments).toHaveLength(1); expect(commitments[0]!.value.status).toBe("active");
    lifecycleClock.time += 3600000; const reply = await importAssessmentReply(scenario, lifecycleClock.time); expect(reply.threadId).toBe(customer.threadId);
    lifecycleClock.time += 14 * 86400000; await scenario.restart(); await scenario.app.business!.coordinator.sweep();
    await login(); await scenario.login();
    expect(scenario.app.business!.coordinator.store.get<{ status: string }>("commitment", commitments[0]!.id)!.value.status).toBe("suppressed");
    expect(scenario.providers.google.accepted).toHaveLength(1);
    await navigate(page, "settings", "Settings"); await page.reload();
    const commitment = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Assessment follow-through", exact: true }) }).last();
    await expect(commitment).toContainText("suppressed; next check none"); await checkpoint("followup-suppressed", theme);
    await navigate(page, `tasks/${task.id}`, "Task detail"); await openAction(page, send.id, "verified", `gmail:${sent.id}`);
    const persistedPdf = await page.request.get(`${scenario.url}/api/owner/files/${quote.artifactId}/download`);
    expect(persistedPdf.status()).toBe(200); expect(await persistedPdf.body()).toEqual(pdf);
    expect((await storedMail(scenario, sent.id)).parsed.attachments[0]!.content).toEqual(pdf);
  });

  test(`calendar lifecycle stale revision and direct provider stop ${theme}`, async ({ page, scenario, login, checkpoint }) => {
    await page.emulateMedia({ colorScheme: theme }); await login();
    const store = scenario.app.business!.coordinator.store;
    const input = { summary: "Synthetic assessment", start: { dateTime: "2026-10-23T10:00:00Z", timeZone: "UTC" }, end: { dateTime: "2026-10-23T11:00:00Z", timeZone: "UTC" }, attendees: [{ email: "customer@fixture.test" }], sendUpdates: "all" };
    let eventId = "", firstEtag = "", staleEtag = "";
    scenario.model.setResponses([
      toolCall("business_google", { operation: "insert", input }),
      transcript => {
        const inserted = toolResult(transcript, "business_google"); eventId = String(inserted.id); firstEtag = String(inserted.etag);
        expect(scenario.providers.calendar.events.size).toBe(1); expect(scenario.providers.calendar.events.get(eventId)).toMatchObject({ summary: input.summary, start: input.start, end: input.end, attendees: input.attendees, status: "confirmed" });
        return toolCall("business_google", { operation: "update", input: { ...input, id: eventId, etag: firstEtag, summary: "Revised assessment" } });
      },
      transcript => {
        const updated = toolResult(transcript, "business_google"); staleEtag = String(updated.etag); expect(staleEtag).not.toBe(firstEtag);
        expect(scenario.providers.calendar.events.size).toBe(1); expect(scenario.providers.calendar.events.get(eventId)?.summary).toBe("Revised assessment");
        return toolCall("business_google", { operation: "cancel", input: { id: eventId, etag: staleEtag, sendUpdates: "all" } });
      },
      () => finishFromEvidence(scenario, "Created, revised and cancelled the assessment appointment with Calendar readback.", ["business_google"]),
      fauxAssistantMessage("The appointment is cancelled and verified in Calendar."),
    ]);
    await delegate(page, "Create the synthetic assessment appointment, revise its summary, then cancel it.");
    await scenario.waitFor(() => store.tasks().some(t => t.status === "completed") && scenario.app.runtime.stats().busy === 0, "calendar lifecycle completed");
    const task = store.tasks().find(t => t.status === "completed")!;
    expect(scenario.providers.calendar.events.size).toBe(1); expect(scenario.providers.calendar.events.get(eventId)?.status).toBe("cancelled");
    const providerRead = await scenario.fetch(`${scenario.providers.calendar.url}/calendar/v3/calendars/owner%40fixture.test/events/${eventId}`);
    expect(providerRead.status).toBe(200); expect(await providerRead.json()).toEqual(scenario.providers.calendar.events.get(eventId));
    const actions = store.actions(task.id).filter(a => a.tool === "business_google" && a.effectful);
    expect(actions).toHaveLength(3); expect(actions.map(a => a.status)).toEqual(["verified", "verified", "verified"]);
    expect(scenario.providers.calendar.journal.filter(entry => entry.path.includes("/events") && ["POST", "PUT", "PATCH", "DELETE"].includes(entry.method)).map(entry => entry.method)).toEqual(["POST", "PUT", "DELETE"]);
    await navigate(page, `tasks/${task.id}`, "Task detail"); await page.reload();
    await expect(page.getByText("Status: completed", { exact: true })).toBeVisible();
    for (const action of actions) await openAction(page, action.id, "verified", `calendar:owner@fixture.test:${eventId}`);
    await checkpoint("calendar-lifecycle", theme);

    scenario.providers.calendar.raceUpdate(eventId, { summary: "Human restored booking", status: "confirmed" });
    const humanEvent = { ...scenario.providers.calendar.events.get(eventId)! };
    scenario.model.setResponses([
      toolCall("business_google", { operation: "update", input: { ...input, id: eventId, etag: staleEtag, summary: "Must not overwrite human" } }),
      transcript => {
        const response = transcript.messages.findLast(m => m.role === "toolResult" && m.toolName === "business_google"); expect(response?.role === "toolResult" && response.isError).toBe(true);
        return toolCall("task_wait", { kind: "missing_information", correlationKey: "calendar-human-change", question: "The appointment changed in Calendar. What should happen to the human-restored booking?" });
      },
      fauxAssistantMessage("The human edit is preserved; the stale revision was refused."),
    ]);
    await delegate(page, "Try the previous appointment revision, respecting its saved etag.");
    await scenario.waitFor(() => store.tasks().some(t => t.status === "waiting") && scenario.app.runtime.stats().busy === 0, "stale calendar revision refused");
    expect(scenario.providers.calendar.events.size).toBe(1); expect(scenario.providers.calendar.events.get(eventId)).toEqual(humanEvent);
    expect(store.actions().filter(a => a.tool === "business_google" && a.effectful && a.status === "verified")).toHaveLength(3);
    // The generic effect boundary conservatively retains adapter exceptions as unknown, never success.
    const refused = store.actions().find(a => a.tool === "business_google" && a.status === "unknown")!; expect(refused).toBeDefined();
    await navigate(page, `tasks/${refused.taskId}`, "Task detail"); await page.reload();
    await expect(page.getByText("Status: waiting", { exact: true })).toBeVisible(); await openAction(page, refused.id, "unknown");
    await checkpoint("calendar-conflict", theme);

    const gate = scenario.gate(); let entered = false, released = false;
    scenario.model.setResponses([
      async () => { entered = true; await gate.promise; released = true; return toolCall("business_google", { operation: "insert", input: { ...input, summary: "Must not dispatch after stop" } }); },
      fauxAssistantMessage("Stopped."),
    ]);
    await delegate(page, "Create one more synthetic appointment after the model gate opens.");
    await scenario.waitFor(() => entered && store.tasks().some(t => t.status === "running"), "gated calendar task active");
    const calls = scenario.providers.calendar.journal.filter(entry => entry.method !== "GET").length;
    await page.getByRole("button", { name: "Stop all work", exact: true }).click();
    await expect(page.getByRole("button", { name: "Resume work", exact: true })).toBeVisible();
    gate.release(); await scenario.waitFor(() => released && scenario.app.runtime.stats().busy === 0, "stopped provider task settles");
    expect(scenario.providers.calendar.journal.filter(entry => entry.method !== "GET")).toHaveLength(calls);
    expect(scenario.providers.calendar.events.size).toBe(1); expect(scenario.providers.calendar.events.get(eventId)).toEqual(humanEvent);
    await scenario.restart(); await page.goto(`${scenario.url}/workspace`);
    await page.getByLabel("Workspace token").fill(scenario.token); await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("button", { name: "Resume work", exact: true })).toBeVisible();
    await navigate(page, "overview", "Overview"); await page.reload();
    await expect(page.getByRole("heading", { name: "Globally stopped", exact: true })).toBeVisible();
    expect(scenario.app.business!.coordinator.store.settings().value.stopped).toBe(true);
    expect(scenario.providers.calendar.journal.filter(entry => entry.method !== "GET")).toHaveLength(calls);
    await checkpoint("provider-stop-persisted", theme);
  });

  test(`Gmail acceptance uncertainty reconciles after restart without resend ${theme}`, async ({ page, scenario, login, checkpoint }) => {
    await page.emulateMedia({ colorScheme: theme }); await login();
    scenario.providers.google.delaySentVisibility(); scenario.providers.google.acceptThenDrop();
    scenario.model.setResponses([
      toolCall("business_google", { operation: "send", input: { to: ["customer@fixture.test"], subject: "Synthetic acceptance probe", text: "One synthetic message; never retry an uncertain send." } }),
      fauxAssistantMessage("The send outcome is unknown and must be reconciled, not repeated."),
    ]);
    await delegate(page, "Send the synthetic acceptance probe once; never repeat an uncertain send.");
    await scenario.waitFor(() => scenario.app.business!.coordinator.store.actions().some(a => a.tool === "business_google" && a.status === "unknown"), "unknown Gmail receipt");
    expect(scenario.providers.google.accepted).toHaveLength(1); const sent = scenario.providers.google.accepted[0]!;
    const action = scenario.app.business!.coordinator.store.actions().find(a => a.tool === "business_google" && a.status === "unknown")!;
    expect((await storedMail(scenario, sent.id)).parsed.text).toContain("One synthetic message");
    await navigate(page, `tasks/${action.taskId}`, "Task detail"); await openAction(page, action.id, "unknown"); await checkpoint("gmail-reconciling", theme);
    await scenario.restart(); await scenario.app.business!.coordinator.sweep(); await login();
    await navigate(page, `tasks/${action.taskId}`, "Task detail"); await page.reload(); await openAction(page, action.id, "unknown");
    expect(scenario.providers.google.accepted).toHaveLength(1);
    scenario.providers.google.revealSent(); await scenario.app.business!.coordinator.sweep();
    expect(scenario.app.business!.coordinator.store.actions().find(a => a.id === action.id)).toMatchObject({ status: "verified", error: null });
    await page.reload(); const reconciled = await openAction(page, action.id, "verified", `gmail:${sent.id}`);
    await expect(reconciled).not.toContainText(action.error!);
    expect(scenario.providers.google.accepted).toHaveLength(1);
    expect(scenario.providers.google.attempts.filter(attempt => attempt.method === "POST" && attempt.path.endsWith("/messages/send"))).toHaveLength(1);
    expect((await storedMail(scenario, sent.id)).message.labelIds).toContain("SENT");
    await checkpoint("gmail-reconciled", theme);
  });
}
