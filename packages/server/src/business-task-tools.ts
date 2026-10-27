import { Type } from "typebox";
import { defineTool, textResult, jsonValue } from "@open-instinct/core";
import type { Json, RegisteredTool, TaskRunBinding, ToolContext, WaitKind } from "@open-instinct/core";
import type { BusinessService } from "./business-service.js";

export function businessTaskTools(service: BusinessService): RegisteredTool[] {
  const coordinator = service.coordinator;
  const bound = (ctx: ToolContext): TaskRunBinding => {
    if (!ctx.taskRun || ctx.ownerTurn || ctx.principal.kind !== "owner" || ctx.principal.tier !== "owner" || ctx.principal.cappedFrom) throw new Error("Server-bound business worker required");
    coordinator.assertActive(ctx.taskRun); return ctx.taskRun;
  };
  const meta = { group: "system" as const, capabilities: ["converse" as const], effect: "read" as const, execution: "task" as const };
  return [
    defineTool({ name: "task_inspect", label: "Inspect current task", description: "Inspect this task's objective, done criteria, current checkpoint and actual action evidence. No model-selected task ID.", parameters: Type.Object({}), meta,
      execute: async (_args, ctx) => { const binding = bound(ctx); return textResult(JSON.stringify({ task: coordinator.store.task(binding.taskId), actions: coordinator.store.actions(binding.taskId), waits: coordinator.store.waits(binding.taskId) })); } }),
    defineTool({ name: "task_checkpoint", label: "Save internal task progress", description: "Persist internal plans, technical evidence, handoff instructions and progress. This text is never an owner message. This does not complete work or widen authority.", parameters: Type.Object({ checkpoint: Type.Unknown() }), meta,
      execute: async (args, ctx) => { const binding = bound(ctx); jsonValue(args.checkpoint); const next = coordinator.checkpoint(binding, args.checkpoint); if (!ctx.updateTaskRun) throw new Error("Runtime checkpoint binding unavailable"); ctx.updateTaskRun(next); return textResult("Checkpoint persisted; continue within this slice or wait."); } }),
    defineTool({ name: "task_finish", label: "Finish with outcome evidence", description: "Complete only when every indexed done criterion has verified action evidence. result is sent directly to the owner: give a brief, natural answer with honest limits, not a technical report or handoff. Put internal details in task_checkpoint. Tool success alone is not business success. Inspect evidence first.", parameters: Type.Object({ result: Type.String({ minLength: 1, maxLength: 20000, description: "The owner-facing answer. No internal notes, task IDs or reminders about previous sends." }), criteriaEvidence: Type.Array(Type.Object({ criterion: Type.Integer({ minimum: 0 }), evidenceRefs: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }) }), { minItems: 1 }) }), meta,
      execute: async (args, ctx) => { const binding = bound(ctx); const refs = [...new Set(args.criteriaEvidence.flatMap(item => item.evidenceRefs))]; const task = coordinator.complete(binding, args.result, refs, args.criteriaEvidence); return textResult(`Task ${task.id} completed with linked evidence. Business outcome beyond those observations remains unknown.`); } }),
    defineTool({ name: "task_wait", label: "Wait durably", description: "Persist a wait, then end this turn. question is sent directly to the owner and is allowed only for missing_information, provider_challenge or connection: ask for the necessary fact or owner action in plain language. Internal waits (timer, external_event, constraint, reconciliation) cannot send a question. Save technical notes and reminders in task_checkpoint. Omit question if the owner was already told. Provider acknowledgment never verifies success.", parameters: Type.Object({ kind: Type.Union(["timer", "external_event", "missing_information", "provider_challenge", "connection", "constraint", "reconciliation"].map(value => Type.Literal(value))), correlationKey: Type.String({ minLength: 1, maxLength: 300 }), deadline: Type.Optional(Type.String()), question: Type.Optional(Type.String({ minLength: 1, maxLength: 3000, description: "A new concise request for an owner fact or action. Only for missing_information, provider_challenge or connection. Never internal notes or a summary of an earlier message." })) }), meta,
      execute: async (args, ctx) => {
        const binding = bound(ctx); const task = coordinator.store.task(binding.taskId)!;
        if (args.question !== undefined && (!["missing_information", "provider_challenge", "connection"].includes(args.kind) || !args.question.trim())) throw new Error("question requires an owner-information, provider-challenge or connection wait and a nonempty owner-facing request. Save internal notes with task_checkpoint and omit question.");
        const deadline = args.deadline ? Date.parse(args.deadline) : null;
        if (deadline !== null && !Number.isFinite(deadline)) throw new Error("Invalid wait deadline");
        const wait = coordinator.wait(binding, { kind: args.kind as WaitKind, correlationKey: args.correlationKey, eventCursor: 0, deadline, requiresVerification: ["provider_challenge", "connection", "reconciliation"].includes(args.kind) });
        if (args.question) await service.taskNotice(task, `wait:${wait.id}`, args.question);
        return textResult(`Wait ${wait.id} persisted (${wait.status}). End the model turn; the controller resumes on the event or deadline.`);
      } }),
    defineTool({ name: "ask_owner", label: "Ask one missing fact", description: "Ask one genuinely missing fact or contradiction in a brief, natural owner-facing message, then wait. Internal progress and handoff notes belong in task_checkpoint. Never creates an approval record or asks for a routine yes.", parameters: Type.Object({ question: Type.Optional(Type.String({ minLength: 1, maxLength: 3000 })), summary: Type.Optional(Type.String({ minLength: 1, maxLength: 3000 })) }), meta,
      execute: async (args, ctx) => {
        const binding = bound(ctx); const task = coordinator.store.task(binding.taskId)!; const question = args.question ?? args.summary;
        if (!question) throw new Error("Missing question");
        const wait = coordinator.wait(binding, { kind: "missing_information", correlationKey: `owner-reply:${task.id}`, eventCursor: 0, deadline: null, requiresVerification: false });
        await service.taskNotice(task, `wait:${wait.id}`, question);
        return textResult("Question recorded once. Wait for the owner's fact; no routine approval was created.");
      } }),
  ];
}
