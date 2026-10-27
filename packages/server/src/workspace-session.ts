import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export class WorkspaceHttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
interface Session { csrf: string; createdAt: number; seenAt: number }
export interface WorkspaceSessionOptions { token: string; origin: string; allowLoopbackHttp?: boolean; now?: () => number }
const hash = (value: string): Buffer => createHash("sha256").update(value).digest();
const equal = (a: string, b: string): boolean => timingSafeEqual(hash(a), hash(b));
export class WorkspaceSessions {
  readonly origin: string;
  readonly cookieName: string;
  private readonly secure: boolean;
  private readonly tokenHash: Buffer;
  private readonly sessions = new Map<string, Session>();
  private readonly attempts = new Map<string, { count: number; until: number }>();
  private readonly now: () => number;
  constructor(options: WorkspaceSessionOptions) {
    if (!options.token.trim()) throw new Error("Workspace requires INSTINCT_CHAT_TOKEN");
    const origin = new URL(options.origin);
    if (origin.origin !== options.origin || origin.username || origin.password) throw new Error("Workspace origin must be canonical without a path");
    this.secure = origin.protocol === "https:";
    if (!this.secure && !(options.allowLoopbackHttp === true && origin.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(origin.hostname))) throw new Error("Workspace requires HTTPS or explicitly enabled loopback HTTP");
    this.origin = origin.origin;
    this.cookieName = this.secure ? "__Host-instinct-owner" : "instinct-owner-dev";
    this.tokenHash = hash(options.token);
    this.now = options.now ?? Date.now;
  }
  headers(res: ServerResponse): void {
    res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; font-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    if (this.secure) res.setHeader("Strict-Transport-Security", "max-age=31536000");
  }
  validateRequest(req: IncomingMessage): void {
    if (req.headers.host !== new URL(this.origin).host) throw new WorkspaceHttpError(403, "Invalid workspace host");
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== this.origin) throw new WorkspaceHttpError(403, "Foreign origin rejected");
    if (req.headers["sec-fetch-site"] === "cross-site") throw new WorkspaceHttpError(403, "Cross-site request rejected");
    if (!["GET", "HEAD"].includes(req.method ?? "") && origin !== this.origin) throw new WorkspaceHttpError(403, "Workspace origin required");
  }
  login(req: IncomingMessage, res: ServerResponse, token: unknown): Session {
    const now = this.now();
    for (const [key, value] of this.attempts) if (value.until <= now) this.attempts.delete(key);
    const key = req.socket.remoteAddress ?? "unknown";
    const attempt = this.attempts.get(key) ?? { count: 0, until: now + 15 * 60_000 };
    if (attempt.count >= 10 || this.attempts.size >= 1024 && !this.attempts.has(key)) throw new WorkspaceHttpError(429, "Too many login attempts; retry in 15 minutes");
    attempt.count++; this.attempts.set(key, attempt);
    if (typeof token !== "string" || token.length > 4096 || !timingSafeEqual(hash(token), this.tokenHash)) throw new WorkspaceHttpError(401, "Invalid workspace token");
    this.prune();
    if (this.sessions.size >= 128) throw new WorkspaceHttpError(429, "Session limit reached; sign out an existing browser or wait for expiry");
    const opaque = randomBytes(32).toString("base64url");
    const session: Session = { csrf: randomBytes(32).toString("base64url"), createdAt: now, seenAt: now };
    this.sessions.set(hash(opaque).toString("hex"), session);
    res.setHeader("Set-Cookie", this.cookie(opaque, 86400));
    return session;
  }
  authenticate(req: IncomingMessage, mutation = false): Session {
    this.prune();
    const key = this.key(req); const session = key ? this.sessions.get(key) : undefined;
    if (!session) throw new WorkspaceHttpError(401, "Session expired. Sign in again; admitted work continues.");
    if (mutation && (typeof req.headers["x-workspace-csrf"] !== "string" || !equal(req.headers["x-workspace-csrf"], session.csrf))) throw new WorkspaceHttpError(403, "Invalid CSRF token");
    session.seenAt = this.now(); return session;
  }
  logout(req: IncomingMessage, res: ServerResponse, all = false): void {
    if (all) this.sessions.clear(); else { const key = this.key(req); if (key) this.sessions.delete(key); }
    res.setHeader("Set-Cookie", this.cookie("", 0));
  }
  summary(): { active: number; absoluteHours: number; idleMinutes: number } { this.prune(); return { active: this.sessions.size, absoluteHours: 24, idleMinutes: 30 }; }
  private key(req: IncomingMessage): string | undefined {
    const cookies = (req.headers.cookie ?? "").split(";").map(v => v.trim()).filter(v => v.startsWith(`${this.cookieName}=`));
    if (cookies.length !== 1) return undefined;
    const token = cookies[0]!.slice(this.cookieName.length + 1);
    return /^[A-Za-z0-9_-]{43}$/.test(token) ? hash(token).toString("hex") : undefined;
  }
  private cookie(value: string, age: number): string { return `${this.cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${this.secure ? "; Secure" : ""}`; }
  private prune(): void { const now = this.now(); for (const [key, s] of this.sessions) if (now - s.createdAt >= 86400_000 || now - s.seenAt >= 1800_000) this.sessions.delete(key); }
}
