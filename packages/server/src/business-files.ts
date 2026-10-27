import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import type { Json, RegisteredTool, ToolContext } from "@open-instinct/core";
import { resolveInsideWorkspace } from "./file-tools.js";
import type { BusinessKnowledge } from "./business-knowledge.js";

const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
interface PreparedFile { path: string; content: string; sourcePath?: string; sourceHash?: string }
function target(workspace: string, path: string): string {
  const resolved = resolveInsideWorkspace(workspace, path);
  if (!resolved) throw new Error("File path is outside workspace");
  return resolved;
}
function prepare(workspace: string, tool: string, value: unknown): PreparedFile {
  if (!value || typeof value !== "object" || !("path" in value) || typeof value.path !== "string") throw new Error("File path required");
  const source = target(workspace, value.path);
  if (tool === "write") {
    if (!("content" in value) || typeof value.content !== "string") throw new Error("File content required");
    if (existsSync(source)) throw new Error("Existing files are immutable: choose a new version filename or use edit to create a revision");
    return { path: value.path, content: value.content };
  }
  if (!("edits" in value) || !Array.isArray(value.edits) || !value.edits.length) throw new Error("Nonempty edits required");
  const bytes = readFileSync(source);
  if (bytes.length > 20 * 1024 * 1024) throw new Error("File revision exceeds 20 MiB");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const changes = value.edits.map((edit: unknown) => {
    if (!edit || typeof edit !== "object" || !("oldText" in edit) || typeof edit.oldText !== "string" || !edit.oldText || !("newText" in edit) || typeof edit.newText !== "string") throw new Error("Each edit requires nonempty oldText and newText");
    const start = text.indexOf(edit.oldText);
    if (start < 0 || text.indexOf(edit.oldText, start + 1) >= 0) throw new Error("Each edit requires one exact occurrence in the original file");
    return { start, end: start + edit.oldText.length, replacement: edit.newText };
  }).sort((a, b) => a.start - b.start);
  let content = "", cursor = 0;
  for (const change of changes) {
    if (change.start < cursor) throw new Error("Edits must not overlap");
    content += text.slice(cursor, change.start) + change.replacement; cursor = change.end;
  }
  content += text.slice(cursor);
  const extension = extname(value.path);
  const path = join(dirname(value.path), `${basename(value.path, extension)}.version-${hash(content).slice(0, 16)}${extension}`);
  if (existsSync(target(workspace, path))) throw new Error("That file revision already exists; read it instead of overwriting it");
  return { path, content, sourcePath: value.path, sourceHash: hash(bytes) };
}

/** Business edits create a new revision; neither write nor edit overwrites owner bytes. */
export function verifyBusinessFileTools(tools: RegisteredTool[], workspace: string, knowledge?: BusinessKnowledge): RegisteredTool[] {
  return tools.filter(tool => tool.spec.name !== "bash").map(tool => {
    if (!["write", "edit"].includes(tool.spec.name)) return tool;
    return { spec: { ...tool.spec,
      description: `${tool.spec.description}\nBusiness files are versioned: write requires a new filename; edit preserves the original and returns a new revision path.`,
      prepareBusiness: async (args: unknown) => ({ args: prepare(workspace, tool.spec.name, args) as unknown as Json }),
      execute: async (args: unknown, ctx: ToolContext, signal?: AbortSignal) => {
        if (!ctx.taskRun || !ctx.businessInvocation || !ctx.assertBusinessDispatch) throw new Error("Task-bound file dispatch required");
        const file = args as PreparedFile;
        if (typeof file.path !== "string" || typeof file.content !== "string" || Buffer.byteLength(file.content) > 20 * 1024 * 1024) throw new Error("Invalid or oversized file content");
        const path = target(workspace, file.path);
        if (file.sourcePath && hash(readFileSync(target(workspace, file.sourcePath))) !== file.sourceHash) throw new Error("Source changed before revision; retrieve current owner edits");
        signal?.throwIfAborted(); ctx.assertBusinessDispatch();
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, file.content, { encoding: "utf8", flag: "wx", mode: 0o600 });
        return { content: [{ type: "text" as const, text: `Created ${file.path}; existing files were preserved.` }] };
      },
      verify: async (args: unknown, _result, ctx) => {
        const file = args as PreparedFile;
        const actual = readFileSync(target(workspace, file.path));
        if (!actual.equals(Buffer.from(file.content, "utf8"))) throw new Error("Written file readback mismatch");
        const sha256 = hash(actual);
        const mimeType = ({ ".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv" } as Record<string, string>)[extname(file.path).toLowerCase()];
        const artifact = knowledge && ctx.taskRun && mimeType && file.content.trim() ? await knowledge.registerLocalGenerated({
          workspace, relativePath: file.path, mimeType, expectedText: [file.content],
          taskId: ctx.taskRun.taskId, sourceLocator: `task:${ctx.taskRun.taskId}:file:${file.path}`,
        }) : undefined;
        return { verified: true, receipt: { sha256, bytes: actual.length, path: file.path, artifactId: artifact?.id ?? null }, evidenceRefs: [`file:sha256:${sha256}`, ...(artifact ? [`artifact:${artifact.id}`] : [])] };
      },
    } };
  });
}
