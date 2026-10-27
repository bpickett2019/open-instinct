import { jsonValue } from "@open-instinct/core";
import type { Json } from "@open-instinct/core";
import type { Citation } from "./business-pricing.js";
import type { TextChunk, DocumentFormat } from "./business-extraction.js";

export interface KnowledgeSource {
  id: string; sourceVersion: number; sha256: string; authority: "owner" | "designated" | "evidence"; scope: string;
  source: "owner" | "upload" | "gmail" | "generated" | "model"; sourceLocator: string; uploader: string;
  supersedes: string | null; supersededBy: string | null; deleted: boolean; chunks: TextChunk[]; taskIds: string[];
}
export interface ArtifactRecord extends Omit<KnowledgeSource, "chunks"> {
  filename: string; mimeType: string; size: number; storageKey: string;
  format: DocumentFormat; extraction: "pending" | "ready" | "failed" | "image_evidence";
  error: string | null; createdAt: number;
}
export interface ArtifactMetadata extends Omit<ArtifactRecord, "storageKey"> { version: number }
export interface ProfileFact { key: string; value: Json; scope: string; citation: Citation }
export interface ProfileRecord { facts: ProfileFact[]; sourceId: string }
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function record(value: unknown): asserts value is Record<string, unknown> {
  jsonValue(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid knowledge record");
}
export function nonempty(value: unknown, max = 2000): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error("Invalid knowledge string");
}
export function validateSource(value: unknown): asserts value is KnowledgeSource {
  record(value); nonempty(value.id); nonempty(value.scope); nonempty(value.sourceLocator); nonempty(value.uploader);
  if (typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256)) throw new Error("Invalid source content hash");
  if (!Number.isSafeInteger(value.sourceVersion) || Number(value.sourceVersion) < 1 || !["owner", "designated", "evidence"].includes(String(value.authority)) || !["owner", "upload", "gmail", "generated", "model"].includes(String(value.source)) || typeof value.deleted !== "boolean" || !(value.supersedes === null || typeof value.supersedes === "string")) throw new Error("Corrupt knowledge source");
  if (value.authority === "owner" && value.source !== "owner" || value.authority === "designated" && value.source !== "upload" || ["gmail", "generated", "model"].includes(String(value.source)) && value.authority !== "evidence") throw new Error("Invalid source authority");
  if (!(value.supersededBy === null || typeof value.supersededBy === "string" && UUID.test(value.supersededBy))) throw new Error("Invalid source replacement");
  if (!Array.isArray(value.taskIds) || value.taskIds.some(id => typeof id !== "string")) throw new Error("Invalid source task associations");
  if (!Array.isArray(value.chunks)) throw new Error("Corrupt source chunks");
  for (const chunk of value.chunks) { record(chunk); nonempty(chunk.locator); nonempty(chunk.text, 10 * 1024 * 1024); }
}
export function validateArtifact(value: unknown): asserts value is ArtifactRecord {
  record(value); validateSource({ ...value, chunks: [] });
  if (typeof value.id !== "string" || !UUID.test(value.id) || value.storageKey !== `${value.id}.bin` || typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256) || !Number.isSafeInteger(value.size) || Number(value.size) < 1 || Number(value.size) > 20 * 1024 * 1024 || !["pending", "ready", "failed", "image_evidence"].includes(String(value.extraction)) || !["text", "markdown", "csv", "pdf", "docx", "xlsx", "image"].includes(String(value.format)) || !Array.isArray(value.taskIds) || value.taskIds.some(id => typeof id !== "string") || !(value.error === null || typeof value.error === "string") || !Number.isSafeInteger(value.createdAt)) throw new Error("Corrupt artifact record");
  nonempty(value.filename, 180); nonempty(value.mimeType, 120);
  if (/[\\/\x00-\x1f\x7f]/.test(value.filename) || value.filename.startsWith(".") || /[\r\n]/.test(value.mimeType)) throw new Error("Unsafe artifact metadata");
}
export function validateProfile(value: unknown): asserts value is ProfileRecord {
  record(value); nonempty(value.sourceId);
  if (!Array.isArray(value.facts)) throw new Error("Corrupt business profile");
  for (const fact of value.facts) { record(fact); nonempty(fact.key, 120); nonempty(fact.scope); jsonValue(fact.value); record(fact.citation); nonempty(fact.citation.sourceId); nonempty(fact.citation.locator); if (!Number.isSafeInteger(fact.citation.sourceVersion) || Number(fact.citation.sourceVersion) < 1) throw new Error("Invalid profile citation"); }
}
