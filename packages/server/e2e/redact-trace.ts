import { readFile, writeFile } from "node:fs/promises";
import { fromBuffer, type Entry, type ZipFile } from "yauzl";

export function redactTraceValue(value: unknown, key = ""): unknown {
  if (/authorization|cookie|csrf|password|token|secret|storageState|postData|requestBody|responseBody|environment/i.test(key)) return "[redacted]";
  if (typeof value === "string") return value.replace(/synthetic-[A-Za-z0-9_-]*(?:token|key|secret|computer)[A-Za-z0-9_-]*/gi, "[synthetic credential redacted]").replace(/(?:__Host-)?instinct-owner(?:-dev)?=[^\s;"\\]+/g, "[session redacted]").replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [redacted]");
  if (Array.isArray(value)) return value.map(item => redactTraceValue(item));
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.name === "string" && /authorization|cookie|csrf|token|secret|^(?:__Host-)?instinct-owner(?:-dev)?$/i.test(record.name)) return { ...Object.fromEntries(Object.entries(record).map(([name, item]) => [name, redactTraceValue(item, name)])), value: "[redacted]" };
    return Object.fromEntries(Object.entries(record).map(([name, item]) => [name, redactTraceValue(item, name)]));
  }
  return value;
}
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => { let value = n; for (let i = 0; i < 8; i++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1; return value >>> 0; });
function crc32(bytes: Buffer): number { let crc = 0xffffffff; for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255]! ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }
function storedZip(entries: Array<{ name: string; bytes: Buffer }>): Buffer {
  const local: Buffer[] = []; const central: Buffer[] = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name); const crc = crc32(entry.bytes); const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x0800, 6); header.writeUInt32LE(crc, 14); header.writeUInt32LE(entry.bytes.length, 18); header.writeUInt32LE(entry.bytes.length, 22); header.writeUInt16LE(name.length, 26);
    local.push(header, name, entry.bytes);
    const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x0800, 8); directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(entry.bytes.length, 20); directory.writeUInt32LE(entry.bytes.length, 24); directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(offset, 42); central.push(directory, name); offset += header.length + name.length + entry.bytes.length;
  }
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(central.reduce((sum, buffer) => sum + buffer.length, 0), 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}
/** Public traces retain sanitized events/DOM only: no screencast pixels, bodies or source resources. */
export async function redactTrace(path: string): Promise<string> {
  const bytes = await readFile(path); if (bytes.length > 100 * 1024 * 1024) throw new Error("Trace exceeds public redaction bound");
  const opened = Promise.withResolvers<ZipFile>(); fromBuffer(bytes, { lazyEntries: true }, (error, zip) => error ? opened.reject(error) : opened.resolve(zip!));
  const zip = await opened.promise; const finished = Promise.withResolvers<void>(); const entries: Array<{ name: string; bytes: Buffer }> = []; let expanded = 0;
  zip.on("error", finished.reject); zip.on("end", finished.resolve);
  zip.on("entry", (entry: Entry) => {
    if (entry.fileName.startsWith("/") || entry.fileName.split("/").includes("..") || entry.uncompressedSize + expanded > 150 * 1024 * 1024) { zip.close(); finished.reject(new Error("Unsafe or oversized trace entry")); return; }
    expanded += entry.uncompressedSize;
    if (entry.fileName.endsWith("/")) { zip.readEntry(); return; }
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) { finished.reject(error ?? new Error("Trace entry missing")); zip.close(); return; }
      const chunks: Buffer[] = []; stream.on("data", chunk => chunks.push(Buffer.from(chunk))); stream.on("error", finished.reject);
      stream.on("end", () => {
        try {
          const raw = Buffer.concat(chunks);
          if (/\.(trace|network|stacks)$/.test(entry.fileName)) {
            const lines = raw.toString("utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)
              .filter(event => event.type !== "screencast-frame").map(event => JSON.stringify(redactTraceValue(event)));
            entries.push({ name: entry.fileName, bytes: Buffer.from(lines.join("\n") + "\n") });
          }
          zip.readEntry();
        } catch (error) { zip.close(); finished.reject(error); }
      });
    });
  });
  zip.readEntry(); await finished.promise;
  const output = path.replace(/\.zip$/, ".redacted.zip"); await writeFile(output, storedZip(entries), { mode: 0o600 }); return output;
}
