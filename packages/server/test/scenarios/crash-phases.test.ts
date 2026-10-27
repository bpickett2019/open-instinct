import { afterEach, describe, expect, it } from "vitest";
import { fork, type ChildProcess } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BusinessAction, BusinessTask, Json } from "@open-instinct/core";
import { OutboundIsolation } from "../../testing/isolation.js";
import { createGoogleFixture } from "../../testing/emulators/google.js";
import { createCalendarFixture } from "../../testing/emulators/calendar.js";
import { createComposioFixture } from "../../testing/emulators/composio.js";
import { createMaritimeFixture } from "../../testing/emulators/maritime.js";
import { body, listenFixture, record, type FixtureServer } from "../../testing/emulators/http.js";

type Kind = "gmail" | "browser";
type Phase = "before-preparation" | "prepared" | "provider-accepted" | "before-commit";
interface Snapshot { tasks: BusinessTask[]; actions: BusinessAction[]; reservations: number; violations: string[]; accounting: { purchase: { heldMinor: number } } }
interface Message { event: string; id?: number; phase?: Phase; message?: string; snapshot?: Snapshot; outcome?: { verified: boolean; receipt: Json; evidenceRefs: string[] } }
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  const errors: unknown[] = [];
  for (const close of cleanup.splice(0).reverse()) try { await close(); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, "Crash fixture cleanup failed");
});

class ControllerChild {
  readonly process: ChildProcess;
  private readonly messages: Message[] = [];
  private readonly waiters = new Set<{ match: (message: Message) => boolean; resolve: (message: Message) => void; reject: (error: Error) => void }>();
  private sequence = 0;
  private failure?: Error;
  private diagnostics = "";
  private expectedExit = false;
  private readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  constructor() {
    this.process = fork(fileURLToPath(new URL("../../testing/crash-phase-worker.mjs", import.meta.url)), [], {
      execArgv: [], stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, NODE_NO_WARNINGS: "1" },
    });
    this.process.stdout!.on("data", chunk => { this.diagnostics = (this.diagnostics + String(chunk)).slice(-12000); });
    this.process.stderr!.on("data", chunk => { this.diagnostics = (this.diagnostics + String(chunk)).slice(-12000); });
    this.process.on("message", (message: Message) => {
      if (message.event === "error") { this.fail(new Error(message.message)); return; }
      for (const waiter of this.waiters) if (waiter.match(message)) { this.waiters.delete(waiter); waiter.resolve(message); return; }
      this.messages.push(message);
    });
    this.process.on("error", error => this.fail(error));
    const exit = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>();
    this.exited = exit.promise;
    this.process.once("exit", (code, signal) => {
      if (!this.expectedExit) this.fail(new Error(`Controller exited unexpectedly (${code}/${signal})\n${this.diagnostics}`));
      exit.resolve({ code, signal });
    });
    cleanup.push(() => this.stop());
  }
  private fail(error: Error) { this.failure = error; for (const waiter of this.waiters) waiter.reject(error); this.waiters.clear(); }
  receive(match: (message: Message) => boolean): Promise<Message> {
    if (this.failure) return Promise.reject(this.failure);
    const index = this.messages.findIndex(match);
    if (index >= 0) return Promise.resolve(this.messages.splice(index, 1)[0]!);
    const pending = Promise.withResolvers<Message>();
    const waiter = { match, resolve: (message: Message) => { clearTimeout(timer); pending.resolve(message); }, reject: (error: Error) => { clearTimeout(timer); pending.reject(error); } };
    // A failure watchdog for a separate OS process, never a synchronization delay.
    // Fake time cannot drive that process; successful cases await only IPC conditions.
    const timer = setTimeout(() => { this.waiters.delete(waiter); pending.reject(new Error(`Controller IPC condition timed out\n${this.diagnostics}`)); }, 20000);
    this.waiters.add(waiter);
    return pending.promise;
  }
  send(value: object) { this.process.send!(value); }
  async command(command: string): Promise<Snapshot> {
    const id = ++this.sequence, reply = this.receive(message => message.event === "result" && message.id === id);
    this.send({ command, id }); return (await reply).snapshot!;
  }
  async kill() {
    this.expectedExit = true;
    this.process.kill("SIGKILL");
    return this.exited;
  }
  async stop() {
    if (this.process.exitCode !== null || this.process.signalCode !== null) return;
    // Teardown must also terminate a synchronously frozen preparation gate after a failure.
    await this.kill();
  }
}

