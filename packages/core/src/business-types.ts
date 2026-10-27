import type { Channel, Principal } from "./types.js";

export type TaskStatus = "queued" | "running" | "waiting" | "blocked" | "completed" | "cancelled" | "failed";
export type ActionStatus = "prepared" | "dispatching" | "accepted" | "verified" | "unknown" | "failed" | "cancelled" | "superseded";
export type WaitKind = "timer" | "external_event" | "missing_information" | "provider_challenge" | "connection" | "constraint" | "reconciliation";
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface BusinessConfig { autonomy: "full"; stateDirectory?: string }
export interface TaskRunBinding {
  readonly taskId: string;
  readonly runId: string;
  readonly taskRevision: number;
  readonly executionEpoch: number;
  readonly globalControlEpoch: number;
  readonly authorityRef: string;
}
export interface BusinessOrigin {
  channel: Channel;
  conversationKey: string;
  replyRef: Record<string, string | undefined>;
  requester: string;
  audience: "owner";
}
export interface BusinessAuthority {
  id: string;
  kind: "owner" | "routine";
  sourceId: string;
  enabled: boolean;
  version: number;
  scope: string;
}
export interface BusinessTask {
  id: string;
  workspaceId: string;
  objective: string;
  doneCriteria: string[];
  origin: BusinessOrigin;
  authorityRef: string;
  sourceRefs: string[];
  version: number;
  status: TaskStatus;
  executionEpoch: number;
  runId: string | null;
  checkpoint: Json;
  result: string | null;
  evidenceRefs: string[];
  blocker: string | null;
  nextWake: number | null;
  dispatches: number;
  noProgress: number;
  createdAt: number;
  updatedAt: number;
}
export interface LogicalAction {
  stepId: string;
  tool: string;
  arguments: Json;
  sourceRevisions: Record<string, number>;
  connection?: { id: string; version: number; epoch: number; accountId: string };
  toolCallId?: string;
  effectful: boolean;
  /** Trusted concrete capability classification; unknown-priced spend cannot evade a configured cap. */
  spendCapable?: boolean;
  unpricedModel?: boolean;
  allowance?: { category: "purchase" | "model"; amountMinor: number; currency: string };
}
export interface BusinessAction extends LogicalAction {
  id: string;
  taskId: string;
  taskRevision: number;
  version: number;
  argsHash: string;
  status: ActionStatus;
  runId: string;
  receipt: Json;
  evidenceRefs: string[];
  error: string | null;
  createdAt: number;
  updatedAt: number;
}
export interface BusinessWait {
  id: string;
  taskId: string;
  kind: WaitKind;
  correlationKey: string;
  eventCursor: number;
  deadline: number | null;
  satisfiedBy: string | null;
  status: "waiting" | "satisfied" | "expired" | "cancelled";
  requiresVerification: boolean;
}
export interface BusinessEvent {
  id: string;
  channel: string;
  correlationKey: string;
  kind: string;
  content: Json;
  at: number;
  verified: boolean;
}
export interface BusinessConnection {
  id: string;
  toolkit: string;
  accountId: string;
  identity: string;
  scopes: string[];
  status: "connected" | "disabled" | "challenge";
  epoch: number;
  connectedBy: string;
  verifiedAt: number | null;
  revocation: "none" | "requested" | "failed";
  revokeJobId: string | null;
}
export interface BusinessSettings {
  workspaceId: string;
  autonomy: "full";
  stopped: boolean;
  globalControlEpoch: number;
  timezone: string;
  currency: string;
  constraints: string[];
  profileVersion: number;
  notificationPreferences: { progress: boolean; blockers: boolean; completion: boolean };
  limits: { purchaseMinor: number | null; modelMinor: number | null; currency: string };
  usage: { purchaseMinor: number; modelMinor: number; modelPriceUnknown: boolean; inputTokens: number; outputTokens: number };
  backupRetention: number;
}
export interface Versioned<T> { id: string; version: number; value: T; updatedAt: number }
export type BusinessRecordKind = "authority" | "profile" | "connection" | "commitment" | "routine" | "knowledge" | "artifact" | "notification" | "usage" | "cursor";
export interface OwnerMessage {
  cursor: number;
  id: string;
  channel: string;
  thread: string;
  role: "owner" | "assistant" | "notice";
  text: string;
  taskId: string | null;
  artifactIds: string[];
  at: number;
}
export interface BusinessTaskRequest { objective: string; doneCriteria: string[]; sourceRefs?: string[] }
export interface DispatchOutcome<T> { value: T; receipt: Json; evidenceRefs: string[]; verified: boolean; actualAmountMinor?: number }
export interface BusinessDispatch {
  assertDispatch(binding: TaskRunBinding, action: LogicalAction): void;
  invoke<T>(binding: TaskRunBinding, action: LogicalAction, call: (signal: AbortSignal) => Promise<DispatchOutcome<T>>): Promise<T>;
  recordReceipt?(binding: TaskRunBinding, stepId: string, receipt: Json): void;
}
export function assertBusinessOwner(principal: Principal, channel: Channel, group = false): void {
  if (principal.kind !== "owner" || principal.id !== "owner" || principal.tier !== "owner" || principal.cappedFrom || group || !["chat", "imessage", "sms"].includes(channel)) {
    throw new Error("Authenticated one-to-one owner authority required");
  }
}
export const TERMINAL_TASKS: Partial<Record<TaskStatus, true>> = { completed: true, cancelled: true, failed: true };
