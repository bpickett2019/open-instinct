import { randomUUID } from "node:crypto";
import { findStringField, takeoverFailed, MaritimeMcpBackend, type ComputerBackend, type DetectComputerOptions } from "@open-instinct/computer";
import type { ToolContext } from "@open-instinct/core";
import type { BusinessService } from "./business-service.js";
import type { OwnerComputer } from "./workspace-http.js";

type Privacy = { takeover: boolean; credentialEntry: boolean; taskId: string | null };
/** Viewer capabilities stay in controller memory and the authenticated Computer response, never task history. */
export function businessComputer(service: BusinessService, backend: () => ComputerBackend | undefined): { boundary: NonNullable<DetectComputerOptions["business"]>; owner: OwnerComputer } {
  const { store } = service.coordinator;
  let viewerUrl: string | null = null;
  const privacy = (): Privacy => {
    const value = store.get<Privacy>("cursor", "computer:privacy")?.value;
    if (!value) return { takeover: false, credentialEntry: false, taskId: null };
    if (typeof value.takeover !== "boolean" || typeof value.credentialEntry !== "boolean" || value.taskId !== null && typeof value.taskId !== "string") throw new Error("Invalid persisted computer privacy");
    return value;
  };
  const save = (value: Privacy) => { const current = store.get("cursor", "computer:privacy"); store.put("cursor", "computer:privacy", value, current?.version ?? null); };
  const status = async () => {
    const value = privacy(); const available = backend()?.kind === "maritime";
    return { status: !available ? "unavailable" : value.takeover ? "takeover" : value.credentialEntry ? "private" : "ready", description: !available ? "Hosted computer unavailable. Configure the isolated computer provider credential." : value.takeover ? "Human takeover active. Model computer actions are blocked until provider verification." : value.credentialEntry ? "Credential-sensitive computer session. Screenshots and provider echoes are withheld." : "Isolated hosted computer; one task lease at a time.", takeoverUrl: value.takeover ? viewerUrl : null, taskId: value.taskId };
  };
  return {
    boundary: {
      workspaceId: store.settings().value.workspaceId,
      privacy,
      setPrivacy: value => save({ ...privacy(), ...value }),
      withLease: <T>(ctx: ToolContext, invoke: () => Promise<T>) => {
        if (!ctx.taskRun || !ctx.businessInvocation) throw new Error("Computer requires final business dispatch");
        return service.coordinator.withComputerLease(ctx.taskRun, async () => { save({ ...privacy(), taskId: ctx.taskRun!.taskId }); return invoke(); });
      },
      notifyTakeover: async (ctx, url) => {
        const parsed = new URL(url); if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname))) throw new Error("Unsafe provider viewer URL");
        viewerUrl = parsed.href;
        if (ctx.taskRun) {
          const task = store.task(ctx.taskRun.taskId);
          if (task) await service.taskNotice(task, `takeover:${ctx.taskRun.runId}`, "Open Computer in your authenticated owner workspace to complete the private takeover. Saying done does not verify the provider state.");
        }
      },
    },
    owner: {
      status,
      clearPrivacy: async () => {
        const computer = backend();
        if (!(computer instanceof MaritimeMcpBackend)) throw new Error("Hosted provider verification unavailable");
        const result = await computer.call("takeover_status", {}, AbortSignal.timeout(30_000));
        if (result.isError || takeoverFailed(result) || findStringField(result, "mode") !== "agent") throw new Error("Provider has not returned control; privacy remains fenced");
        save({ ...privacy(), takeover: false, credentialEntry: false });
        store.recordActivity("computer.privacy_owner_cleared", { principal: "owner", providerMode: "agent", sensitiveSessionCleared: true });
        return status();
      },
      check: async () => {
        const computer = backend(); if (!(computer instanceof MaritimeMcpBackend)) return status();
        const result = await computer.call("takeover_status", {}, AbortSignal.timeout(30_000));
        const value = privacy(); const mode = findStringField(result, "mode");
        const failed = result.isError || takeoverFailed(result);
        if (!failed && mode === "agent") {
          save({ ...value, takeover: false }); viewerUrl = null;
          if (value.taskId) service.coordinator.appendEvent({ id: randomUUID(), channel: "computer", correlationKey: `computer.takeover:${value.taskId}`, kind: "computer.takeover_returned", content: { mode: "agent" }, at: store.now(), verified: true });
        } else if (!failed && mode === "human") {
          save({ ...value, takeover: true });
          const url = findStringField(result, "viewer_url");
          if (url && new URL(url).protocol === "https:") viewerUrl = url;
        }
        if (failed) throw new Error("Provider takeover verification failed; current work remains blocked");
        return status();
      },
    },
  };
}
