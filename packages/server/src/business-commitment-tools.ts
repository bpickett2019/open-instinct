import { Type } from "typebox";
import { businessHash, defineTool, nextCron, parseCron, textResult } from "@open-instinct/core";
import type { RegisteredTool, ToolContext } from "@open-instinct/core";
import { BusinessCommitments, DEFAULT_FOLLOW_UP } from "./business-commitments.js";
import type { BusinessCommitment, CommitmentOwner, CommitmentInput, RoutineInput } from "./business-commitments.js";

const contactHours = Type.Object({ days: Type.Array(Type.Integer({ minimum: 0, maximum: 6 }), { minItems: 1 }), startMinute: Type.Integer({ minimum: 0, maximum: 1439 }), endMinute: Type.Integer({ minimum: 1, maximum: 1440 }) });
const followUp = Type.Object({ maxUnanswered: Type.Integer({ minimum: 1 }), intervalHours: Type.Number({ exclusiveMinimum: 0 }), contactHours });
const premise = Type.Object({
  correlationKey: Type.Union([Type.String(), Type.Null()]), after: Type.Integer({ minimum: 0 }), eventCursor: Type.Integer({ minimum: 0 }),
  connection: Type.Union([Type.Object({ id: Type.String(), accountId: Type.String(), epoch: Type.Integer({ minimum: 0 }) }), Type.Null()]),
  sourceRevisions: Type.Record(Type.String(), Type.Integer({ minimum: 1 })), availabilityKey: Type.Union([Type.String(), Type.Null()]),
});
const routine = Type.Object({
  kind: Type.Union([Type.Literal("incoming-request"), Type.Literal("follow-through"), Type.Literal("daily-brief"), Type.Literal("meeting-prep")]),
  name: Type.String(), objective: Type.String(), doneCriteria: Type.Array(Type.String(), { minItems: 1 }), enabled: Type.Boolean(),
  sources: Type.Array(Type.Object({ connectionId: Type.String(), accountId: Type.String() })), timezone: Type.String(),
  cron: Type.Union([Type.String(), Type.Null()]), followUp,
});
function actor(ctx: ToolContext): CommitmentOwner { return { principal: ctx.principal, channel: ctx.channel, ownerTurn: ctx.ownerTurn === true, ...(ctx.taskRun ? { taskRun: ctx.taskRun } : {}) }; }
const result = (value: unknown) => textResult(JSON.stringify(value));

