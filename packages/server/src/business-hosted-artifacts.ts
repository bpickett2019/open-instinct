import { createHash } from "node:crypto";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { businessHash, defineTool, jsonValue, textResult, type Json, type RegisteredTool, type ToolContext, type ToolResultLike } from "@open-instinct/core";
import type { ComputerBackend } from "@open-instinct/computer";
import type { BusinessKnowledge } from "./business-knowledge.js";
import { MAX_TEXT_BYTES, MAX_UPLOAD_BYTES } from "./business-extraction.js";

const parameters = Type.Object({
  path: Type.String({ minLength: 1, maxLength: 2048 }),
  filename: Type.String({ minLength: 1, maxLength: 180 }),
  mimeType: Type.String({ minLength: 1, maxLength: 200 }),
  expectedText: Type.Array(Type.String({ minLength: 1, maxLength: MAX_TEXT_BYTES }), { minItems: 1, maxItems: 1000 }),
}, { additionalProperties: false });
function blocked(reason: string): never { throw new Error(`Hosted artifact import blocked: ${reason}`); }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

function bound(ctx: ToolContext, signal?: AbortSignal) {
  if (!ctx.taskRun || !ctx.businessInvocation || !ctx.assertBusinessDispatch || ctx.principal.kind !== "owner" || ctx.principal.id !== "owner" || ctx.principal.tier !== "owner" || ctx.principal.cappedFrom) blocked("a final owner-scoped task dispatch is required");
  signal?.throwIfAborted();
  ctx.assertBusinessDispatch!();
  return ctx.taskRun!;
}

/** Only explicit, single-envelope responses are bytes. Human-readable size/privacy notes are not files. */
function decode(result: ToolResultLike, path: string, mimeType: string) {
  if (typeof result === "string" || result.isError || result.content.length !== 1 || result.content[0]?.type !== "text") blocked("read_file did not return an unambiguous file envelope (or is private)");
  const text = (result as Exclude<ToolResultLike, string>).content[0]!;
  if (text.type !== "text" || text.text.length > Math.ceil(MAX_UPLOAD_BYTES / 3) * 4 + 16_384 || text.text.includes("[REDACTED]")) blocked("transfer is oversized or redacted/private");
  let envelope: unknown;
  try { envelope = JSON.parse(text.text); } catch { blocked("read_file encoding contract unavailable; plain text/privacy notes are not imported"); }
  if (!record(envelope)) blocked("read_file encoding contract unavailable");
  const file = envelope as Record<string, unknown>;
  if (file.error || file.is_error || file.truncated || file.private || file.redacted) blocked("provider reported a partial, failed or private file");
  if (file.path !== undefined && file.path !== path) blocked("provider path mismatch");
  for (const key of ["mime", "mimeType"]) if (file[key] !== undefined && file[key] !== mimeType) blocked("provider MIME mismatch");
  const encoding = file.encoding;
  if (encoding !== "base64" && encoding !== "utf8" && encoding !== "utf-8") blocked("explicit base64 or UTF-8 encoding is required");
  if (file.content !== undefined && file.data !== undefined) blocked("ambiguous file payload fields");
  const content = file.content ?? file.data;
  if (typeof content !== "string") blocked("file payload missing");
  const payload = content as string;
  let bytes: Buffer;
  if (encoding === "base64") {
    if (payload.length > Math.ceil(MAX_UPLOAD_BYTES / 3) * 4 || payload.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) blocked("invalid or oversized base64");
    bytes = Buffer.from(payload, "base64");
    if (bytes.toString("base64") !== payload) blocked("noncanonical base64");
  } else {
    // The wrapped Maritime UTF-8 proof binds the original provider bytes, before redaction.
    if (typeof file.content !== "string" || !payload.isWellFormed() || Buffer.byteLength(payload) > MAX_UPLOAD_BYTES) blocked("unsupported or oversized UTF-8 payload");
    bytes = Buffer.from(payload, "utf8");
  }
  if (!bytes.length || bytes.length > MAX_UPLOAD_BYTES) blocked("file must contain 1 byte to 20 MiB");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  for (const key of ["bytes", "size", "size_bytes"]) if (file[key] !== undefined && file[key] !== bytes.length) blocked("provider byte count mismatch");
  if (file.sha256 !== undefined && (typeof file.sha256 !== "string" || !/^[a-fA-F0-9]{64}$/.test(file.sha256) || file.sha256.toLowerCase() !== sha256)) blocked("provider SHA-256 mismatch");
  if (file.hash !== undefined || file.digest !== undefined) blocked("unsupported provider hash metadata; explicit sha256 required");
  return { bytes, sha256, encoding };
}

