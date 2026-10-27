import { Worker } from "node:worker_threads";

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const MAX_TEXT_BYTES = 10 * 1024 * 1024;
export const EXTRACTION_TIMEOUT_MS = 30_000;
export interface TextChunk { locator: string; text: string }
export interface Extraction { status: "ready" | "failed" | "image_evidence"; chunks: TextChunk[]; error: string | null }
export type DocumentFormat = "text" | "markdown" | "csv" | "pdf" | "docx" | "xlsx" | "image";
const FORMATS: Record<string, { mime: string; format: DocumentFormat }> = {
  txt: { mime: "text/plain", format: "text" }, md: { mime: "text/markdown", format: "markdown" }, csv: { mime: "text/csv", format: "csv" },
  pdf: { mime: "application/pdf", format: "pdf" }, docx: { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", format: "docx" },
  xlsx: { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", format: "xlsx" },
  png: { mime: "image/png", format: "image" }, jpg: { mime: "image/jpeg", format: "image" }, jpeg: { mime: "image/jpeg", format: "image" }, webp: { mime: "image/webp", format: "image" },
};
export function validateDocument(filename: string, mimeType: string, bytes: Uint8Array): { mimeType: string; format: DocumentFormat } {
  if (!filename || filename.length > 180 || /[\\/\x00-\x1f\x7f]/.test(filename) || filename === "." || filename === ".." || filename.startsWith(".")) throw new Error("Unsafe filename");
  if (!bytes.byteLength || bytes.byteLength > MAX_UPLOAD_BYTES) throw new Error("Upload must contain 1 byte to 20 MiB");
  const type = FORMATS[filename.split(".").pop()!.toLowerCase()];
  if (!type || mimeType.toLowerCase().split(";")[0]!.trim() !== type.mime) throw new Error("Unsupported document type or MIME mismatch");
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (type.format === "pdf" && data.subarray(0, 5).toString() !== "%PDF-") throw new Error("Invalid PDF signature");
  if (["docx", "xlsx"].includes(type.format) && (data.length < 4 || data.readUInt32LE(0) !== 0x04034b50)) throw new Error("Invalid office archive signature");
  if (type.mime === "image/png" && !data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error("Invalid PNG signature");
  if (type.mime === "image/jpeg" && !(data[0] === 255 && data[1] === 216 && data[2] === 255)) throw new Error("Invalid JPEG signature");
  if (type.mime === "image/webp" && !(data.subarray(0, 4).toString() === "RIFF" && data.subarray(8, 12).toString() === "WEBP")) throw new Error("Invalid WebP signature");
  if (["text", "markdown", "csv"].includes(type.format)) {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (/\x00|<\s*(?:!doctype\s+html|html|script|iframe|object|embed|svg)\b/i.test(text)) throw new Error("Active HTML is not supported");
  }
  return { mimeType: type.mime, format: type.format };
}

/** Resource bounding only. Threads are not an operating-system sandbox. */
export class ExtractionPool {
  private active = 0;
  private closed = false;
  private readonly queued: Array<() => void> = [];
  private readonly workers = new Set<Worker>();
  async extract(bytes: Uint8Array, format: DocumentFormat): Promise<Extraction> {
    if (this.closed) throw new Error("Extraction service closed");
    if (bytes.byteLength > MAX_UPLOAD_BYTES) throw new Error("Upload exceeds 20 MiB");
    if (this.active >= 2) {
      if (this.queued.length >= 8) throw new Error("Extraction capacity reached; retry later");
      const waiting = Promise.withResolvers<void>();
      this.queued.push(waiting.resolve);
      await waiting.promise;
      if (this.closed) throw new Error("Extraction service closed");
    } else this.active++;
    try {
      const pending = Promise.withResolvers<Extraction>();
        const worker = new Worker(new URL("../dist/business-extraction-worker.js", import.meta.url), {
          workerData: { bytes, format }, resourceLimits: { maxOldGenerationSizeMb: 192, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
        });
        this.workers.add(worker);
        let settled = false;
        const finish = (result: Extraction) => {
          if (settled) return; settled = true; clearTimeout(timer);
          void worker.terminate().finally(() => { this.workers.delete(worker); pending.resolve(result); });
        };
        const timer = setTimeout(() => finish({ status: "failed", chunks: [], error: "Extraction exceeded 30 seconds" }), EXTRACTION_TIMEOUT_MS);
        worker.once("message", (result: Extraction) => finish(result));
        worker.once("error", () => finish({ status: "failed", chunks: [], error: "Document extraction worker failed" }));
        worker.once("exit", () => finish({ status: "failed", chunks: [], error: "Document extraction interrupted" }));
      return await pending.promise;
    } finally {
      const next = this.queued.shift(); if (next) next(); else this.active--;
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const resume of this.queued.splice(0)) resume();
    await Promise.all([...this.workers].map(worker => worker.terminate()));
  }
}