async function fixture(kind: Kind, phase: Phase) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "instinct-crash-phase-")));
  cleanup.push(async () => rmSync(root, { recursive: true, force: true }));
  const isolation = new OutboundIsolation();
  cleanup.push(async () => isolation.assertClean());
  const google = await createGoogleFixture(isolation); cleanup.push(() => google.close());
  const calendar = await createCalendarFixture(); isolation.allow(calendar.url); cleanup.push(() => calendar.close());
  const composio = await createComposioFixture(isolation, google.url, calendar.url); cleanup.push(() => composio.close());
  const maritime = await createMaritimeFixture(); isolation.allow(maritime.url); cleanup.push(() => maritime.close());
  // The provider-owned browser starts on a prefilled quote form. A click creates a
  // distinct remote submission every time: it is deliberately NOT idempotent. The
  // production hosted-computer MCP tool returns only protocol acceptance, not proof
  // of the business outcome. No shell command or fake controller receipt is involved.
  const browserSubmissions: Array<{ id: string; workspaceId: string; customer: string; quote: string }> = [];
  const browser: FixtureServer = await listenFixture(async (req, res, url) => {
    const request = req.method === "POST" ? await body(req) : undefined;
    const response = await isolation.fetch(maritime.url + url.pathname + url.search, {
      method: req.method, headers: { authorization: String(req.headers.authorization ?? ""), "content-type": "application/json" },
      ...(request ? { body: JSON.stringify(request) } : {}),
    });
    const bytes = await response.text();
    const params = record(request?.params ?? {}), args = record(params.arguments ?? {});
    if (request?.method === "tools/call" && params.name === "computer" && args.action === "left_click") {
      expect(args.coordinate).toEqual([240, 160]);
      const result = record(record(JSON.parse(bytes)).result);
      if (response.ok && !result.isError) browserSubmissions.push({ id: `submission-${browserSubmissions.length + 1}`, workspaceId: decodeURIComponent(url.pathname.split("/").at(-1)!), customer: "customer@fixture.test", quote: "One authorized quote, once." });
    }
    res.writeHead(response.status, { "content-type": response.headers.get("content-type") ?? "application/json" }); res.end(bytes);
  });
  isolation.allow(browser.url); cleanup.push(() => browser.close());
  async function start(reopen = false) {
    const controller = new ControllerChild(), ready = controller.receive(message => message.event === "ready");
    controller.send({ command: "init", options: { root, kind, phase, reopen, origins: [...isolation.origins], composio: composio.url, maritime: browser.url } });
    return { controller, snapshot: (await ready).snapshot! };
  }
  const effects = () => kind === "gmail" ? google.accepted.length : browserSubmissions.length;
  const submissions = () => kind === "gmail" ? google.attempts.filter(request => request.path.endsWith("/send")).length : maritime.invocations.filter(request => request.name === "computer" && request.args.action === "left_click").length;
  return { start, google, maritime, browserSubmissions, effects, submissions };
}

