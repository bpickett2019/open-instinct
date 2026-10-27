import { readdir, readFile, lstat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fromBuffer } from "yauzl";
const suffix = process.argv.includes("--negative") ? "-negative" : "";
const roots = [resolve(`playwright-report${suffix}`), resolve(`evidence${suffix}`)];
const canaries = ["synthetic-owner-workspace-token", "synthetic-composio-key", "synthetic-inkbox-key", "synthetic-inkbox-signing-key", "synthetic-maritime-computer"];
const secret = /ApiKey_[0-9a-f]{8}-[0-9a-f]{4}|sk-ant-[A-Za-z0-9_-]{20,}|mk_[A-Za-z0-9_-]{30,}|liwl(?:token|refresh)_[A-Za-z0-9_-]+/;
let files = 0, entries = 0, expanded = 0;
function inspect(bytes, location) {
  const text = bytes.toString("utf8");
  if (canaries.some(value => text.includes(value)) || secret.test(text)) throw new Error(`Private credential pattern in public evidence: ${location}`);
  return text;
}
async function inspectZip(bytes, location, depth = 0) {
  if (depth > 2 || bytes.length > 100 * 1024 * 1024) throw new Error("Evidence archive bound exceeded");
  const publicTrace = location.endsWith(".redacted.zip");
  const zip = await new Promise((accept, reject) => fromBuffer(bytes, { lazyEntries: true }, (error, value) => error ? reject(error) : accept(value)));
  await new Promise((accept, reject) => {
    zip.on("error", reject); zip.on("end", accept);
    zip.on("entry", entry => {
      if (entry.fileName.endsWith("/")) { zip.readEntry(); return; }
      if (publicTrace && !/^[^/]+\.(trace|network|stacks)$/.test(entry.fileName)) { zip.close(); reject(new Error("Public trace contains a private resource or image")); return; }
      expanded += entry.uncompressedSize; entries++;
      if (expanded > 512 * 1024 * 1024 || entry.uncompressedSize > 100 * 1024 * 1024) { zip.close(); reject(new Error("Expanded evidence bound exceeded")); return; }
      zip.openReadStream(entry, (error, stream) => {
        if (error) { reject(error); return; }
        const chunks = []; stream.on("error", reject); stream.on("data", chunk => chunks.push(chunk));
        stream.on("end", () => { try {
          const text = inspect(Buffer.concat(chunks), `${location}:${entry.fileName}`);
          if (publicTrace) for (const line of text.split("\n").filter(Boolean)) {
            if (JSON.parse(line).type === "screencast-frame") throw new Error("Public trace retains a screencast frame");
          }
          zip.readEntry();
        } catch (failure) { zip.close(); reject(failure); } });
      });
    });
    zip.readEntry();
  });
}
async function selected(root, directory, names) {
  const path = join(root, directory); let children;
  try { children = await readdir(path); } catch (error) { if (error.code === "ENOENT") return; throw error; }
  for (const name of children.filter(name => names.test(name))) {
    const file = join(path, name), stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 100 * 1024 * 1024) throw new Error(`Unsafe public evidence file: ${file}`);
    const bytes = await readFile(file); files++;
    if (name.endsWith(".zip")) await inspectZip(bytes, file);
    else {
      const text = inspect(bytes, file);
      if (name.endsWith(".html")) for (const match of text.matchAll(/data:application\/zip;base64,([A-Za-z0-9+/=]+)/g)) await inspectZip(Buffer.from(match[1], "base64"), `${file}:embedded-report`);
    }
  }
}
// Exact CI publication set, not arbitrary test-results, source archives or downloaded documents.
await selected(roots[0], "", /^(?:index\.html|results\.json)$/);
await selected(roots[0], "data", /^[^.].*\.png$/);
await selected(roots[1], "", /^[^.].*\.(?:html|json)$/);
await selected(roots[1], "screenshots", /^[^.].*\.png$/);
await selected(roots[1], "traces", /^[^.].*\.redacted\.zip$/);
if (!files) throw new Error("No public browser evidence found");
console.log(JSON.stringify({ status: "passed", files, archiveEntries: entries, expandedBytes: expanded, verificationMode: "emulated", limitations: "Pattern/canary scan of exact publication bytes and expanded traces/report data; not OCR or a complete vulnerability review." }));
