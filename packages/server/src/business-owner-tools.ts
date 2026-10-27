import { Type } from "typebox";
import { assertBusinessOwner, defineTool, textResult, type BusinessAuthority, type RegisteredTool, type ToolContext } from "@open-instinct/core";
import type { BusinessService } from "./business-service.js";
import type { OwnerConnections } from "./workspace-http.js";

/** Foreground manages delegated work. It has no operational provider/computer toolbox. */
export function businessOwnerTools(service: BusinessService, connections?: OwnerConnections): RegisteredTool[] {
  const { coordinator } = service; const { store } = coordinator;
  const access = (ctx: ToolContext) => {
    assertBusinessOwner(ctx.principal, ctx.channel);
    const source = ctx.businessOwnerSource;
    if (ctx.taskRun || !ctx.ownerTurn || !source) throw new Error("Direct authenticated owner instruction required");
    const authority = store.get<BusinessAuthority>("authority", source.authorityRef);
    if (!authority?.value.enabled || authority.value.kind !== "owner" || authority.value.sourceId !== source.messageId || authority.value.scope !== source.text) throw new Error("Owner instruction provenance mismatch");
    return source;
  };
  const meta = { capabilities: [] as [], group: "owner" as const, execution: "owner" as const };
  const result = (value: unknown) => textResult(JSON.stringify(value));
  const criteria = Type.Array(Type.String({ minLength: 1, maxLength: 2000 }), { minItems: 1, maxItems: 30 });
  return [
    defineTool({ name: "business_onboarding", label: "Continue business setup", description: "Read the saved business profile, next useful question, and actual app/computer readiness. Owner-only; never asks for credentials or assumes OAuth succeeded.", parameters: Type.Object({}), meta: { ...meta, effect: "read" }, execute: async (_args, ctx) => { access(ctx); return result(await service.onboarding.snapshot()); } }),
    defineTool({ name: "business_delegate", label: "Delegate durable work", description: "Persist this owner's effectful or multi-step request before acknowledging acceptance. Use one general task for this instruction, with observable done criteria. No operational effect occurs here. A task ID means accepted, never completed.", parameters: Type.Object({ objective: Type.String({ minLength: 1, maxLength: 20000 }), doneCriteria: criteria }), meta,
      execute: async (args, ctx) => {
        const source = access(ctx);
        const task = coordinator.admitTask({ channel: ctx.channel, conversationKey: ctx.deliveryKey ?? ctx.conversationKey, replyRef: ctx.replyRef ?? {}, requester: "owner", audience: "owner" }, source.authorityRef, { ...args, sourceRefs: [source.messageId] }, source.messageId);
        void coordinator.sweep();
        return result({ accepted: true, completed: false, taskId: task.id, status: task.status, objective: task.objective, doneCriteria: task.doneCriteria });
      } }),
    defineTool({ name: "business_tasks", label: "Inspect delegated work", description: "Read current durable task status and owner controls; this does not consume notices or delivery.", parameters: Type.Object({}), meta: { ...meta, effect: "read" }, execute: async (_args, ctx) => { access(ctx); return result({ settings: store.settings(), tasks: store.tasks() }); } }),
    defineTool({ name: "business_task", label: "Inspect task evidence", description: "Read one task's actual actions, waits and evidence. Never infer success from its acknowledgment.", parameters: Type.Object({ taskId: Type.String() }), meta: { ...meta, effect: "read" }, execute: async ({ taskId }, ctx) => { access(ctx); const task = store.task(taskId); if (!task) throw new Error("Task not found"); return result({ task, actions: store.actions(taskId), waits: store.waits(taskId) }); } }),
    defineTool({ name: "business_task_reply", label: "Answer missing task information", description: "Use only when the owner's current message answers a specific task's missing-information question. Read the task/version first. The server records the original owner text, not model-rewritten facts. Unrelated new requests must be delegated separately; provider challenges still require verification.", parameters: Type.Object({ taskId: Type.String(), expectedVersion: Type.Integer({ minimum: 1 }) }), meta,
      execute: async ({ taskId, expectedVersion }, ctx) => { const source = access(ctx); service.answerMissingInformation(ctx.principal, ctx.channel, taskId, expectedVersion, source.messageId, source.text); return result(store.task(taskId)); } }),
    defineTool({ name: "business_task_edit", label: "Change delegated work", description: "Change current work only from the actual owner's instruction and current expectedVersion. Old effects remain visible; uncertain effects are not replayed.", parameters: Type.Object({ taskId: Type.String(), expectedVersion: Type.Integer({ minimum: 1 }), objective: Type.String({ minLength: 1 }), doneCriteria: criteria }), meta,
      execute: async ({ taskId, expectedVersion, objective, doneCriteria }, ctx) => { const source = access(ctx); const task = coordinator.editTask(ctx.principal, taskId, expectedVersion, { objective, doneCriteria }); store.recordActivity("owner.task_edit", { sourceId: source.messageId }, task.id); return result(task); } }),
    defineTool({ name: "business_control", label: "Control business work", description: "Apply the direct owner's pause/resume/stop/close instruction. Target workspace or a task. Read current version before resume or task control. Stop cannot undo already dispatched external effects.", parameters: Type.Object({ target: Type.String(), operation: Type.Union([Type.Literal("pause"), Type.Literal("resume"), Type.Literal("stop"), Type.Literal("close")]), expectedVersion: Type.Integer({ minimum: 1 }) }), meta,
      execute: async ({ target, operation, expectedVersion }, ctx) => { const source = access(ctx); const current = target === "workspace" ? store.settings().version : store.task(target)?.version; if ((target !== "workspace" || operation === "resume") && current !== expectedVersion) throw new Error("Control revision conflict"); coordinator.control(ctx.principal, target, operation, ctx.channel); store.recordActivity("owner.control", { sourceId: source.messageId, target, operation }); return result({ settings: store.settings(), task: target === "workspace" ? null : store.task(target) }); } }),
    defineTool({ name: "business_connections", label: "Inspect connected apps", description: "Inspect verified account identity and local/upstream revocation state. A connection is not standing routine authority.", parameters: Type.Object({}), meta: { ...meta, group: "apps", effect: "read" }, execute: async (_args, ctx) => { access(ctx); if (!connections) return result(await service.onboarding.snapshot()); return result(await connections.list()); } }),
    defineTool({ name: "apps_connect", label: "Connect an owner app", description: "When the owner chooses to connect an app during setup or later, obtain its actual private OAuth URL. The connection is checked automatically; no done message is needed. No task worker may connect or widen accounts.", parameters: Type.Object({ toolkit: Type.String({ pattern: "^[a-zA-Z0-9_-]{1,80}$" }) }), meta: { ...meta, capabilities: ["apps.use", "trust.manage"], group: "apps" }, execute: async ({ toolkit }, ctx) => { access(ctx); return result(await service.onboarding.connect(toolkit)); } }),
    defineTool({ name: "business_disconnect", label: "Disconnect an owner app", description: "Disable access before requesting provider revocation. Requires current connection version and direct owner instruction.", parameters: Type.Object({ id: Type.String(), expectedVersion: Type.Integer({ minimum: 1 }) }), meta: { ...meta, capabilities: ["apps.use", "trust.manage"], group: "apps" }, execute: async ({ id, expectedVersion }, ctx) => { access(ctx); if (!connections) throw new Error("Connected apps unavailable"); return result(await connections.disconnect(id, expectedVersion)); } }),
  ];
}