const phases: Phase[] = ["before-preparation", "prepared", "provider-accepted", "before-commit"];
describe.sequential("BO283/G2: abrupt controller process death at durable external-effect boundaries", () => {
  for (const kind of ["gmail", "browser"] as const) it.each(phases)(`${kind}: SIGKILL at %s, reopen SQLite and never replay an uncertain effect`, async phase => {
    const f = await fixture(kind, phase);
    // Unknown acceptance is initially invisible to Gmail readback. Later visibility
    // is an explicit provider-state change, not a sleep or an invented local proof.
    if (kind === "gmail" && phase === "provider-accepted") f.google.delaySentVisibility();
    const first = await f.start();
    expect(first.snapshot.tasks).toHaveLength(0);
    const reached = first.controller.receive(message => message.event === "phase" && message.phase === phase);
    first.controller.send({ command: "admit" });
    const crash = await reached, before = crash.snapshot!;
    expect(before.violations).toEqual([]);
    expect(before.tasks).toHaveLength(1);
    expect(before.tasks[0]!.status).toBe("running");
    const wasSubmitted = phase === "provider-accepted" || phase === "before-commit";
    expect(f.effects()).toBe(wasSubmitted ? 1 : 0);
    expect(f.submissions()).toBe(wasSubmitted ? 1 : 0);
    expect(before.actions).toHaveLength(phase === "before-preparation" ? 0 : 1);
    if (phase === "prepared") { expect(before.actions[0]!.status).toBe("prepared"); expect(before.actions[0]!.receipt).toBeNull(); expect(before.reservations).toBe(1); }
    if (phase === "provider-accepted") { expect(before.actions[0]!.status).toBe("dispatching"); expect(before.actions[0]!.receipt).toBeNull(); }
    if (phase === "before-commit") {
      expect(crash.outcome!.verified).toBe(kind === "gmail");
      if (kind === "gmail") { expect(before.actions[0]!.status).toBe("accepted"); expect(before.actions[0]!.receipt).not.toBeNull(); expect(crash.outcome!.evidenceRefs).toContain(`gmail:${f.google.accepted[0]!.id}`); }
      else { expect(before.actions[0]!.status).toBe("dispatching"); expect(crash.outcome!.evidenceRefs).toEqual([]); }
    }
    // This assertion rules out graceful close, HTTP drop, or a simulated exception.
    expect(await first.controller.kill()).toEqual({ code: null, signal: "SIGKILL" });
    const reopened = await f.start(true), recovered = reopened.snapshot;
    expect(recovered.tasks).toHaveLength(1);
    expect(recovered.tasks[0]!.id).toBe(before.tasks[0]!.id);
    expect(recovered.tasks[0]!.status).toBe(wasSubmitted ? "blocked" : "queued");
    if (phase !== "before-preparation") {
      expect(recovered.actions[0]!.id).toBe(before.actions[0]!.id);
      expect(recovered.actions[0]!.argsHash).toBe(before.actions[0]!.argsHash);
      expect(recovered.actions[0]!.status).toBe(phase === "prepared" ? "prepared" : kind === "gmail" && phase === "before-commit" ? "accepted" : "unknown");
      expect(recovered.actions[0]!.receipt).toEqual(before.actions[0]!.receipt);
    }
    let settled = await reopened.controller.command("sweep");
    if (kind === "gmail" && phase === "provider-accepted") {
      expect(settled.actions[0]!.status).toBe("unknown"); expect(settled.tasks[0]!.status).toBe("blocked");
      expect(f.effects()).toBe(1); expect(f.submissions()).toBe(1);
      // Repeated actual controller sweeps must hold rather than replay the send.
      settled = await reopened.controller.command("sweep");
      expect(settled.actions[0]!.status).toBe("unknown"); expect(f.submissions()).toBe(1);
      f.google.revealSent();
      settled = await reopened.controller.command("sweep");
    }
    expect(settled.violations).toEqual([]);
    expect(settled.tasks).toHaveLength(1);
    expect(settled.actions).toHaveLength(1);
    expect(f.effects()).toBe(1); expect(f.submissions()).toBe(1);
    // A prepared logical action retains its identity/reservation across the reopen;
    // the real reserve callback is not invoked a second time on safe resumption.
    expect(before.reservations + settled.reservations).toBe(1);
    if (phase === "prepared") expect(settled.actions[0]!.id).toBe(before.actions[0]!.id);
    if (kind === "gmail") {
      expect(settled.actions[0]!.status).toBe("verified");
      expect(settled.actions[0]!.evidenceRefs).toContain(`gmail:${f.google.accepted[0]!.id}`);
      expect(settled.tasks[0]!.status).toBe("completed");
      expect(await f.google.allMessages()).toHaveLength(1);
    } else {
      expect(settled.actions[0]!.status).toBe(wasSubmitted ? "unknown" : "accepted");
      expect(["blocked", "waiting"]).toContain(settled.tasks[0]!.status);
      expect(settled.actions[0]!.evidenceRefs).toEqual([]);
      expect(f.maritime.invocations.some(request => request.name === "shell")).toBe(false);
      expect(f.browserSubmissions).toHaveLength(1);
    }
    const again = await reopened.controller.command("sweep");
    expect(again.actions).toEqual(settled.actions);
    expect(again.tasks[0]!.status).toBe(settled.tasks[0]!.status);
    expect(f.effects()).toBe(1); expect(f.submissions()).toBe(1);
  }, 60000);
});
