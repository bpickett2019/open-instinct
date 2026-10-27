import { createHash, randomUUID } from "node:crypto";
import { constants, chmodSync, existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { open } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { canonicalJson, type BusinessStore } from "@open-instinct/core";
import { ExtractionPool, MAX_UPLOAD_BYTES, MAX_TEXT_BYTES, validateDocument, type Extraction } from "./business-extraction.js";
import { BusinessProfile, requireOwnerAuthority, type ProfileInput } from "./business-profile.js";
import { UUID, nonempty, validateArtifact, validateSource, type ArtifactMetadata, type ArtifactRecord, type KnowledgeSource } from "./business-knowledge-types.js";
export type { ArtifactMetadata, ArtifactRecord, KnowledgeSource, ProfileFact } from "./business-knowledge-types.js";
export type { ProfileInput } from "./business-profile.js";

export interface UploadInput { filename: string; mimeType: string; bytes: Uint8Array; authoritative?: boolean; scope?: string; supersedes?: string; expectedVersion?: number }
export interface AttachmentInput { filename: string; mimeType: string; bytes: Uint8Array; accountId: string; messageId: string; attachmentId: string; taskId?: string }
export interface GeneratedInput { filename: string; mimeType: string; bytes: Uint8Array; taskId: string; sourceLocator: string; expectedText: string[]; supersedes?: string; expectedVersion?: number }
function hash(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }

/** One original-byte store for Files, source retrieval and generated deliverables. */
export class BusinessKnowledge {
  readonly profiles: BusinessProfile;
  private readonly directory: string;
  constructor(readonly store: BusinessStore, private readonly extraction = new ExtractionPool()) {
    this.profiles = new BusinessProfile(store);
    this.directory = join(store.root, "artifacts");
    if (existsSync(this.directory) && lstatSync(this.directory).isSymbolicLink()) throw new Error("Artifact directory cannot be a symlink");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 }); chmodSync(this.directory, 0o700);
    if (realpathSync(this.directory) !== join(realpathSync(store.root), "artifacts")) throw new Error("Artifact storage path mismatch");
    // A stopped extraction has no trustworthy index. The owner can retry the retained original.
    for (const record of store.list<ArtifactRecord>("artifact", validateArtifact)) if (record.value.extraction === "pending") {
      store.put("artifact", record.id, { ...record.value, extraction: "failed", error: "Extraction interrupted; retry original" }, record.version, validateArtifact);
      store.removeKnowledgeChunks(record.id);
    }
  }
  profile() { return { ...this.profiles.current(), activeSources: this.list().filter(source => source.authority !== "evidence" && source.supersededBy === null && source.extraction === "ready") }; }
  saveProfile(input: ProfileInput, ownerRef: string) { this.profiles.save(input, ownerRef); return this.profile(); }
  list(): ArtifactMetadata[] { return this.store.list<ArtifactRecord>("artifact", validateArtifact).filter(record => !record.value.deleted).map(record => this.public(record.value, record.version)); }
  detail(id: string) {
    const artifact = this.require(id);
    const source = this.store.get<KnowledgeSource>("knowledge", id, validateSource);
    return { artifact: this.public(artifact.value, artifact.version), chunks: source?.value.chunks ?? [] };
  }
  source(id: string) {
    if (!UUID.test(id)) throw new Error("Invalid source ID");
    const source = this.store.get<KnowledgeSource>("knowledge", id, validateSource);
    if (!source || source.value.deleted) throw new Error("Source not found");
    const activeLocators = source.value.source === "owner" ? this.profiles.current().facts.filter(fact => fact.citation.sourceId === id).map(fact => fact.citation.locator) : source.value.chunks.map(chunk => chunk.locator);
    return { ...source, obsolete: this.superseded(source.value) || source.value.source === "owner" && !activeLocators.length, activeLocators };
  }
  async image(id: string) {
    this.assertGeneratedImport();
    const artifact = this.require(id).value;
    if (artifact.format !== "image") throw new Error("Artifact is not an image; PDF pages require separately referenced interpretation");
    return { artifact: this.public(artifact, this.require(id).version), bytes: await this.bytes(artifact) };
  }
  recordInterpretation(input: { artifactId: string; expectedVersion: number; page: number; text: string; taskId: string }) {
    this.assertGeneratedImport();
    const artifact = this.require(input.artifactId);
    if (artifact.version !== input.expectedVersion || artifact.value.supersededBy || !["image", "pdf"].includes(artifact.value.format)) throw new Error("Current image or PDF source required");
    if (!Number.isSafeInteger(input.page) || input.page < 1 || input.page > 1000 || !this.store.task(input.taskId)) throw new Error("Valid page reference and task required");
    nonempty(input.text, 20_000);
    const id = randomUUID();
    const chunks = [{ locator: `page:${input.page}:model-interpretation`, text: `Model-derived image interpretation, not guaranteed OCR or authoritative pricing: ${input.text}` }];
    const source: KnowledgeSource = {
      id, sourceVersion: 1, authority: "evidence", scope: artifact.value.scope, source: "model", sourceLocator: `artifact:${artifact.id}:version:${artifact.value.sourceVersion}:page:${input.page}`,
      uploader: `task:${input.taskId}`, supersedes: null, supersededBy: null, deleted: false, taskIds: [input.taskId],
      sha256: createHash("sha256").update(canonicalJson(chunks)).digest("hex"), chunks,
    };
    this.store.transaction(() => { this.store.put("knowledge", id, source, null, validateSource); this.store.replaceKnowledgeChunks(id, 1, source.chunks); });
    return this.source(id);
  }
  search(query: string) {
    if (typeof query !== "string" || !query.trim() || query.length > 500) throw new Error("Search needs 1 to 500 characters");
    const facts = this.profiles.current().facts;
    const sources = new Map<string, KnowledgeSource>();
    return this.store.searchKnowledge(query, 30).flatMap(hit => {
      if (!sources.has(hit.sourceId)) {
        const record = this.store.get<KnowledgeSource>("knowledge", hit.sourceId, validateSource);
        if (!record) return [];
        sources.set(hit.sourceId, record.value);
      }
      const source = sources.get(hit.sourceId)!;
      if (source.deleted || this.superseded(source) || source.source === "owner" && !facts.some(fact => fact.citation.sourceId === hit.sourceId && fact.citation.locator === hit.locator)) return [];
      return [{ ...hit, authority: source.authority, source: source.source, sourceLocator: source.sourceLocator, citation: { sourceId: hit.sourceId, sourceVersion: hit.sourceVersion, locator: hit.locator } }];
    });
  }
  async upload(input: UploadInput, ownerRef: string): Promise<ArtifactMetadata> {
    requireOwnerAuthority(this.store, ownerRef);
    return this.ingest(input, { source: "upload", authority: input.authoritative ? "designated" : "evidence", uploader: ownerRef, sourceLocator: ownerRef, taskIds: [] });
  }
  async ingestAttachment(input: AttachmentInput): Promise<ArtifactMetadata> {
    for (const value of [input.accountId, input.messageId, input.attachmentId]) nonempty(value, 500);
    if (input.taskId && !this.store.task(input.taskId)) throw new Error("Unknown attachment task");
    return this.ingest(input, { source: "gmail", authority: "evidence", uploader: `gmail:${input.accountId}`, sourceLocator: `gmail:${encodeURIComponent(input.accountId)}:message:${encodeURIComponent(input.messageId)}:attachment:${encodeURIComponent(input.attachmentId)}`, taskIds: input.taskId ? [input.taskId] : [] });
  }
  async registerGenerated(input: GeneratedInput): Promise<ArtifactMetadata> {
    this.assertGeneratedImport();
    if (!this.store.task(input.taskId)) throw new Error("Unknown generated artifact task");
    if (!Array.isArray(input.expectedText) || !input.expectedText.length || input.expectedText.some(text => typeof text !== "string" || !text.trim()) || input.expectedText.reduce((sum, text) => sum + Buffer.byteLength(text), 0) > MAX_TEXT_BYTES) throw new Error("Generated artifact requires bounded expected content readback");
    const result = await this.ingest(input, { source: "generated", authority: "evidence", uploader: `task:${input.taskId}`, sourceLocator: input.sourceLocator, taskIds: [input.taskId] });
    const actual = this.detail(result.id).chunks.map((chunk, index) => `${index && !/:offset:\d+$/.test(chunk.locator) ? "\n" : ""}${chunk.text}`).join("").replace(/\s+/g, " ");
    if (result.extraction !== "ready" || input.expectedText.some(text => !actual.includes(text.replace(/\s+/g, " ")))) {
      const record = this.require(result.id);
      this.store.transaction(() => {
        this.store.put("artifact", result.id, { ...record.value, extraction: "failed", error: "Generated document content readback mismatch" }, record.version, validateArtifact);
        this.store.removeKnowledgeChunks(result.id);
      });
      throw new Error(`Generated content validation failed; artifact ${result.id} retained with failure`);
    }
    return result;
  }
  async registerLocalGenerated(input: Omit<GeneratedInput, "bytes" | "filename"> & { workspace: string; relativePath: string; filename?: string }): Promise<ArtifactMetadata> {
    this.assertGeneratedImport();
    const root = realpathSync(input.workspace);
    if (!input.relativePath || input.relativePath.includes("\\") || input.relativePath.split("/").some(part => part === ".." || part === "." || !part)) throw new Error("Unsafe workspace artifact path");
    const path = resolve(root, input.relativePath);
    if (!path.startsWith(root + sep)) throw new Error("Artifact path outside workspace");
    let current = root;
    for (const part of input.relativePath.split("/")) { current = join(current, part); if (lstatSync(current).isSymbolicLink()) throw new Error("Artifact symlink rejected"); }
    const bytes = await this.readPrivate(path, MAX_UPLOAD_BYTES);
    return this.registerGenerated({ ...input, filename: input.filename ?? basename(path), bytes });
  }
  async retry(id: string, expectedVersion: number): Promise<ArtifactMetadata> {
    const record = this.require(id);
    if (record.version !== expectedVersion || record.value.extraction === "pending") throw new Error("Business revision conflict or extraction active");
    const data = await this.bytes(record.value);
    this.store.transaction(() => {
      this.store.put("artifact", id, { ...record.value, extraction: "pending", error: null }, expectedVersion, validateArtifact);
      const source = this.store.get<KnowledgeSource>("knowledge", id, validateSource)!;
      this.store.put("knowledge", id, { ...source.value, chunks: [] }, source.version, validateSource);
      this.store.removeKnowledgeChunks(id);
    });
    return this.extract(id, data);
  }
  delete(id: string, expectedVersion: number): { retainedEvidence: string } {
    this.store.transaction(() => {
      const artifact = this.require(id);
      if (artifact.version !== expectedVersion) throw new Error("Business revision conflict");
      this.store.put("artifact", id, { ...artifact.value, deleted: true }, expectedVersion, validateArtifact);
      const source = this.store.get<KnowledgeSource>("knowledge", id, validateSource);
      if (source) this.store.put("knowledge", id, { ...source.value, deleted: true, chunks: [] }, source.version, validateSource);
      this.store.removeKnowledgeChunks(id);
      this.invalidateInterpretations(id, null);
    });
    return { retainedEvidence: "Removed from active Files and Knowledge retrieval. Immutable originals and cited action evidence remain in private storage and existing backups; third-party copies are unchanged. Saved standing constraints remain in Settings until explicitly changed there." };
  }
  deleteSource(id: string, expectedVersion: number): { retainedEvidence: string } {
    if (this.store.get("artifact", id)) return this.delete(id, expectedVersion);
    this.store.transaction(() => {
      const source = this.store.get<KnowledgeSource>("knowledge", id, validateSource);
      if (!source || source.version !== expectedVersion) throw new Error("Unknown source or revision conflict");
      this.store.put("knowledge", id, { ...source.value, deleted: true, chunks: [] }, expectedVersion, validateSource);
      this.store.removeKnowledgeChunks(id);
    });
    return { retainedEvidence: "Removed from active retrieval. Historical profile/action evidence and existing backups are retained. Saved standing constraints remain in Settings until explicitly changed there." };
  }
  async download(id: string) { const artifact = this.require(id).value; return { filename: artifact.filename, mimeType: artifact.mimeType, bytes: await this.bytes(artifact) }; }
  manifest() { return this.store.list<ArtifactRecord>("artifact", validateArtifact).map(({ id, value }) => ({ id, storageKey: value.storageKey, sha256: value.sha256, size: value.size, deleted: value.deleted })); }
  export() { return { profile: this.profile(), sources: this.store.list<KnowledgeSource>("knowledge", validateSource).filter(record => !record.value.deleted), artifacts: this.list(), retention: "Historical action evidence, private originals and existing backups are retained after selective deletion. Saved standing constraints remain separately controlled in Settings." }; }
  async close(): Promise<void> { await this.extraction.close(); }

  private async ingest(input: UploadInput, provenance: Pick<ArtifactRecord, "source" | "authority" | "uploader" | "sourceLocator" | "taskIds">): Promise<ArtifactMetadata> {
    this.assertStorage();
    const type = validateDocument(input.filename, input.mimeType, input.bytes);
    // Own the bytes before the first await so a caller cannot change the original/hash pair.
    const bytes = Buffer.from(input.bytes);
    nonempty(provenance.sourceLocator); nonempty(input.scope ?? "business");
    const previous = input.supersedes ? this.require(input.supersedes) : null;
    if (previous && (previous.version !== input.expectedVersion || previous.value.supersededBy !== null || previous.value.scope !== (input.scope ?? "business"))) throw new Error("Replacement requires current version and identical scope");
    if (previous?.value.authority !== "evidence" && provenance.authority === "evidence" && previous) throw new Error("Evidence cannot supersede an authoritative source");
    const id = randomUUID();
    const artifact: ArtifactRecord = { id, sourceVersion: (previous?.value.sourceVersion ?? 0) + 1, ...provenance, scope: input.scope ?? "business", supersedes: previous?.id ?? null, supersededBy: null, deleted: false, filename: input.filename, mimeType: type.mimeType, format: type.format, sha256: hash(bytes), size: bytes.byteLength, storageKey: `${id}.bin`, extraction: "pending", error: null, createdAt: this.store.now() };
    const file = await open(join(this.directory, artifact.storageKey), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    if (process.platform !== "win32") {
      const directory = await open(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await directory.sync(); } finally { await directory.close(); }
    }
    this.store.transaction(() => {
      if (previous && this.require(previous.id).version !== input.expectedVersion) throw new Error("Business revision conflict");
      this.store.put("artifact", id, artifact, null, validateArtifact);
      const source: KnowledgeSource = { id, sourceVersion: artifact.sourceVersion, sha256: artifact.sha256, authority: artifact.authority, scope: artifact.scope, source: artifact.source, sourceLocator: artifact.sourceLocator, uploader: artifact.uploader, supersedes: artifact.supersedes, supersededBy: null, deleted: false, chunks: [], taskIds: artifact.taskIds };
      this.store.put("knowledge", id, source, null, validateSource);
      if (previous) {
        this.store.put("artifact", previous.id, { ...previous.value, supersededBy: id }, previous.version, validateArtifact);
        const previousSource = this.store.get<KnowledgeSource>("knowledge", previous.id, validateSource)!;
        this.store.put("knowledge", previous.id, { ...previousSource.value, supersededBy: id }, previousSource.version, validateSource);
        this.store.removeKnowledgeChunks(previous.id);
        this.invalidateInterpretations(previous.id, id);
      }
    });
    return this.extract(id, bytes);
  }
  private async extract(id: string, bytes: Uint8Array): Promise<ArtifactMetadata> {
    const initial = this.require(id);
    let result: Extraction;
    try { result = await this.extraction.extract(bytes, initial.value.format); }
    catch (error) { result = { status: "failed", chunks: [], error: error instanceof Error ? error.message : "Extraction failed" }; }
    return this.store.transaction(() => {
      const current = this.require(id);
      if (current.version !== initial.version) throw new Error("Artifact changed during extraction");
      const updated = this.store.put("artifact", id, { ...current.value, extraction: result.status, error: result.error }, current.version, validateArtifact);
      const source = this.store.get<KnowledgeSource>("knowledge", id, validateSource)!;
      this.store.put("knowledge", id, { ...source.value, chunks: result.chunks }, source.version, validateSource);
      if (result.status === "ready" && !this.superseded(source.value)) this.store.replaceKnowledgeChunks(id, current.value.sourceVersion, result.chunks);
      else this.store.removeKnowledgeChunks(id);
      return this.public(updated.value, updated.version);
    });
  }
  private invalidateInterpretations(artifactId: string, replacementId: string | null): void {
    for (const source of this.store.list<KnowledgeSource>("knowledge", validateSource)) {
      if (source.value.source !== "model" || !source.value.sourceLocator.startsWith(`artifact:${artifactId}:`)) continue;
      this.store.put("knowledge", source.id, { ...source.value, deleted: replacementId === null, supersededBy: replacementId, chunks: replacementId ? source.value.chunks : [] }, source.version, validateSource);
      this.store.removeKnowledgeChunks(source.id);
    }
  }
  private superseded(source: KnowledgeSource): boolean { return source.supersededBy !== null; }
  private require(id: string) {
    if (!UUID.test(id)) throw new Error("Invalid artifact ID");
    const record = this.store.get<ArtifactRecord>("artifact", id, validateArtifact);
    if (!record || record.value.deleted) throw new Error("Artifact not found");
    return record;
  }
  private public(value: ArtifactRecord, version: number): ArtifactMetadata { const { storageKey: _storageKey, ...metadata } = value; return { ...metadata, version }; }
  private async bytes(artifact: ArtifactRecord): Promise<Buffer> {
    this.assertStorage();
    const bytes = await this.readPrivate(join(this.directory, artifact.storageKey), artifact.size);
    if (bytes.length !== artifact.size || hash(bytes) !== artifact.sha256) throw new Error("Artifact integrity mismatch");
    return bytes;
  }
  private assertGeneratedImport(): void {
    const privacy = this.store.get<{ takeover: boolean; credentialEntry: boolean; taskId: string | null }>("cursor", "computer:privacy");
    if (privacy && (typeof privacy.value.takeover !== "boolean" || typeof privacy.value.credentialEntry !== "boolean" || privacy.value.takeover || privacy.value.credentialEntry)) throw new Error("Generated artifact import blocked while computer privacy is active");
  }
  private assertStorage(): void {
    if (lstatSync(this.directory).isSymbolicLink() || realpathSync(this.directory) !== join(realpathSync(this.store.root), "artifacts")) throw new Error("Artifact storage symlink rejected");
  }
  private async readPrivate(path: string, maximum: number): Promise<Buffer> {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > maximum) throw new Error("Unsafe, hard-linked or oversized artifact file");
      const bytes = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < bytes.length) { const read = await file.read(bytes, offset, bytes.length - offset, offset); if (!read.bytesRead) throw new Error("Artifact truncated"); offset += read.bytesRead; }
      if ((await file.stat()).size !== stat.size) throw new Error("Artifact changed during read");
      return bytes;
    } finally { await file.close(); }
  }
}
