import { afterEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { BusinessAuthority, BusinessConnection } from "@open-instinct/core";
import { createScenarioApp, type ScenarioApp } from "../../testing/scenario-app.js";
import { record } from "../../testing/emulators/http.js";
import { DEFAULT_FOLLOW_UP, nextContactTime, type BusinessCommitment, type BusinessRoutine } from "../../src/business-commitments.js";
import { assessmentRates, assessmentObjective, importAssessmentRequest, scriptAssessmentQuote, storedMail, finishFromEvidence, toolCall, toolResult } from "../../testing/document-lifecycle.js";

const instances: ScenarioApp[] = [];
const HOUR = 3_600_000;
afterEach(async () => { for (const s of instances.splice(0).reverse()) await s.close(); });

describe.sequential("Autonomous unanswered follow-through (emulated)", () => {
  it("sends one routine-authorized chase after controller downtime, dedupes restarts, and stops at two unanswered occurrences", async () => {
    // Gmail's emulator timestamps sends with wall time. Keep the injected business
    // clock ahead of it without altering provider receipts or production bounds.
    let time = nextContactTime(Date.now() + 24 * HOUR, "UTC", DEFAULT_FOLLOW_UP.contactHours);
    const s = await createScenarioApp({ responses: [], now: () => new Date(time) });
    instances.push(s);
    await s.login();
    const store = () => s.app.business!.coordinator.store;
    const uploaded = await s.owner("/knowledge", { method: "POST", body: {
      filename: "assessment-follow-through-rates.txt", mimeType: "text/plain",
      base64: Buffer.from(assessmentRates).toString("base64"), authoritative: true,
    } });
    expect(uploaded.status).toBe(201);
    const source = record(await uploaded.json());
    const connection = store().list<BusinessConnection>("connection").find(row => row.value.toolkit === "gmail")!;
    const routine = store().get<BusinessRoutine>("routine", "follow-through")!;
    expect((await s.owner("/routines/follow-through", { method: "PATCH", body: {
      expectedVersion: routine.version,
      routine: {
        kind: "follow-through", name: "Assessment quote and unanswered follow-through",
        objective: assessmentObjective, doneCriteria: ["Verify the sourced quote and any justified follow-through in Gmail"],
        enabled: true, sources: [{ connectionId: connection.id, accountId: connection.value.accountId }],
        timezone: "UTC", cron: null, followUp: DEFAULT_FOLLOW_UP,
      },
    } })).status).toBe(200);
    const authorityRef = store().get<BusinessRoutine>("routine", routine.id)!.value.authorityRef!;
    expect(store().get<BusinessAuthority>("authority", authorityRef)?.value).toMatchObject({ kind: "routine", enabled: true });

    const customer = await importAssessmentRequest(s, time);
    const quote = scriptAssessmentQuote(s, String(source.id), customer, () => time);
    // Admission uses the production service and persisted, owner-enabled routine
    // authority, not browser/message ingress or hand-written task/action state.
    const original = s.app.business!.coordinator.admitTask({
      channel: "chat", conversationKey: "business:scenario:follow-through", replyRef: {}, requester: "owner", audience: "owner",
    }, authorityRef, {
      objective: assessmentObjective, doneCriteria: ["Verify the sourced PDF quote in the customer's Gmail thread"],
      sourceRefs: [String(source.id), `gmail:${customer.id}`],
    }, "scenario:assessment-follow-through");
    await s.app.business!.coordinator.sweep();
    await s.waitFor(() => store().task(original.id)?.status === "completed" && s.app.runtime.stats().busy === 0, "routine-authorized original quote completion");
    expect(s.providers.google.accepted).toHaveLength(1);
    const originalSend = s.providers.google.accepted[0]!;
    const originalMail = await storedMail(s, originalSend.id);
    expect(originalSend.threadId).toBe(customer.threadId);
    expect(originalMail.parsed.text).toContain(quote.quoteText);
    expect(originalMail.parsed.attachments).toHaveLength(1);
    expect(Number(originalMail.message.internalDate)).toBeLessThanOrEqual(time);

    const commitments = store().list<BusinessCommitment>("commitment").filter(row => row.value.parentTaskId === original.id);
    expect(commitments).toHaveLength(1);
    const commitmentId = commitments[0]!.id;
    const commitment = () => store().get<BusinessCommitment>("commitment", commitmentId)!.value;
    const initial = commitment();
    expect(initial).toMatchObject({ status: "active", occurrence: 0, lastTaskId: null, authorityRef, followUp: DEFAULT_FOLLOW_UP });
    expect(initial.nextCheck).toBe(time + DEFAULT_FOLLOW_UP.intervalHours * HOUR);
    expect(initial.premise.sourceRevisions[`knowledge:${source.id}`]).toBe(store().get("knowledge", String(source.id))!.version);

    await s.restart();
    await s.app.business!.coordinator.sweep();
    expect(commitment()).toEqual(initial);
    expect(s.providers.google.accepted).toHaveLength(1);
    time = initial.nextCheck! - 1;
    await s.app.business!.coordinator.sweep();
    expect(commitment().occurrence).toBe(0);
    expect(s.providers.google.accepted).toHaveLength(1);

    function scriptChase(text: string) {
      s.model.setResponses([
        toolCall("business_google", { operation: "thread", input: { id: customer.threadId } }),
        transcript => {
          const thread = toolResult(transcript, "business_google");
          expect(thread.id).toBe(customer.threadId);
          expect((thread.messages as unknown[]).map(record).map(message => message.id)).toContain(originalSend.id);
          return toolCall("business_google", { operation: "send", input: {
            to: ["customer@fixture.test"], subject: "Re: Assessment quote", text,
            threadId: customer.threadId, inReplyTo: "<assessment-request@fixture.test>", references: ["<assessment-request@fixture.test>"],
          } });
        },
        () => finishFromEvidence(s, "Verified the justified unanswered assessment follow-up in Gmail.", ["business_google"]),
        fauxAssistantMessage("The unanswered assessment follow-up is verified in Gmail."),
      ]);
    }
    async function completedOccurrence(occurrence: number, text: string) {
      await s.app.business!.coordinator.sweep();
      await s.waitFor(() => {
        const current = commitment();
        return current.occurrence === occurrence && current.lastTaskId !== null && store().task(current.lastTaskId)?.status === "completed" && s.app.runtime.stats().busy === 0;
      }, `verified autonomous follow-up ${occurrence}`);
      const current = commitment(), task = store().task(current.lastTaskId!)!;
      expect(task.authorityRef).toBe(authorityRef);
      expect(store().get("cursor", `commitment-task:${task.id}`)?.value).toEqual({ commitmentId, occurrence });
      const sends = store().actions(task.id).filter(action => action.tool === "business_google" && action.effectful);
      expect(sends).toHaveLength(1);
      expect(sends[0]!.status).toBe("verified");
      expect(s.providers.google.accepted).toHaveLength(occurrence + 1);
      const sent = s.providers.google.accepted[occurrence]!;
      expect(sent.threadId).toBe(customer.threadId);
      expect(sends[0]!.evidenceRefs).toContain(`gmail:${sent.id}`);
      const { message, parsed } = await storedMail(s, sent.id);
      expect(message.labelIds).toContain("SENT");
      expect(parsed.to.value.map(address => address.address)).toEqual(["customer@fixture.test"]);
      expect(parsed.subject).toBe("Re: Assessment quote");
      expect(parsed.text.trim()).toBe(text);
      expect(s.state.readJson<unknown[]>("approvals.json", [])).toEqual([]);
      return task.id;
    }
    async function assertInventory(expectedSent: number) {
      expect(s.providers.google.accepted).toHaveLength(expectedSent);
      const inventory = await s.providers.google.allMessages();
      expect(inventory.map(message => message.id).sort()).toEqual([customer.id, ...s.providers.google.accepted.map(message => message.id)].sort());
      const response = await s.providers.google.requestUpstream(`/gmail/v1/users/me/threads/${encodeURIComponent(customer.threadId)}`);
      expect(response.status).toBe(200);
      const thread = record(await response.json());
      expect((thread.messages as unknown[]).map(record).map(message => message.id).sort()).toEqual(inventory.map(message => message.id).sort());
    }

    const firstText = "Does the USD 250.00 assessment quote need any clarification? No installation is included.";
    scriptChase(firstText);
    // Several missed 72-hour windows still admit only one fresh occurrence.
    await s.restart(async () => { time = nextContactTime(initial.nextCheck! + 14 * 24 * HOUR, "UTC", DEFAULT_FOLLOW_UP.contactHours); });
    const firstAt = time;
    const firstTaskId = await completedOccurrence(1, firstText);
    expect(commitment().lastOccurrenceAt).toBe(firstAt);
    expect(commitment().nextCheck).toBe(firstAt + DEFAULT_FOLLOW_UP.intervalHours * HOUR);
    for (let sweep = 0; sweep < 3; sweep++) await s.app.business!.coordinator.sweep();
    await s.restart();
    await s.app.business!.coordinator.sweep();
    expect(commitment()).toMatchObject({ occurrence: 1, lastTaskId: firstTaskId });
    expect(store().tasks()).toHaveLength(2);
    await assertInventory(2);

    time = firstAt + DEFAULT_FOLLOW_UP.intervalHours * HOUR - 1;
    await s.app.business!.coordinator.sweep();
    expect(commitment().occurrence).toBe(1);
    await assertInventory(2);
    const secondAt = nextContactTime(firstAt + DEFAULT_FOLLOW_UP.intervalHours * HOUR, "UTC", DEFAULT_FOLLOW_UP.contactHours);
    const secondText = "Final check on the USD 250.00 assessment quote. Please contact us if you would like to proceed.";
    scriptChase(secondText);
    await s.restart(async () => { time = secondAt; });
    const secondTaskId = await completedOccurrence(2, secondText);
    expect(secondAt - firstAt).toBeGreaterThanOrEqual(DEFAULT_FOLLOW_UP.intervalHours * HOUR);
    await s.app.business!.coordinator.sweep();
    expect(commitment()).toMatchObject({ status: "completed", occurrence: DEFAULT_FOLLOW_UP.maxUnanswered, lastTaskId: secondTaskId, nextCheck: null });

    // A completed unanswered schedule cannot replay even after long downtime.
    await s.restart(async () => { time += 90 * 24 * HOUR; });
    for (let sweep = 0; sweep < 3; sweep++) await s.app.business!.coordinator.sweep();
    await s.restart();
    await s.app.business!.coordinator.sweep();
    expect(commitment()).toMatchObject({ status: "completed", occurrence: 2, lastTaskId: secondTaskId, nextCheck: null });
    expect(store().tasks()).toHaveLength(3);
    await assertInventory(3);
    expect(s.state.readJson<unknown[]>("approvals.json", [])).toEqual([]);
  }, 30_000);
});
