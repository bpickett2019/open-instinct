import { createRequire } from "node:module";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import type { BusinessConnection } from "@open-instinct/core";
import type { ScenarioApp } from "./scenario-app.js";
import { record } from "./emulators/http.js";

export const assessmentRates = "Fictional service assessment: fixed total USD 250.00 including all applicable taxes. Scope: one two-hour assessment; no installation.";
export const assessmentObjective = "Read the assessment request, quote from my uploaded rates, attach the sourced PDF and follow up only if unanswered.";
export const toolCall = (name: string, args: Record<string, unknown>) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
export function toolResult(transcript: unknown, name: string): Record<string, unknown> {
  const message = (record(transcript).messages as unknown[]).map(record).findLast(m => m.role === "toolResult" && m.toolName === name);
  if (!message || message.isError) throw new Error(`Actual ${name} result missing or failed`);
  return record(JSON.parse((message.content as unknown[]).map(record).filter(b => b.type === "text").map(b => b.text).join("\n")));
}

// Use the app adapter's existing MIME parser, not a second approximate MIME implementation.
const appsRequire = createRequire(new URL("../../apps/package.json", import.meta.url));
const { simpleParser } = appsRequire("mailparser") as { simpleParser(bytes: Buffer): Promise<{ subject: string; text: string; to: { value: Array<{ address: string }> }; attachments: Array<{ filename: string; contentType: string; content: Buffer }> }> };
export async function storedMail(scenario: ScenarioApp, id: string) {
  const response = await scenario.providers.google.requestUpstream(`/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=raw`);
  if (!response.ok) throw new Error(`Stored Gmail readback failed: ${response.status}`);
  const message = record(await response.json());
  if (typeof message.raw !== "string") throw new Error("Stored Gmail raw MIME missing");
  return { message, parsed: await simpleParser(Buffer.from(message.raw, "base64url")) };
}

export async function importAssessmentRequest(scenario: ScenarioApp, at: number) {
  return scenario.providers.google.importMessage(Buffer.from(`From: customer@fixture.test\r\nTo: owner@fixture.test\r\nSubject: Assessment request\r\nDate: ${new Date(at).toUTCString()}\r\nMessage-ID: <assessment-request@fixture.test>\r\n\r\nPlease quote one two-hour assessment, no installation.`).toString("base64url"));
}
export async function importAssessmentReply(scenario: ScenarioApp, at: number) {
  return scenario.providers.google.importMessage(Buffer.from(`From: customer@fixture.test\r\nTo: owner@fixture.test\r\nSubject: Re: Assessment quote\r\nDate: ${new Date(at).toUTCString()}\r\nMessage-ID: <assessment-reply@fixture.test>\r\nIn-Reply-To: <assessment-request@fixture.test>\r\nReferences: <assessment-request@fixture.test>\r\n\r\nThank you, I will contact you when ready.`).toString("base64url"));
}

/** Scripts only model decisions. Every result is obtained from registered production tools. */
export function scriptAssessmentQuote(scenario: ScenarioApp, sourceId: string, customer: { id: string; threadId: string }, now: () => number, inspect: { source?(chunk: Record<string, unknown>): void; price?(price: Record<string, unknown>): void } = {}) {
  const store = scenario.app.business!.coordinator.store;
  const connection = store.list<BusinessConnection>("connection").find(c => c.value.toolkit === "gmail")!;
  const outcome = { artifactId: "", quoteText: "" };
  const responses: FauxResponseStep[] = [
    toolCall("business_google", { operation: "message", input: { id: customer.id } }),
    toolCall("knowledge_source", { id: sourceId }),
    transcript => {
      const cited = toolResult(transcript, "knowledge_source"), chunk = record((cited.chunks as unknown[])[0]); inspect.source?.(chunk);
      return toolCall("business_price", { scope: "business", price: { kind: "fixed", currency: "USD", amount: { value: "250.00", citation: { sourceId: cited.id, sourceVersion: cited.sourceVersion, locator: chunk.locator } } } });
    },
    transcript => {
      const price = toolResult(transcript, "business_price"); inspect.price?.(price);
      outcome.quoteText = `Assessment only, no installation. Total USD ${(Number(price.minimumMinor) / 100).toFixed(2)}, including all applicable taxes.`;
      return toolCall("create_pdf", { path: "quote.pdf", title: "Synthetic assessment quote", markdown: `# Assessment quote\n\n${outcome.quoteText}\n\nSource: ${sourceId}` });
    },
    toolCall("artifact_register", { path: "quote.pdf", mimeType: "application/pdf", expectedText: ["Assessment only", "250.00", sourceId] }),
    transcript => {
      outcome.artifactId = String(toolResult(transcript, "artifact_register").id);
      return toolCall("business_google", { operation: "send", input: { to: ["customer@fixture.test"], subject: "Assessment quote", text: outcome.quoteText, threadId: customer.threadId, inReplyTo: "<assessment-request@fixture.test>", references: ["<assessment-request@fixture.test>"], artifactIds: [outcome.artifactId] } });
    },
    () => toolCall("commitment_create", { requestId: "assessment-followup", name: "Assessment follow-through", objective: "Ask whether the assessment quote needs clarification, only if unanswered", doneCriteria: ["One justified follow-up verified in Gmail"], dueAt: now() + 72 * 3600000, timezone: "UTC", sourceRefs: [sourceId], premise: { correlationKey: `gmail:${encodeURIComponent(connection.value.accountId)}:${encodeURIComponent(customer.threadId)}`, after: now(), eventCursor: 0, connection: { id: connection.id, accountId: connection.value.accountId, epoch: connection.value.epoch }, sourceRevisions: { [`knowledge:${sourceId}`]: store.get("knowledge", sourceId)!.version }, availabilityKey: null }, followUp: true }),
    () => finishFromEvidence(scenario, "Created the sourced PDF quote and verified its attached Gmail send; follow-through is scheduled.", ["artifact_register", "business_google"]),
    fauxAssistantMessage("The quote is verified in Gmail and follow-through is scheduled."),
  ];
  scenario.model.setResponses(responses);
  return outcome;
}
export function finishFromEvidence(scenario: ScenarioApp, result: string, tools: string[]) {
  const store = scenario.app.business!.coordinator.store, task = store.tasks().find(t => t.status === "running");
  if (!task) throw new Error("No running lifecycle task");
  const evidenceRefs = store.actions(task.id).filter(a => a.status === "verified" && tools.includes(a.tool)).flatMap(a => a.evidenceRefs);
  return toolCall("task_finish", { result, criteriaEvidence: task.doneCriteria.map((_, criterion) => ({ criterion, evidenceRefs })) });
}
