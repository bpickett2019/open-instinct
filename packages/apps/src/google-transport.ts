export interface GoogleRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  endpoint: string;
  query?: Record<string, string>;
  body?: Record<string, unknown>;
  ifMatch?: string;
}
export interface GoogleTransport {
  request(input: GoogleRequest): Promise<{ status: number; data: unknown }>;
}

/** Fixed native operations only. No arbitrary authenticated HTTP or alternate user paths. */
export function googleToolkit(input: GoogleRequest): "gmail" | "googlecalendar" {
  if (/%2f|%5c|%2e|\/\.\.?(?:\/|$)|\\/i.test(input.endpoint)) throw new Error("Unsupported Google endpoint");
  const url = new URL(input.endpoint);
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash || /%2f|%5c|%2e/i.test(url.pathname)) throw new Error("Unsupported Google endpoint");
  const path = url.pathname;
  const queryKeys = url.hostname === "gmail.googleapis.com"
    ? ["q", "maxResults", "pageToken", "format", "startHistoryId", "labelId", "historyTypes", "includeSpamTrash", "labelIds"]
    : ["timeMin", "timeMax", "timeZone", "maxResults", "pageToken", "singleEvents", "orderBy", "showDeleted", "sendUpdates"];
  for (const [key, value] of Object.entries(input.query ?? {})) {
    if (!queryKeys.includes(key) || typeof value !== "string" || /[\r\n\0]/.test(value)) throw new Error("Unsupported Google query parameter");
  }
  let allowed = false;
  if (url.hostname === "gmail.googleapis.com") {
    allowed = input.method === "GET" && /^\/gmail\/v1\/users\/me\/(profile|labels|history|messages(?:\/[^/]+(?:\/attachments\/[^/]+)?)?|threads(?:\/[^/]+)?)$/.test(path)
      || input.method === "POST" && path === "/gmail/v1/users/me/messages/send";
    if (!allowed) throw new Error("Unsupported Gmail operation");
    if (input.ifMatch) throw new Error("Gmail conditional request unsupported");
    return "gmail";
  }
  if (url.hostname === "www.googleapis.com") {
    allowed = input.method === "POST" && path === "/calendar/v3/freeBusy"
      || input.method === "GET" && /^\/calendar\/v3\/(users\/me\/calendarList|calendars\/[^/]+(?:\/events(?:\/[^/]+)?)?)$/.test(path)
      || input.method === "POST" && /^\/calendar\/v3\/calendars\/[^/]+\/events$/.test(path)
      || ["PUT", "PATCH", "DELETE"].includes(input.method) && /^\/calendar\/v3\/calendars\/[^/]+\/events\/[^/]+$/.test(path);
    if (!allowed) throw new Error("Unsupported Calendar operation");
    if (input.ifMatch && /[\r\n]/.test(input.ifMatch)) throw new Error("Invalid etag");
    return "googlecalendar";
  }
  throw new Error("Unsupported Google host");
}
export class GoogleProviderError extends Error {
  constructor(readonly status: number) { super(`Google request failed (${status}): ${status === 401 ? "authentication revoked" : status === 403 ? "missing scope or forbidden" : status === 429 ? "rate limited" : status >= 500 ? "provider unavailable; effect may be unknown" : "provider rejected request"}`); }
}
