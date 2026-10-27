import { mkdir, copyFile, readFile, writeFile } from "node:fs/promises";
import { rmSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Reporter, TestCase, TestResult, FullResult, TestStep } from "@playwright/test/reporter";
import { evidenceCases, affectedCases, type EvidenceCheckpoint } from "./evidence-manifest.js";
import { redactTrace, redactTraceValue } from "./redact-trace.js";
const escape = (value: unknown): string => String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
interface Captured extends EvidenceCheckpoint { testStatus: string; testTitle: string }
export default class EvidenceReporter implements Reporter {
  private readonly captured: Captured[] = [];
  private readonly failures: Array<{ title: string; status: string; screenshot: string | null; trace: string | null; traceDisclosure: string }> = [];
  private readonly suffix = process.env.INSTINCT_EVIDENCE_NEGATIVE_CASE === "1" ? "-negative" : "";
  private readonly root = resolve(`evidence${this.suffix}`);
  private readonly pending: Promise<void>[] = [];
  private captureErrors = 0;
  onBegin(): void {
    // Each manifest describes one run; never republish stale failures from earlier runs.
    rmSync(this.root, { recursive: true, force: true });
    mkdirSync(this.root, { recursive: true });
  }
  onStepBegin(_test: TestCase, _result: TestResult, step: TestStep): void { step.title = String(redactTraceValue(step.title)); }
  onStepEnd(_test: TestCase, _result: TestResult, step: TestStep): void {
    step.title = String(redactTraceValue(step.title));
    if (step.error) Object.assign(step.error, redactTraceValue(step.error));
  }
  onTestEnd(test: TestCase, result: TestResult): void {
    for (const error of result.errors) Object.assign(error, redactTraceValue(error));
    if (result.error) Object.assign(result.error, redactTraceValue(result.error));
    result.stdout = result.stdout.map(chunk => typeof chunk === "string" ? String(redactTraceValue(chunk)) : Buffer.from(String(redactTraceValue(chunk.toString()))));
    result.stderr = result.stderr.map(chunk => typeof chunk === "string" ? String(redactTraceValue(chunk)) : Buffer.from(String(redactTraceValue(chunk.toString()))));
    // Reporters receive this event synchronously. Remove the private ZIP before HTML/JSON serialize attachments.
    const trace = result.attachments.find(a => a.name === "trace" && a.path);
    if (trace) result.attachments.splice(result.attachments.indexOf(trace), 1);
    this.pending.push(this.captureResult(test, result, trace?.path).catch(() => { this.captureErrors++; }));
  }
  private async captureResult(test: TestCase, result: TestResult, tracePath?: string): Promise<void> {
    await mkdir(resolve(this.root, "screenshots"), { recursive: true });
    for (const attachment of result.attachments.filter(a => a.contentType === "application/vnd.instinct.evidence+json")) {
      const checkpoint = JSON.parse((attachment.body ?? await readFile(attachment.path!)).toString()) as EvidenceCheckpoint;
      const destination = `screenshots/${checkpoint.viewport}-${checkpoint.theme}-${checkpoint.caseId}.png`;
      await copyFile(checkpoint.screenshotPath, resolve(this.root, destination));
      this.captured.push({ ...checkpoint, screenshotPath: destination, testStatus: result.status, testTitle: test.title });
    }
    if (result.status === "passed" || result.status === "skipped") return;
    const failure = { title: test.title, status: result.status, screenshot: null as string | null, trace: null as string | null, traceDisclosure: "Raw traces are private and excluded from uploads." };
    const image = result.attachments.find(a => a.name === "failure-screenshot" && a.contentType === "image/png" && a.path);
    if (image?.path) { const filename = `screenshots/failure-${test.id.replace(/[^a-zA-Z0-9_-]/g, "_")}-${result.retry}.png`; await copyFile(image.path, resolve(this.root, filename)); failure.screenshot = filename; }
    else this.captureErrors++;
    if (tracePath) {
      try {
        const safe = await redactTrace(tracePath);
        await mkdir(resolve(this.root, "traces"), { recursive: true });
        const filename = `traces/failure-${test.id.replace(/[^a-zA-Z0-9_-]/g, "_")}-${result.retry}.redacted.zip`;
        await copyFile(safe, resolve(this.root, filename)); failure.trace = filename;
        failure.traceDisclosure = "Public trace retains sanitized events/DOM, without screencasts, image resources, request/response bodies or source files. Failure screenshots mask input fields. Raw trace remains local only.";
      } catch { this.captureErrors++; failure.traceDisclosure = "No public trace: safe redaction failed. Inspect raw trace locally only."; }
    } else this.captureErrors++;
    this.failures.push(failure);
  }
  async onEnd(result: FullResult): Promise<{ status: "failed" } | void> {
    await mkdir(this.root, { recursive: true });
    await Promise.all(this.pending);
    const changedPaths = (process.env.INSTINCT_CHANGED_PATHS ?? "").split("\n").filter(Boolean);
    const affected = affectedCases(changedPaths);
    const expected = evidenceCases.flatMap(entry => ["desktop", "mobile"].flatMap(viewport => ["light", "dark"].map(theme => ({ caseId: entry.id, viewport, theme }))));
    const missing = expected.filter(item => !this.captured.some(c => c.caseId === item.caseId && c.viewport === item.viewport && c.theme === item.theme));
    const evidenceFailed = this.captureErrors > 0 || Boolean(process.env.CI) && missing.length > 0;
    if (evidenceFailed) result.status = "failed";
    const manifest = { verificationMode: "emulated", overallStatus: result.status, captureErrors: this.captureErrors, changedPaths, affectedCaseIds: affected, cases: evidenceCases, expected, missing, checkpoints: this.captured, failures: this.failures, limitations: ["Real Chromium renders the actual compiled workspace and real controller services.", "Provider fixtures and deterministic model output prove local orchestration only, not live provider behavior or real model judgment.", "Computer protocol screenshots are synthetic; these workspace screenshots do not prove real desktop automation or isolation.", "No live-provider scenario was run by this browser suite."] };
    await writeFile(resolve(this.root, "manifest.json"), JSON.stringify(manifest, null, 2));
    const gallery = (items: Captured[]): string => items.map(item => `<article><h3>${escape(item.caseId)} / ${escape(item.viewport)} / ${escape(item.theme)}</h3><p>${escape(item.state)} · ${escape(item.route)} · ${escape(item.verificationMode)} · test ${escape(item.testStatus)}</p><ul>${item.assertions.map(a => `<li>${escape(a)}</li>`).join("")}</ul><p>Tasks: ${escape(item.taskIds.join(", ") || "none")}; actions: ${escape(item.actionIds.join(", ") || "none")}</p><a href="${escape(item.screenshotPath)}"><img src="${escape(item.screenshotPath)}" alt="${escape(`${item.caseId} ${item.viewport} ${item.theme}`)}" width="480" loading="lazy"></a></article>`).join("\n");
    const failureHtml = this.failures.map(f => `<article><h3>${escape(f.title)}: ${escape(f.status)}</h3><p>${escape(f.traceDisclosure)}</p>${f.screenshot ? `<a href="${escape(f.screenshot)}">Failure screenshot</a>` : "No failure screenshot was produced."} ${f.trace ? `<a href="${escape(f.trace)}">Redacted trace</a>` : ""}</article>`).join("\n");
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self'; base-uri 'none'; form-action 'none'"><title>Owner workspace evidence</title></head><body><h1>Owner workspace browser evidence</h1><p>Overall run: ${escape(result.status)}. All captured cases are emulated, not live-provider proof.</p><p><a href="manifest.json">Machine-readable manifest</a> · <a href="../playwright-report${this.suffix}/index.html">Playwright report</a></p><h2>Changed-feature evidence first</h2><p>${changedPaths.length ? changedPaths.map(escape).join("<br>") : "Changed paths unavailable: showing the complete gallery, never omitting unmapped changes."}</p>${gallery(this.captured.filter(c => affected.includes(c.caseId)))}<h2>Missing required evidence (${missing.length})</h2><ul>${missing.map(item => `<li>${escape(`${item.caseId} / ${item.viewport} / ${item.theme}`)}: not captured</li>`).join("")}</ul><h2>Failures and private trace handling</h2>${failureHtml || "<p>No failed test reported.</p>"}<h2>Complete screenshot gallery</h2>${gallery(this.captured)}<h2>Verification limits</h2><ul>${manifest.limitations.map(value => `<li>${escape(value)}</li>`).join("")}</ul></body></html>`;
    await writeFile(resolve(this.root, "index.html"), html);
    if (evidenceFailed) return { status: "failed" };
  }
}
