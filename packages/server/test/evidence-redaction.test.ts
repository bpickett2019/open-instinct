import { expect, it } from "vitest";
import { redactTraceValue } from "../e2e/redact-trace.js";

it("redacts named session cookies, credential headers and nested private trace fields", () => {
  const trace = {
    type: "after",
    result: [
      { name: "instinct-owner-dev", value: "private-browser-session", httpOnly: true },
      { name: "__Host-instinct-owner", value: "private-production-session", httpOnly: true },
      { name: "X-Workspace-CSRF", value: "private-csrf", diagnostic: { token: "private-nested-token" } },
      { name: "Content-Type", value: "application/json" },
    ],
    request: { headers: [{ name: "Authorization", value: "Bearer private-auth" }], postData: { text: "private-body" } },
    response: { csrf: "private-response-csrf", cookies: ["private-response-cookie"] },
    storageState: { cookies: ["private-storage-cookie"] },
    message: "Fill synthetic-owner-workspace-token; instinct-owner-dev=private-log-session; Bearer private-log-auth",
    callId: "call@42",
  };
  const redacted = redactTraceValue(trace);
  const serialized = JSON.stringify(redacted);
  expect(serialized).not.toContain("private-"); expect(serialized).not.toContain("synthetic-owner-workspace-token");
  expect(redacted).toMatchObject({ type: "after", callId: "call@42", result: [
    { name: "instinct-owner-dev", value: "[redacted]", httpOnly: true },
    { name: "__Host-instinct-owner", value: "[redacted]", httpOnly: true },
    { name: "X-Workspace-CSRF", value: "[redacted]", diagnostic: { token: "[redacted]" } },
    { name: "Content-Type", value: "application/json" },
  ] });
  expect(trace.result[0]!.value).toBe("private-browser-session");
});
