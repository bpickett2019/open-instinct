import { createHash, randomUUID } from "node:crypto";
import { canonicalJson, type BusinessAuthority, type BusinessStore, type Json } from "@open-instinct/core";
import { currencyDigits, type Citation } from "./business-pricing.js";
import { nonempty, validateArtifact, validateProfile, validateSource, type ArtifactRecord, type KnowledgeSource, type ProfileFact, type ProfileRecord } from "./business-knowledge-types.js";

const QUESTIONS = [
  ["businessName", "What name should I use for your business?"], ["services", "Which services does your business provide?"],
  ["timezone", "Which timezone should I use for your business?"], ["currency", "Which currency do you use?"],
  ["serviceArea", "Which areas do you serve?"], ["operatingHours", "What are your business contact hours?"],
  ["signature", "What signature should I use in business messages?"], ["contacts", "Which business contacts should I know, or are there none yet?"],
  ["sourceDocuments", "Which documents should supply business facts, or are there none yet?"], ["standingRules", "What standing rules should I follow, or are there none?"],
] as const;
export interface ProfileInput { expectedVersion: number; facts: Array<{ key: string; value: Json; scope: string; citation?: Citation }> }
export function requireOwnerAuthority(store: BusinessStore, ownerRef: string): void {
  const authority = store.get<BusinessAuthority>("authority", ownerRef);
  if (!authority?.value.enabled || authority.value.kind !== "owner") throw new Error("Authenticated owner source required");
}
export class BusinessProfile {
  constructor(private readonly store: BusinessStore) {}
  current() {
    const profile = this.store.get<ProfileRecord>("profile", "current", validateProfile);
    const sources = new Map<string, KnowledgeSource | undefined>();
    const facts = (profile?.value.facts ?? []).filter(fact => {
      if (!sources.has(fact.citation.sourceId)) sources.set(fact.citation.sourceId, this.store.get<KnowledgeSource>("knowledge", fact.citation.sourceId, validateSource)?.value);
      const source = sources.get(fact.citation.sourceId);
      return source && !source.deleted && !source.supersededBy && source.sourceVersion === fact.citation.sourceVersion && source.chunks.some(chunk => chunk.locator === fact.citation.locator);
    });
    const conflict = QUESTIONS.find(([key]) => new Set(facts.filter(fact => fact.key === key && fact.scope === "business").map(fact => canonicalJson(fact.value))).size > 1);
    const next = conflict ?? QUESTIONS.find(([key]) => !facts.some(fact => fact.key === key && fact.scope === "business"));
    return { version: profile?.version ?? 0, facts, nextQuestion: next ? { key: next[0], question: `${conflict ? "The current sources disagree. " : ""}${next[1]}` } : null, followThroughDefaults: { maxUnanswered: 2 as const, intervalHours: 72 as const } };
  }
  private currentCitation(citation: Citation): boolean {
    const source = this.store.get<KnowledgeSource>("knowledge", citation.sourceId, validateSource);
    if (!source || source.value.deleted || source.value.sourceVersion !== citation.sourceVersion) return false;
    if (source.value.source === "owner") {
      const current = this.store.get<ProfileRecord>("profile", "current", validateProfile);
      if (!current?.value.facts.some(fact => fact.citation.sourceId === citation.sourceId && fact.citation.locator === citation.locator)) return false;
    }
    return source.value.supersededBy === null;
  }
  assertCitation(citation: Citation, authority = false, scope?: string): KnowledgeSource {
    if (!citation || !this.currentCitation(citation)) throw new Error("Missing, deleted or obsolete source citation");
    const source = this.store.get<KnowledgeSource>("knowledge", citation.sourceId, validateSource)!.value;
    if (!source.chunks.some(chunk => chunk.locator === citation.locator)) throw new Error("Citation locator does not exist");
    if (authority && source.authority === "evidence") throw new Error("Imported evidence cannot establish business policy");
    if (scope && source.scope !== "business" && source.scope !== scope) throw new Error("Source authority does not cover this scope");
    if (scope && source.source === "owner") {
      const fact = this.current().facts.find(fact => fact.citation.sourceId === citation.sourceId && fact.citation.locator === citation.locator);
      if (!fact || fact.scope !== "business" && fact.scope !== scope) throw new Error("Owner fact authority does not cover this scope");
    }
    if (["upload", "gmail", "generated"].includes(source.source)) {
      const artifact = this.store.get<ArtifactRecord>("artifact", source.id, validateArtifact);
      if (!artifact || artifact.value.extraction !== "ready") throw new Error("Source extraction or content validation is not ready");
    }
    return source;
  }
  save(input: ProfileInput, ownerRef: string) {
    requireOwnerAuthority(this.store, ownerRef);
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0 || !Array.isArray(input.facts) || !input.facts.length || input.facts.length > 100) throw new Error("Invalid profile update");
    return this.store.transaction(() => {
      const current = this.store.get<ProfileRecord>("profile", "current", validateProfile);
      if ((current?.version ?? 0) !== input.expectedVersion) throw new Error("Business revision conflict");
      const sourceId = randomUUID();
      const chunks: KnowledgeSource["chunks"] = [];
      const facts: ProfileFact[] = [...(current?.value.facts ?? [])];
      const touched = new Set<string>();
      for (const fact of input.facts) {
        nonempty(fact.key, 120); nonempty(fact.scope, 1000);
        if (!/^[a-zA-Z][\w.-]*$/.test(fact.key)) throw new Error("Invalid fact key");
        const key = `${fact.scope}:${fact.key}`;
        if (touched.has(key)) throw new Error("Duplicate profile fact"); touched.add(key);
        if (fact.key === "timezone") { if (typeof fact.value !== "string") throw new Error("Timezone required"); new Intl.DateTimeFormat("en", { timeZone: fact.value }).format(); }
        if (fact.key === "currency") { if (typeof fact.value !== "string") throw new Error("Currency required"); currencyDigits(fact.value); }
        if (canonicalJson(fact.value).length > 20_000) throw new Error("Profile fact exceeds limit");
        let citation: Citation;
        if (fact.citation) { this.assertCitation(fact.citation, true, fact.scope); citation = fact.citation; }
        else { citation = { sourceId, sourceVersion: 1, locator: `fact:${chunks.length + 1}` }; chunks.push({ locator: citation.locator, text: `${fact.key}: ${canonicalJson(fact.value)}` }); }
        // Owner corrections supersede only this key/scope. Independently cited documents
        // retain contradictions until the owner provides an explicit correction.
        for (let index = facts.length - 1; index >= 0; index--) {
          const existing = facts[index]!;
          if (existing.key === fact.key && existing.scope === fact.scope && (!fact.citation || existing.citation.sourceId === citation.sourceId)) facts.splice(index, 1);
        }
        facts.push({ key: fact.key, value: fact.value, scope: fact.scope, citation });
      }
      const source: KnowledgeSource = { id: sourceId, sourceVersion: 1, sha256: createHash("sha256").update(canonicalJson(chunks)).digest("hex"), authority: "owner", scope: "business", source: "owner", sourceLocator: ownerRef, uploader: ownerRef, supersedes: null, supersededBy: null, deleted: false, chunks, taskIds: [] };
      this.store.put("knowledge", sourceId, source, null, validateSource);
      this.store.replaceKnowledgeChunks(sourceId, 1, chunks);
      const value: ProfileRecord = { facts, sourceId };
      this.store.put("profile", `version:${input.expectedVersion + 1}`, value, null, validateProfile);
      this.store.put("profile", "current", value, current?.version ?? null, validateProfile);
      for (const previousId of new Set(current?.value.facts.map(fact => fact.citation.sourceId) ?? [])) {
        const previous = this.store.get<KnowledgeSource>("knowledge", previousId, validateSource);
        if (!previous || previous.value.source !== "owner" || previous.value.deleted) continue;
        const activeLocators = new Set(facts.filter(fact => fact.citation.sourceId === previousId).map(fact => fact.citation.locator));
        this.store.replaceKnowledgeChunks(previousId, previous.value.sourceVersion, previous.value.chunks.filter(chunk => activeLocators.has(chunk.locator)));
      }
      const settings = this.store.settings();
      const changedSettings = new Set(input.facts.filter(fact => fact.scope === "business").map(fact => fact.key));
      const timezoneFact = this.resolve("timezone", "business");
      const currencyFact = this.resolve("currency", "business");
      const standingRules = this.resolve("standingRules", "business");
      let constraints = settings.value.constraints;
      if (changedSettings.has("standingRules") && standingRules.status === "known") {
        const value = standingRules.facts[0]!.value;
        if (typeof value === "string") constraints = value.split("\n").map(rule => rule.trim()).filter(Boolean);
        else if (Array.isArray(value) && value.every(rule => typeof rule === "string")) constraints = value.map(rule => (rule as string).trim()).filter(Boolean);
        else throw new Error("Standing rules must be text or a list of text rules");
      }
      const timezone = changedSettings.has("timezone") && timezoneFact.status === "known" ? timezoneFact.facts[0]?.value : null;
      const currency = changedSettings.has("currency") && currencyFact.status === "known" ? currencyFact.facts[0]?.value : null;
      this.store.updateSettings(settings.version, { ...settings.value, profileVersion: input.expectedVersion + 1, constraints, ...(typeof timezone === "string" ? { timezone } : {}), ...(typeof currency === "string" ? { currency, limits: { ...settings.value.limits, currency } } : {}) });
      return this.current();
    });
  }
  resolve(key: string, scope: string): { status: "known" | "missing" | "conflict"; facts: ProfileFact[] } {
    const applicable = this.current().facts.filter(fact => fact.key === key && (fact.scope === scope || fact.scope === "business"));
    const scoped = applicable.filter(fact => fact.scope === scope);
    const facts = scoped.length ? scoped : applicable;
    return { status: !facts.length ? "missing" : new Set(facts.map(fact => canonicalJson(fact.value))).size > 1 ? "conflict" : "known", facts };
  }
  compactContext(): string {
    const profile = this.current();
    const facts: string[] = [];
    let remaining = 10_000;
    for (const fact of profile.facts) {
      const encoded = canonicalJson(fact);
      if (encoded.length > remaining) continue;
      remaining -= encoded.length; facts.push(encoded);
    }
    return `{"facts":[${facts.join(",")}],"nextQuestion":${canonicalJson(profile.nextQuestion)},"omittedFactCount":${profile.facts.length - facts.length}}`;
  }
}
