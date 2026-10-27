import { fromBuffer, type Entry } from "yauzl";
import { MAX_TEXT_BYTES, type DocumentFormat, type Extraction, type TextChunk } from "./business-extraction.js";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import mammoth from "mammoth";
import ExcelJS from "exceljs";

const MAX_EXPANSION = 64 * 1024 * 1024;
const MAX_ENTRY = 16 * 1024 * 1024;

/** Fully count decompressed bytes before handing a ZIP to an office parser. Never write entries to disk. */
export async function inspectOfficeArchive(bytes: Buffer, format: "docx" | "xlsx"): Promise<void> {
  const done = Promise.withResolvers<void>();
  fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, archive) => {
    if (error || !archive) { done.reject(new Error("Invalid office archive")); return; }
    let total = 0, count = 0, declared = 0;
    const names = new Set<string>();
    const fail = (error: unknown) => { archive.close(); done.reject(error); };
    archive.on("error", fail);
    archive.on("end", () => {
      if (!names.has("[Content_Types].xml") || !names.has(format === "docx" ? "word/document.xml" : "xl/workbook.xml")) fail(new Error("Office document structure missing"));
      else done.resolve();
    });
    archive.on("entry", (entry: Entry) => {
      const name = entry.fileName;
      declared += entry.uncompressedSize;
      if (++count > 2000 || declared > MAX_EXPANSION || entry.uncompressedSize > MAX_ENTRY || entry.uncompressedSize > Math.max(1, entry.compressedSize) * 100 || (entry.generalPurposeBitFlag & 1) !== 0 || ((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000 || names.has(name) || /(^|\/)\.\.?($|\/)|\\|^\/|^[a-z]:/i.test(name) || /(?:vbaproject|externallinks|embeddings|activex|\.exe$|\.js$|\.html?$)/i.test(name)) {
        fail(new Error("Unsafe, encrypted or oversized office archive")); return;
      }
      names.add(name);
      if (name.endsWith("/")) { archive.readEntry(); return; }
      archive.openReadStream(entry, (error, stream) => {
        if (error || !stream) { fail(new Error("Cannot read office archive entry")); return; }
        let size = 0;
        const xml: Buffer[] = [];
        stream.on("error", fail);
        stream.on("data", (chunk: Buffer) => {
          size += chunk.length; total += chunk.length;
          if (size > MAX_ENTRY || total > MAX_EXPANSION) { stream.destroy(); fail(new Error("Archive expansion limit exceeded")); return; }
          if (/\.(?:xml|rels)$/i.test(name)) xml.push(chunk);
        });
        stream.on("end", () => {
          if (xml.length && /<!DOCTYPE|<!ENTITY|TargetMode\s*=\s*["']External["']/i.test(Buffer.concat(xml).toString("utf8"))) { fail(new Error("External relationships and XML entities are unsupported")); return; }
          archive.readEntry();
        });
      });
    });
    archive.readEntry();
  });
  return done.promise;
}

export async function extractDocument(bytes: Uint8Array, format: DocumentFormat): Promise<Extraction> {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: TextChunk[] = [];
  let total = 0;
  const add = (locator: string, text: string) => {
    if (!text.trim()) return;
    total += Buffer.byteLength(text);
    if (total > MAX_TEXT_BYTES) throw new Error("Extracted text exceeds 10 MiB");
    // Source location remains stable when a large page/paragraph needs several retrieval chunks.
    for (let offset = 0; offset < text.length;) {
      let end = Math.min(offset + 4000, text.length);
      if (end < text.length && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) end--;
      chunks.push({ locator: `${locator}${offset ? `:offset:${offset}` : ""}`, text: text.slice(offset, end) });
      offset = end;
    }
  };
  try {
    if (format === "image") return { status: "image_evidence", chunks: [], error: "Image interpretation requires a model; not guaranteed OCR or authoritative pricing" };
    if (format === "docx" || format === "xlsx") await inspectOfficeArchive(data, format);
    if (format === "pdf") {
      // pdfjs 6 removed isEvalSupported. Text extraction never instantiates its viewer scripting sandbox.
      const job = getDocument({ data: Uint8Array.from(data), useSystemFonts: false, disableFontFace: true });
      try {
        const document = await job.promise;
        if (document.numPages > 1000) throw new Error("PDF page limit exceeded");
        for (let index = 1; index <= document.numPages; index++) {
          const page = await document.getPage(index);
          const content = await page.getTextContent();
          add(`page:${index}`, content.items.map(item => "str" in item ? item.str : "").join(" "));
          page.cleanup();
        }
      } finally { await job.destroy(); }
    } else if (format === "docx") {
      const result = await mammoth.extractRawText({ buffer: data });
      result.value.split(/\n\s*\n/).forEach((text, i) => add(`paragraph:${i + 1}`, text));
    } else if (format === "xlsx") {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(data as unknown as Parameters<typeof workbook.xlsx.load>[0]);
      workbook.eachSheet(sheet => sheet.eachRow((row, number) => {
        const values: string[] = [];
        row.eachCell({ includeEmpty: true }, cell => {
          // Never calculate workbook formulas; cached results are explicitly identified as unverified.
          values.push(cell.formula ? `[formula ${cell.formula}; cached result unverified: ${cell.text}]` : cell.text);
        });
        add(`sheet:${sheet.name}:row:${number}`, values.join("\t"));
      }));
    } else {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(data);
      if (Buffer.byteLength(text) > MAX_TEXT_BYTES) throw new Error("Extracted text exceeds 10 MiB");
      if (format === "csv") {
        let row = 1, quoted = false, start = 0;
        for (let i = 0; i < text.length; i++) {
          if (text[i] === '"') { if (quoted && text[i + 1] === '"') i++; else quoted = !quoted; }
          if (text[i] === "\n" && !quoted) { add(`row:${row++}`, text.slice(start, i)); start = i + 1; }
        }
        if (quoted) throw new Error("Unterminated CSV field");
        add(`row:${row}`, text.slice(start));
      } else text.split(/\n\s*\n/).forEach((text, i) => add(`paragraph:${i + 1}`, text));
    }
    if (!chunks.length) throw new Error("No extractable text; scanned pages require model-derived image evidence");
    return { status: "ready", chunks, error: null };
  } catch (error) {
    return { status: "failed", chunks: [], error: error instanceof Error ? error.message.slice(0, 250) : "Extraction failed" };
  }
}
