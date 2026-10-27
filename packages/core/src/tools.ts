/**
 * Tool registry. Every tool the agent can call is a ToolSpec: a TypeBox schema, an
 * execute function and a ToolMeta tag with the capabilities it needs. The registry
 * turns specs into Pi AgentTools bound to one conversation's ToolContext.
 */
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Static, TSchema } from "typebox";
import type { Channel, Principal, ToolMeta } from "./types.js";
import type { BusinessDispatch, TaskRunBinding, Json, LogicalAction } from "./business-types.js";
import { businessHash } from "./business-store.js";

export interface ToolContext {
  principal: Principal;
  conversationKey: string;
  /** Channel address, distinct from a per-principal or per-task runtime key. */
  deliveryKey?: string;
  replyRef?: Record<string, string | undefined>;
  /** Persisted inbound/event identity; registry derives a per-tool/step identity from it. */
  messageId?: string;
  /** Bound by the runtime; worker tools never accept a model-selected task. */
  assertA2AActive?: () => Promise<void>;
  markA2AState?: (state: string) => void;
  channel: Channel;
  /** Runtime-created authority, never accepted from model arguments. */
  taskRun?: TaskRunBinding;
  businessDispatch?: BusinessDispatch;
  nextBusinessStep?: (toolCallId: string, tool: string, args: unknown) => string;
  updateTaskRun?: (binding: TaskRunBinding) => void;
  /** Set only during the final dispatcher invocation, not by model arguments. */
  businessInvocation?: boolean;
  recordBusinessReceipt?: (receipt: Json) => void;
  /** Recheck all execution fences after adapter prerequisites, immediately before external submission. */
  assertBusinessDispatch?: () => void;
  authorizeBusinessOperation?: (tool: string, meta: ToolMeta, args: unknown) => void;
  redact?: <T>(value: T) => T;
  recordBusinessSource?: (sourceId: string, revision: number) => void;
  businessSources?: () => Record<string, number>;
  businessOwnerSource?: Readonly<{ authorityRef: string; text: string; messageId: string }>;
  /** Bound to the current admitted owner message; absent from workers and guidance. */
  businessOwnerReaction?: (messageId: string, reaction: string, signal?: AbortSignal) => Promise<void>;
  businessConnection?: LogicalAction["connection"];
  /**
   * True only while the current run was started by the owner's own direct message on a
   * carrier-bound or local channel (iMessage, SMS, chat). False for email, group threads,
   * delegated A2A results, scheduled jobs and resumed conversations, whose text the owner
   * did not write.
   */
  ownerTurn?: boolean;
  now(): Date;
}

export type ToolResultLike =
  | string
  | {
      content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
      details?: unknown;
      isError?: boolean;
    };

export interface ToolSpec<T extends TSchema = TSchema> {
  name: string;
  label: string;
  description: string;
  parameters: T;
  meta: ToolMeta;
  /** Pi's pre-schema hook. Reject lossy coercion before validation; never performs effects. */
  prepareArguments?: AgentTool<T>["prepareArguments"];
  execute: (args: Static<T>, ctx: ToolContext, signal?: AbortSignal) => Promise<ToolResultLike>;
  /** Adapter readback, not model-provided proof. Omit when only a tool receipt is available. */
  verify?: (args: Static<T>, result: ToolResultLike, ctx: ToolContext, signal?: AbortSignal) => Promise<{ receipt: Json; evidenceRefs: string[]; verified: boolean }>;
  /** Normalize effect identity before write-ahead accounting. Never performs the effect. */
  prepareBusiness?: (args: Static<T>, ctx: ToolContext) => Promise<{ args: Json; connection?: LogicalAction["connection"]; sourceRevisions?: Record<string, number>; allowance?: LogicalAction["allowance"]; resolvedMeta?: ToolMeta; resolvedTool?: string }>;
}

export interface RegisteredTool {
  spec: ToolSpec<any>;
}

const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** Wrap a spec so the generic parameter is inferred once and the schema stays typed. */
export function defineTool<T extends TSchema>(spec: ToolSpec<T>): RegisteredTool {
  if (!TOOL_NAME.test(spec.name)) {
    throw new Error(`Invalid tool name "${spec.name}": use [A-Za-z0-9_-], at most 64 characters`);
  }
  return { spec };
}

export function textResult(text: string): ToolResultLike {
  return { content: [{ type: "text", text }] };
}

/** Pi wants content blocks. Strings become one text block; empty strings still produce a block. */
export function toAgentToolResult(result: ToolResultLike): AgentToolResult<unknown> {
  if (typeof result === "string") {
    return { content: [{ type: "text", text: result }], details: undefined };
  }
  return {
    content: result.content.length > 0 ? result.content : [{ type: "text", text: "" }],
    details: result.details,
    ...(result.isError ? { isError: true } : {}),
  };
}

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  register(tool: RegisteredTool): void {
    // Later registrations win so a package can override a core tool on purpose.
    this.tools.set(tool.spec.name, tool);
  }

  registerMany(tools: RegisteredTool[]): void {
    for (const tool of tools) this.register(tool);
  }

  all(): RegisteredTool[] {
    return [...this.tools.values()];
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  meta(name: string): ToolMeta | undefined {
    return this.tools.get(name)?.spec.meta;
  }

  /**
   * Build Pi AgentTools for one conversation. The filter decides visibility (what the model
   * can see); the policy guard in the runtime decides execution.
   */
  bind(ctx: ToolContext, filter?: (t: RegisteredTool) => boolean): AgentTool<any>[] {
    const out: AgentTool<any>[] = [];
    for (const tool of this.tools.values()) {
      if (filter && !filter(tool)) continue;
      out.push(bindOne(tool, ctx));
    }
    return out;
  }
}

