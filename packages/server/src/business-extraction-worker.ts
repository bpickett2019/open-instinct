import { parentPort, workerData } from "node:worker_threads";
import { extractDocument } from "./business-document-parser.js";
import type { DocumentFormat } from "./business-extraction.js";

if (!parentPort) throw new Error("Document extraction requires a worker thread");
const input = workerData as { bytes: Uint8Array; format: DocumentFormat };
parentPort.postMessage(await extractDocument(input.bytes, input.format));
