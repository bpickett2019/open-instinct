import { afterEach, describe, expect, it, vi } from "vitest";
import ExcelJS from "exceljs";
import { renderMarkdownToPdf } from "../../core/src/pdf.js";
import { ExtractionPool, EXTRACTION_TIMEOUT_MS, validateDocument } from "../src/business-extraction.js";

const pools: ExtractionPool[] = [];
function pool() { const value = new ExtractionPool(); pools.push(value); return value; }
afterEach(async () => { vi.useRealTimers(); await Promise.all(pools.splice(0).map(value => value.close())); });

// Small stored ZIPs make adversarial metadata explicit without extracting any entry to disk.
function archive(entries: Array<{ name: string; text: string; size?: number; flags?: number; attributes?: number }>): Buffer {
  const local: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), data = Buffer.from(entry.text);
    let crc = 0xffffffff;
    for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    crc = (crc ^ 0xffffffff) >>> 0;
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(entry.flags ?? 0, 6); header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(entry.size ?? data.length, 22); header.writeUInt16LE(name.length, 26);
    const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(0x0314, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(entry.flags ?? 0, 8); directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(data.length, 20); directory.writeUInt32LE(entry.size ?? data.length, 24); directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(entry.attributes ?? 0, 38); directory.writeUInt32LE(offset, 42);
    local.push(header, name, data); central.push(directory, name); offset += header.length + name.length + data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
const docxEntries = [
  { name: "[Content_Types].xml", text: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>' },
  { name: "_rels/.rels", text: '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>' },
  { name: "word/document.xml", text: '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Inspection rate 125.00 USD</w:t></w:r></w:p></w:body></w:document>' },
];

describe("bounded real document workers", () => {
  it("extracts Markdown, multiline CSV and PDF with stable source locations", async () => {
    const worker = pool();
    const markdown = await worker.extract(Buffer.from("# Services\n\nInspection and repair"), "markdown");
    expect(markdown).toMatchObject({ status: "ready", chunks: [{ locator: "paragraph:1" }, { locator: "paragraph:2" }] });
    const csv = await worker.extract(Buffer.from('service,notes\ninspection,"line one\nline two"\n'), "csv");
    expect(csv.chunks.map(chunk => chunk.locator)).toEqual(["row:1", "row:2"]);
    expect(csv.chunks[1]?.text).toContain("line two");
    const pdf = await worker.extract(await renderMarkdownToPdf("# Inspection\n\nTotal 125.00 USD"), "pdf");
    expect(pdf.status).toBe("ready"); expect(pdf.chunks[0]?.locator).toBe("page:1"); expect(pdf.chunks.map(chunk => chunk.text).join(" ")).toContain("125.00 USD");
  });
  it("extracts DOCX paragraphs and XLSX sheets without executing formulas", async () => {
    const worker = pool();
    const docx = await worker.extract(archive(docxEntries), "docx");
    expect(docx).toMatchObject({ status: "ready", chunks: [{ locator: "paragraph:1", text: expect.stringContaining("125.00") }] });
    const workbook = new ExcelJS.Workbook(); const sheet = workbook.addWorksheet("Budget");
    sheet.addRow(["Item", "Amount"]); sheet.addRow(["Inspection", 125]); sheet.getCell("B3").value = { formula: "SUM(B2:B2)", result: 125 };
    const xlsx = await worker.extract(Buffer.from(await workbook.xlsx.writeBuffer()), "xlsx");
    expect(xlsx.status).toBe("ready"); expect(xlsx.chunks[1]?.locator).toBe("sheet:Budget:row:2"); expect(xlsx.chunks[2]?.text).toContain("cached result unverified");
  });
  it.each([
    { name: "../../outside.txt", text: "escape" },
    { name: "word/vbaProject.bin", text: "macro" },
    { name: "xl/externalLinks/link.xml", text: "external workbook" },
    { name: "word/huge.xml", text: "x", size: 70 * 1024 * 1024 },
    { name: "word/encrypted.xml", text: "data", flags: 1 },
    { name: "word/link.xml", text: "target", attributes: (0xa000 << 16) >>> 0 },
    { name: "word/relationships.rels", text: '<Relationship TargetMode="External" Target="https://example.test/private"/>' },
    { name: "word/entity.xml", text: '<!DOCTYPE x [<!ENTITY a SYSTEM "file:///etc/passwd">]><x>&a;</x>' },
  ])("rejects unsafe office entry $name before parsing", async entry => {
    const result = await pool().extract(archive([...docxEntries, entry]), "docx");
    expect(result.status).toBe("failed"); expect(result.chunks).toEqual([]); expect(result.error).toBeTruthy();
  });
  it("marks images as model-derived evidence and never empty extraction success", async () => {
    const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
    expect(validateDocument("scan.png", "image/png", image).format).toBe("image");
    const extracted = await pool().extract(image, "image");
    expect(extracted).toMatchObject({ status: "image_evidence", chunks: [], error: expect.stringContaining("not guaranteed OCR") });
    expect((await pool().extract(Buffer.from(""), "text")).status).toBe("failed");
    expect((await pool().extract(Buffer.from('x,"unterminated'), "csv")).status).toBe("failed");
  });
  it("terminates at the hard deadline and bounds admission to two active plus eight queued", async () => {
    vi.useFakeTimers();
    const worker = pool();
    const jobs = Array.from({ length: 10 }, () => worker.extract(Buffer.from("Synthetic text"), "text"));
    const overCapacity = worker.extract(Buffer.from("One too many"), "text");
    await expect(overCapacity).rejects.toThrow(/capacity/);
    vi.advanceTimersByTime(EXTRACTION_TIMEOUT_MS);
    const first = await jobs[0]!;
    expect(first).toMatchObject({ status: "failed", error: expect.stringContaining("30 seconds") });
    const settled = Promise.allSettled(jobs);
    await worker.close();
    await settled;
    await expect(worker.extract(Buffer.from("closed"), "text")).rejects.toThrow(/closed/);
  });
});