function bindOne(tool: RegisteredTool, boundContext: ToolContext): AgentTool<any> {
  const spec = tool.spec;
  return {
    name: spec.name,
    label: spec.label,
    description: spec.description,
    parameters: spec.parameters,
    prepareArguments: spec.prepareArguments,
    execute: async (toolCallId, params, signal) => {
      // Capture provenance per invocation, including when tools await concurrently.
      const ctx: ToolContext = { ...boundContext, messageId: `tool:${boundContext.messageId ?? boundContext.conversationKey}:${toolCallId}` };
      if (ctx.redact && businessHash(ctx.redact(params)) !== businessHash(params)) throw new Error("Sensitive values must use a private credential path");
      if (ctx.taskRun) {
        if (!ctx.businessDispatch || !ctx.nextBusinessStep) throw new Error("Task dispatcher not bound");
        if (spec.meta.execution === "owner") throw new Error("Task workers cannot invoke owner controls");
        if (spec.meta.execution === "task") return toAgentToolResult(await spec.execute(params, ctx, signal));
        const prepared: Awaited<ReturnType<NonNullable<ToolSpec["prepareBusiness"]>>> = spec.prepareBusiness ? await spec.prepareBusiness(params, ctx) : { args: params as Json };
        const meta = prepared.resolvedMeta ?? spec.meta;
        if (prepared.resolvedMeta) {
          if (!ctx.authorizeBusinessOperation || !prepared.resolvedTool) throw new Error("Concrete business policy guard unavailable");
          ctx.authorizeBusinessOperation(prepared.resolvedTool, meta, prepared.args);
        }
        if (ctx.redact && businessHash(ctx.redact(prepared.args)) !== businessHash(prepared.args)) throw new Error("Raw credentials are forbidden in model tool arguments; use an opaque reference or private takeover");
        const amount = meta.amountUsd?.(prepared.args);
        if (amount !== undefined && (!Number.isFinite(amount) || amount < 0 || !Number.isSafeInteger(Math.round(amount * 100)))) throw new Error("Invalid purchase amount");
        const allowance = prepared.allowance ?? (amount === undefined ? undefined : { category: "purchase" as const, amountMinor: Math.round(amount * 100), currency: "USD" });
        const stepId = meta.effect === "read" ? `${ctx.taskRun.runId}:read:${toolCallId}:${businessHash(prepared.args)}` : ctx.nextBusinessStep(toolCallId, spec.name, prepared.args);
        ctx.messageId = `task:${ctx.taskRun.taskId}:${stepId}`;
        const binding = ctx.taskRun;
        const action: LogicalAction = {
          stepId,
          tool: spec.name,
          arguments: prepared.args,
          sourceRevisions: { ...(meta.effect === "read" ? {} : ctx.businessSources?.()), ...prepared.sourceRevisions },
          ...(prepared.connection ? { connection: prepared.connection } : {}),
          ...(allowance ? { allowance } : {}),
          toolCallId,
          effectful: meta.effect !== "read",
          spendCapable: meta.capabilities.some(capability => capability === "purchase" || capability === "travel.book"),
          unpricedModel: meta.unpricedModel === true,
        };
        const result = await ctx.businessDispatch.invoke(binding, action, async (dispatchSignal) => {
          ctx.businessInvocation = true;
          ctx.businessConnection = prepared.connection;
          ctx.assertBusinessDispatch = () => { dispatchSignal.throwIfAborted(); ctx.businessDispatch!.assertDispatch(binding, action); };
          ctx.recordBusinessReceipt = receipt => ctx.businessDispatch!.recordReceipt?.(binding, stepId, ctx.redact ? ctx.redact(receipt) : receipt);
          try {
            const raw = await spec.execute(prepared.args, ctx, dispatchSignal);
            const value = ctx.redact ? ctx.redact(raw) : raw;
            if (typeof value !== "string" && value.isError) throw new Error("Tool reported an unsuccessful outcome");
            const content = typeof value === "string" ? value : value.content;
            const proof: Awaited<ReturnType<NonNullable<ToolSpec["verify"]>>> = spec.verify ? await spec.verify(prepared.args, raw, ctx, dispatchSignal) : meta.effect === "read"
              ? { receipt: { tool: spec.name, contentHash: businessHash(content), evidenceLevel: "read-result" }, evidenceRefs: [`read:${businessHash(content)}`], verified: true }
              : { receipt: { tool: spec.name, returned: true, evidenceLevel: "tool-receipt-only" }, evidenceRefs: [], verified: false };
            return { value, ...(ctx.redact ? ctx.redact(proof) : proof) };
          } finally { ctx.businessInvocation = false; ctx.recordBusinessReceipt = undefined; ctx.businessConnection = undefined; ctx.assertBusinessDispatch = undefined; }
        });
        return toAgentToolResult(result);
      }
      const result = await spec.execute(params, ctx, signal);
      return toAgentToolResult(result);
    },
  };
}
