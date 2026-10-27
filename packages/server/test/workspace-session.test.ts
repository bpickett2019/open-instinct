import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { WorkspaceSessions } from "../src/workspace-session.js";
const token = "synthetic-unit-owner-token";
const origin = "https://owner.fixture.test";
function request(headers: Record<string, string> = {}, method = "GET"): IncomingMessage { const req = new IncomingMessage(new Socket()); req.method = method; req.headers = { host: "owner.fixture.test", ...headers }; return req; }
function signIn(sessions: WorkspaceSessions) { const req = request({ origin }, "POST"); const res = new ServerResponse(req); sessions.validateRequest(req); const session = sessions.login(req, res, token); const cookie = String(res.getHeader("set-cookie")).split(";")[0]!; return { session, cookie, res }; }
describe("owner workspace session boundary", () => {
  it("requires explicit loopback development and a nonempty token", () => {
    expect(() => new WorkspaceSessions({ token: " ", origin })).toThrow();
    expect(() => new WorkspaceSessions({ token, origin: "http://127.0.0.1:3000" })).toThrow();
    expect(() => new WorkspaceSessions({ token, origin: "http://owner.fixture.test", allowLoopbackHttp: true })).toThrow();
    expect(() => new WorkspaceSessions({ token, origin: "https://owner.fixture.test/" })).toThrow();
    const development = new WorkspaceSessions({ token, origin: "http://127.0.0.1:3000", allowLoopbackHttp: true }); expect(development.cookieName).toBe("instinct-owner-dev");
  });
  it("issues opaque host-only secure cookies and rejects bearer-as-session", () => {
    const sessions = new WorkspaceSessions({ token, origin }); const { cookie, session, res } = signIn(sessions);
    expect(res.getHeader("set-cookie")).toMatch(/^__Host-instinct-owner=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=86400; Secure$/);
    expect(cookie).not.toContain(token); expect(sessions.authenticate(request({ cookie })).csrf).toBe(session.csrf);
    expect(() => sessions.authenticate(request({ authorization: `Bearer ${token}` }))).toThrow(/Session expired/);
    expect(() => sessions.authenticate(request({ cookie: `__Host-instinct-owner=${token}` }))).toThrow();
    expect(() => sessions.authenticate(request({ cookie: `${cookie}; ${cookie}` }))).toThrow();
  });
  it("binds CSRF to the individual session and enforces logout", () => {
    const sessions = new WorkspaceSessions({ token, origin }); const a = signIn(sessions); const b = signIn(sessions);
    expect(() => sessions.authenticate(request({ cookie: a.cookie, "x-workspace-csrf": b.session.csrf }), true)).toThrow(/CSRF/);
    expect(sessions.authenticate(request({ cookie: a.cookie, "x-workspace-csrf": a.session.csrf }), true)).toBe(a.session);
    sessions.logout(request({ cookie: a.cookie }), new ServerResponse(request())); expect(() => sessions.authenticate(request({ cookie: a.cookie }))).toThrow(); expect(sessions.authenticate(request({ cookie: b.cookie }))).toBe(b.session);
    sessions.logout(request({ cookie: b.cookie }), new ServerResponse(request()), true); expect(sessions.summary().active).toBe(0);
  });
  it("expires at 30 minutes idle and 24 hours absolute despite activity", () => {
    let now = 0; const sessions = new WorkspaceSessions({ token, origin, now: () => now }); const a = signIn(sessions); now = 30 * 60_000; expect(() => sessions.authenticate(request({ cookie: a.cookie }))).toThrow();
    const b = signIn(sessions); const start = now;
    for (let step = 1; step < 50; step++) { now = start + step * 29 * 60_000; sessions.authenticate(request({ cookie: b.cookie })); }
    now = start + 24 * 60 * 60_000; expect(() => sessions.authenticate(request({ cookie: b.cookie }))).toThrow();
  });
  it("rejects foreign, null and absent mutation origins and exact Host mismatches", () => {
    const sessions = new WorkspaceSessions({ token, origin });
    for (const headers of [{ origin: "https://foreign.test" }, { origin: "null" }, { host: "OWNER.fixture.test" }, { "sec-fetch-site": "cross-site" }]) expect(() => sessions.validateRequest(request(headers))).toThrow();
    expect(() => sessions.validateRequest(request({}, "POST"))).toThrow();
    expect(() => sessions.validateRequest(request({ origin }, "POST"))).not.toThrow();
  });
  it("bounds attempts without trusting forwarded addresses and clears them only after the window", () => {
    let now = 0; const sessions = new WorkspaceSessions({ token, origin, now: () => now });
    for (let i = 0; i < 10; i++) expect(() => sessions.login(request({ "x-forwarded-for": `192.0.2.${i}` }), new ServerResponse(request()), "invalid")).toThrow(/Invalid workspace token/);
    expect(() => signIn(sessions)).toThrow(/Too many login attempts/); now = 15 * 60_000; expect(() => signIn(sessions)).not.toThrow();
  });
  it("restart invalidates sessions and private responses receive security headers", () => {
    const first = new WorkspaceSessions({ token, origin }); const { cookie } = signIn(first); const second = new WorkspaceSessions({ token, origin }); expect(() => second.authenticate(request({ cookie }))).toThrow();
    const res = new ServerResponse(request()); second.headers(res); expect(res.getHeader("cache-control")).toBe("no-store"); expect(res.getHeader("content-security-policy")).toContain("script-src 'self'"); expect(res.getHeader("content-security-policy")).not.toContain("unsafe-inline"); expect(res.getHeader("referrer-policy")).toBe("no-referrer");
  });
});
