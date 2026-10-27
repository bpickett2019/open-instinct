import { randomBytes } from "node:crypto";
import type { ToolContext } from "./tools.js";

export interface CredentialScope {
  workspaceId: string;
  principalId: string;
  conversationKey: string;
  taskId?: string;
}

export interface CredentialReference {
  credentialRef: string;
  fields: string[];
}

export interface CredentialResolver {
  resolve(reference: string, field: string, scope: CredentialScope): string;
  redact<T>(value: T): T;
  sensitive(scope: CredentialScope): boolean;
}

interface Entry {
  scope: CredentialScope;
  adapter: "hosted-computer";
  fields: Record<string, string>;
  expiresAt: number;
}

const SECRET_KEY = /^(?:password|passwd|passphrase|secret|client_?secret|access_?token|refresh_?token|session_?token|session_?id|authorization|cookie|set-cookie|api_?key|private_?key|card|card_?number|pan|cvc|cvv|security_?code|viewer_url)$/i;
const REDACTED = "[REDACTED]";

/** Defense in depth for untyped provider payloads. Vault references, not this filter, are the credential boundary. */
export function redactSensitive<T>(value: T, secrets: Iterable<string> = []): T {
  const known = [...secrets].filter(Boolean).sort((a, b) => b.length - a.length);
  const seen = new WeakSet<object>();
  const text = (input: string): string => {
    if (/^\s*[\[{]/.test(input)) {
      try { return JSON.stringify(visit(JSON.parse(input))); } catch { /* Not a JSON provider payload. */ }
    }
    return input.split(/(cred_[A-Za-z0-9_-]{43})/g).map((part) => {
      if (/^cred_[A-Za-z0-9_-]{43}$/.test(part)) return part;
      let result = part;
      for (const secret of known) {
        if (secret.length > 4) result = result.split(secret).join(REDACTED);
        else result = result.replace(new RegExp(`(?<![A-Za-z0-9])${secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9])`, "g"), REDACTED);
      }
      return result
        .replace(/\b(?:\d[ -]?){13,19}\b/g, REDACTED)
        .replace(/\b(Bearer\s+)\S+/gi, `$1${REDACTED}`)
        .replace(/((?:password|passwd|access_token|refresh_token|session_token|api_key|cvc|cvv)\s*[=:]\s*)[^\s,;]+/gi, `$1${REDACTED}`);
    }).join("");
  };
  const visit = (item: unknown): unknown => {
    if (typeof item === "string") return text(item);
    if (!item || typeof item !== "object") return item;
    if (seen.has(item)) return "[CIRCULAR]";
    seen.add(item);
    try {
      if (Array.isArray(item)) return item.map(visit);
      const out: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(item)) out[key] = SECRET_KEY.test(key) ? REDACTED : visit(val);
      return out;
    } finally {
      seen.delete(item);
    }
  };
  return visit(value) as T;
}

export function credentialScope(ctx: Pick<ToolContext, "principal" | "conversationKey" | "taskRun">, workspaceId: string): CredentialScope {
  if (ctx.principal.kind !== "owner" || ctx.principal.tier !== "owner") throw new Error("Credentials require owner authority");
  if (!workspaceId || !ctx.conversationKey) throw new Error("Credential scope is incomplete");
  return { workspaceId, principalId: ctx.principal.id, conversationKey: ctx.conversationKey, ...(ctx.taskRun ? { taskId: ctx.taskRun.taskId } : {}) };
}

function scopeKey(scope: CredentialScope): string {
  return JSON.stringify([scope.workspaceId, scope.principalId, scope.conversationKey, scope.taskId ?? null]);
}

/** Ephemeral controller-only secrets. Restart invalidates references; it never replays a credential operation. */
export class CredentialVault {
  #entries = new Map<string, Entry>();
  #secrets = new Set<string>();
  #sensitive = new Set<string>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Register controller/provider secrets for exact-value echo redaction, never for model access. */
  registerKnownSecrets(values: Iterable<string>): void {
    for (const value of values) if (value) this.#secrets.add(value);
  }

  issue(input: { scope: CredentialScope; adapter: "hosted-computer"; fields: Record<string, string>; expiresAt?: number }): CredentialReference {
    const { scope, adapter, fields } = input;
    if (!scope.workspaceId || !scope.principalId || !scope.conversationKey || !Object.keys(fields).length) throw new Error("Credential scope and fields are required");
    if (Object.values(fields).some((value) => typeof value !== "string" || !value)) throw new Error("Credential fields must be nonempty strings");
    const expiresAt = Math.min(input.expiresAt ?? Infinity, this.now() + 15 * 60_000);
    if (!Number.isFinite(expiresAt) || expiresAt <= this.now()) throw new Error("Credential has expired");
    const credentialRef = `cred_${randomBytes(32).toString("base64url")}`;
    this.#entries.set(credentialRef, { scope: { ...scope }, adapter, fields: { ...fields }, expiresAt });
    this.registerKnownSecrets(Object.values(fields));
    return { credentialRef, fields: Object.keys(fields) };
  }

  /** Pass this capability only to a trusted final adapter, never a model tool or API response. */
  createResolver(adapter: "hosted-computer"): CredentialResolver {
    return {
      resolve: (reference, field, scope) => {
        const entry = this.#entries.get(reference);
        if (!entry || entry.adapter !== adapter || scopeKey(entry.scope) !== scopeKey(scope) || entry.expiresAt <= this.now()) throw new Error("Credential reference unavailable for this scope");
        if (!Object.hasOwn(entry.fields, field)) throw new Error("Credential field unavailable");
        this.#sensitive.add(scopeKey(scope));
        return entry.fields[field]!;
      },
      redact: <T>(value: T): T => this.redact(value),
      sensitive: (scope) => this.#sensitive.has(scopeKey(scope)),
    };
  }

  redact<T>(value: T): T { return redactSensitive(value, this.#secrets); }

  revoke(reference: string): void { this.#entries.delete(reference); }

  close(): void {
    this.#entries.clear();
    this.#secrets.clear();
    this.#sensitive.clear();
  }
}