/** Register after core tools only in business mode. Personal schedules remain untouched. */
export function createBusinessCommitmentTools(service: BusinessCommitments): RegisteredTool[] {
  return [
    defineTool({
      name: "routine_list", label: "List standing routines", description: "Show owner-scoped standing routines, activation windows, connected source bindings and follow-up defaults. A connection never enables a routine.",
      parameters: Type.Object({}), meta: { capabilities: ["schedule.manage"], group: "schedule", execution: "owner", effect: "read" },
      execute: async (_args, ctx) => result(service.routines(actor(ctx))),
    }),
    defineTool({
      name: "routine_update", label: "Edit standing routine", description: "Direct owner only. Save the complete standing instruction using its current expectedVersion. Enabling starts a fresh activation window, never a historic inbox scan. Changes revoke the previous routine authority.",
      parameters: Type.Object({ id: Type.String(), expectedVersion: Type.Integer({ minimum: 1 }), routine }),
      meta: { capabilities: ["schedule.manage"], group: "schedule", execution: "owner", effect: "write" },
      execute: async ({ id, expectedVersion, routine: input }, ctx) => result(service.saveRoutine(actor(ctx), id, expectedVersion, input as RoutineInput)),
    }),
    defineTool({
      name: "schedule_create", label: "Create durable business schedule", description: "Direct owner only. Create durable work with a one-shot ISO timestamp or five-field cron and IANA timezone. A stable requestId dedupes retries. No background owner impersonation or personal scheduler is used.",
      parameters: Type.Object({ requestId: Type.String(), name: Type.String(), prompt: Type.String(), doneCriteria: Type.Array(Type.String(), { minItems: 1 }), cron: Type.Optional(Type.String()), tz: Type.Optional(Type.String()), at: Type.Optional(Type.String()) }),
      meta: { capabilities: ["schedule.manage"], group: "schedule", execution: "owner", effect: "write" },
      execute: async ({ requestId, name, prompt, doneCriteria, cron, tz, at }, ctx) => {
        if (Boolean(cron) === Boolean(at)) throw new Error("Specify exactly one of cron or at");
        const zone = tz ?? service.store.settings().value.timezone;
        const existing = service.store.get<BusinessCommitment>("commitment", `schedule:${businessHash(requestId)}`);
        const dueAt = cron ? existing?.value.dueAt ?? nextCron(parseCron(cron), new Date(service.store.now()), zone)?.getTime() : Date.parse(at!);
        if (dueAt === undefined || !Number.isSafeInteger(dueAt) || dueAt < 0) throw new Error("Invalid schedule timestamp or recurrence");
        return result(service.create(actor(ctx), { name, objective: prompt, doneCriteria, dueAt, timezone: zone, cron: cron ?? null, parentTaskId: null, routineId: null, sourceRefs: [], premise: { correlationKey: null, after: existing?.value.premise.after ?? service.store.now(), eventCursor: 0, connection: null, sourceRevisions: {}, availabilityKey: null }, followUp: null }, requestId));
      },
    }),
    defineTool({
      name: "schedule_list", label: "List durable commitments", description: "Direct owner only. List persisted schedules and commitments, current versions, next checks, occurrence tasks and cancellation reasons.",
      parameters: Type.Object({}), meta: { capabilities: ["schedule.manage"], group: "schedule", execution: "owner", effect: "read" },
      execute: async (_args, ctx) => result(service.commitments(actor(ctx))),
    }),
    defineTool({
      name: "schedule_delete", label: "Cancel durable commitment", description: "Direct owner only. Cancel a commitment and its outstanding occurrence by ID and expectedVersion. Already dispatched external actions cannot be recalled.",
      parameters: Type.Object({ id: Type.String(), expectedVersion: Type.Integer({ minimum: 1 }), reason: Type.String() }),
      meta: { capabilities: ["schedule.manage"], group: "schedule", execution: "owner", effect: "write" },
      execute: async ({ id, expectedVersion, reason }, ctx) => result(service.cancel(actor(ctx), id, expectedVersion, reason)),
    }),
    defineTool({
      name: "commitment_create", label: "Persist task follow-through", description: "Create one-shot or bounded follow-through work within this task's authority. Cannot enable routines. Follow-ups require owner-enabled follow-through, current account/source premise, at most two unanswered chases and 72 elapsed hours by default. Uses durable timers, never sleep in a model call.",
      parameters: Type.Object({ requestId: Type.String(), name: Type.String(), objective: Type.String(), doneCriteria: Type.Array(Type.String(), { minItems: 1 }), dueAt: Type.Integer({ minimum: 0 }), timezone: Type.String(), sourceRefs: Type.Array(Type.String()), premise, followUp: Type.Boolean() }),
      meta: { capabilities: ["schedule.manage"], group: "schedule", execution: "task", effect: "write" },
      execute: async ({ requestId, followUp: useFollowUp, ...input }, ctx) => {
        if (!ctx.taskRun) throw new Error("Task-bound commitment tool required");
        service.coordinator.assertActive(ctx.taskRun);
        const configured = service.store.get<{ followUp: typeof DEFAULT_FOLLOW_UP }>("routine", "follow-through")?.value.followUp;
        const value: Omit<CommitmentInput, "parentTaskId"> = { ...input, cron: null, routineId: null, followUp: useFollowUp ? configured ?? structuredClone(DEFAULT_FOLLOW_UP) : null };
        return result(service.createForTask(ctx.taskRun, value, requestId));
      },
    }),
    defineTool({
      name: "commitment_list", label: "Inspect task commitments", description: "Inspect only this task's durable commitments and next checks. No authority mutations.", parameters: Type.Object({}),
      meta: { capabilities: ["schedule.manage"], group: "schedule", execution: "task", effect: "read" },
      execute: async (_args, ctx) => {
        if (!ctx.taskRun) throw new Error("Task binding required");
        service.coordinator.assertActive(ctx.taskRun);
        return result(service.store.list<{ parentTaskId: string | null }>("commitment").filter(row => row.value.parentTaskId === ctx.taskRun!.taskId));
      },
    }),
  ];
}