export function createHostedArtifactTools({ knowledge, backend }: { knowledge: BusinessKnowledge; backend: () => ComputerBackend | undefined }): RegisteredTool[] {
  const proofs = new WeakMap<object, { binding: string; argumentsHash: string; artifactId: string; sha256: string; bytes: number }>();
  const binding = (ctx: ToolContext) => businessHash({ taskRun: ctx.taskRun!, conversationKey: ctx.conversationKey });
  return [defineTool({
    name: "computer_import_artifact", label: "Import completed hosted document",
    description: "Transfer an existing hosted file into Files/Knowledge and verify extracted expected text/totals. Supply a safe filename and explicit MIME. Requires a bound task, available non-private read_file and explicit encoding. Does not create a document or prove LibreOffice ran.",
    parameters, meta: { capabilities: ["computer.use", "files.read", "files.write"], group: "computer", effect: "write" },
    prepareBusiness: async args => { if (!Value.Check(parameters, args)) blocked("invalid arguments"); jsonValue(args); return { args }; },
    execute: async (args, ctx, signal) => {
      const run = bound(ctx, signal);
      if (!Value.Check(parameters, args)) blocked("invalid arguments or model-supplied identity");
      if (!/^\/(?:data|home\/desk)\/.+/.test(args.path) || /[\\\x00-\x1f\x7f]/.test(args.path) || args.path.split("/").slice(1).some(part => !part || part === "." || part === "..")) blocked("path must be a file under /data or /home/desk");
      if (args.filename.startsWith(".") || /[\\/\x00-\x1f\x7f]/.test(args.filename)) blocked("unsafe filename");
      if (args.expectedText.some(text => !text.trim()) || args.expectedText.reduce((sum, text) => sum + Buffer.byteLength(text), 0) > MAX_TEXT_BYTES) blocked("expected content must be nonempty and bounded");
      const computer = backend();
      if (!computer || computer.kind !== "maritime") blocked("hosted Maritime backend unavailable");
      const tools = await computer!.tools();
      const candidates = tools.filter(tool => tool.spec.name === "read_file");
      if (candidates.length !== 1) blocked("discovered read_file contract unavailable or ambiguous");
      const reader = candidates[0]!.spec;
      const schema = reader.parameters;
      if (!record(schema.properties) || !record(schema.properties.path) || schema.properties.path.type !== "string" || !Value.Check(schema, { path: args.path })) blocked("discovered read_file input schema does not accept a server-bound path-only call");
      bound(ctx, signal);
      // Invoke the registered wrapper, never backend.call: privacy, lease and final dispatch fences remain active.
      const result = await reader.execute({ path: args.path }, ctx, signal);
      bound(ctx, signal);
      const file = decode(result, args.path, args.mimeType);
      if (file.encoding !== "base64") {
        const proof = await reader.verify?.({ path: args.path }, result, ctx, signal);
        if (!proof?.verified || !record(proof.receipt) || proof.receipt.sha256 !== file.sha256 || proof.receipt.bytes !== file.bytes.length) blocked("original UTF-8 byte proof unavailable or redaction changed the file");
      }
      ctx.recordBusinessReceipt?.({ tool: "read_file", evidenceLevel: "primitive-only", operation: "hosted-file-transfer", sha256: file.sha256, bytes: file.bytes.length });
      bound(ctx, signal);
      const artifact = await knowledge.registerGenerated({ filename: args.filename, mimeType: args.mimeType, bytes: file.bytes, expectedText: args.expectedText, taskId: run.taskId, sourceLocator: `task:${run.taskId}:hosted-file:${encodeURIComponent(args.path)}` });
      bound(ctx, signal);
      ctx.recordBusinessSource?.(`knowledge:${artifact.id}`, artifact.version);
      const value = textResult(JSON.stringify({ artifactId: artifact.id, sha256: artifact.sha256, bytes: file.bytes.length, evidenceLevel: "document-readback", evidenceRefs: [`artifact:${artifact.id}`, `file:sha256:${artifact.sha256}`] }));
      proofs.set(value as object, { binding: binding(ctx), argumentsHash: businessHash(args), artifactId: artifact.id, sha256: artifact.sha256, bytes: file.bytes.length });
      return value;
    },
    verify: async (args, value, ctx, signal): Promise<{ verified: boolean; receipt: Json; evidenceRefs: string[] }> => {
      bound(ctx, signal);
      const proof = typeof value === "object" ? proofs.get(value) : undefined;
      if (!proof || proof.binding !== binding(ctx) || proof.argumentsHash !== businessHash(args)) return { verified: false, receipt: { evidenceLevel: "receipt-only" }, evidenceRefs: [] };
      const actual = await knowledge.download(proof.artifactId);
      bound(ctx, signal);
      if (actual.bytes.length !== proof.bytes || createHash("sha256").update(actual.bytes).digest("hex") !== proof.sha256 || knowledge.detail(proof.artifactId).artifact.extraction !== "ready") blocked("registered document readback changed");
      return { verified: true, receipt: { artifactId: proof.artifactId, sha256: proof.sha256, bytes: proof.bytes, evidenceLevel: "document-readback" }, evidenceRefs: [`artifact:${proof.artifactId}`, `file:sha256:${proof.sha256}`] };
    },
  })];
}
