import { randomUUID } from "node:crypto";
import { isValidTimeZone, localParts } from "@open-instinct/core";
import { body, exactKeys, json, listenFixture, record, string, type FixtureServer } from "./http.js";
export interface CalendarEvent { id: string; etag: string; status: string; [key: string]: unknown }
export interface CalendarFixture extends FixtureServer {
  events: Map<string, CalendarEvent>; journal: Array<{ method: string; path: string; body: unknown }>;
  calendar: { id: string; summary: string; timeZone: string };
  failNext(status: number): void; wrongReadback(value?: boolean): void; raceUpdate(id: string, patch: Record<string, unknown>): void;
  holdNextFreebusy(until: Promise<void>): void;
  seedRecurringSeries(master: CalendarEvent, occurrences: CalendarEvent[], window: { timeMin: string; timeMax: string }): void;
}
export async function createCalendarFixture(): Promise<CalendarFixture> {
  const events = new Map<string, CalendarEvent>();
  // Occurrences are explicit synthetic data, complete only within the declared window.
  // No RRULE evaluation or general recurrence expansion is implemented.
  const seriesWindows = new Map<string, { start: number; end: number }>();
  const journal: Array<{method:string;path:string;body:unknown}> = [];
  let revision = 0;
  let nextStatus: number | undefined;
  let corruptReadback = false;
  let freebusyGate: Promise<void> | undefined;
  const etag = () => `"fixture-${++revision}"`;
  const calendar = { id: "owner@fixture.test", summary: "Fictional Field Services", timeZone: "UTC" };
  function instant(value: unknown): number {
    const time = record(value);
    if (time.dateTime !== undefined) return Date.parse(string(time.dateTime));
    const date = string(time.date), zone = string(time.timeZone ?? calendar.timeZone);
    const midnight = Date.parse(`${date}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(midnight) ||
        new Date(midnight).toISOString().slice(0,10) !== date || !isValidTimeZone(zone)) {
      throw new Error("Invalid fixture all-day date or timezone");
    }
    // Resolve local midnight with bounded offset corrections. Skipped local dates
    // or midnight gaps are unsupported, never silently interpreted as UTC.
    let candidate = midnight;
    for (let attempt = 0; attempt < 4; attempt++) {
      const parts = localParts(new Date(candidate),zone);
      const wallTime = Date.parse(`${parts.date}T00:00:00Z`) + parts.hour * 3_600_000 + parts.minute * 60_000;
      const correction = midnight - wallTime;
      if (correction === 0) return candidate;
      candidate += correction;
    }
    throw new Error("Unsupported fixture all-day midnight transition");
  }
  const server = await listenFixture(async (req, res, url) => {
    const method = req.method ?? "GET";
    if (nextStatus) { const status = nextStatus; nextStatus = undefined; json(res,status,{error:{code:status}}); return; }
    const value = method === "GET" || method === "DELETE" ? {} : await body(req);
    journal.push({method,path:url.pathname,body:value});
    if (url.pathname === "/calendar/v3/freeBusy" && method === "POST") {
      exactKeys(value,["timeMin","timeMax","timeZone","items","groupExpansionMax","calendarExpansionMax"]);
      const gate=freebusyGate;freebusyGate=undefined;if(gate)await gate;
      const start = Date.parse(string(value.timeMin)), end = Date.parse(string(value.timeMax));
      if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end || !Array.isArray(value.items)) { json(res,400,{error:{code:400}}); return; }
      const calendars: Record<string, unknown> = {};
      for (const item of value.items) {
        const calendarId = string(record(item).id);
        if (!["primary",calendar.id].includes(calendarId)) { calendars[calendarId] = { errors:[{reason:"notFound"}] }; continue; }
        calendars[calendarId] = {busy:[...events.values()].filter(e => e.status !== "cancelled" && e.transparency !== "transparent").flatMap(e => {
          const a = instant(e.start), b = instant(e.end);
          return a < end && b > start ? [{start:new Date(Math.max(a,start)).toISOString(),end:new Date(Math.min(b,end)).toISOString()}] : [];
        })};
      }
      json(res,200,{kind:"calendar#freeBusy",timeMin:value.timeMin,timeMax:value.timeMax,calendars}); return;
    }
    if (url.pathname === "/calendar/v3/users/me/calendarList" && method === "GET") { json(res,200,{items:[{...calendar,primary:true,accessRole:"owner"}]}); return; }
    const match = /^\/calendar\/v3\/calendars\/([^/]+)(?:\/events(?:\/([^/]+))?)?$/.exec(url.pathname);
    if (!match || !["primary",calendar.id].includes(decodeURIComponent(match[1]!))) { json(res,404,{error:{code:404,message:"Unsupported calendar endpoint"}}); return; }
    if (!url.pathname.includes("/events")) { json(res,method === "GET" ? 200 : 405,calendar); return; }
    const id = match[2] && decodeURIComponent(match[2]);
    if (!id && method === "GET") {
      const query = url.searchParams;
      const max = Number(query.get("maxResults") ?? 100), offset = Number(query.get("pageToken") ?? 0);
      const start = query.has("timeMin") ? Date.parse(query.get("timeMin")!) : -Infinity;
      const end = query.has("timeMax") ? Date.parse(query.get("timeMax")!) : Infinity;
      const single = query.get("singleEvents") === "true", order = query.get("orderBy");
      if (!Number.isSafeInteger(max) || max < 1 || max > 2500 || !Number.isSafeInteger(offset) || offset < 0 ||
          Number.isNaN(start) || Number.isNaN(end) || start >= end ||
          (query.has("singleEvents") && !["true", "false"].includes(query.get("singleEvents")!)) ||
          (order !== null && (order !== "startTime" || !single))) {
        json(res,400,{error:{code:400,message:"Invalid or unsupported fixture events query"}}); return;
      }
      if (single) {
        for (const event of events.values()) {
          if (!event.recurrence) continue;
          const window = seriesWindows.get(event.id);
          if (!window || start < window.start || end > window.end) {
            json(res,400,{error:{code:400,message:"Fixture recurrence requires explicitly seeded occurrences covering the requested window"}}); return;
          }
        }
      }
      const items = [...events.values()].filter(event =>
        (single ? !event.recurrence : !event.recurringEventId) &&
        (query.get("showDeleted") === "true" || event.status !== "cancelled") &&
        instant(event.end) > start && instant(event.start) < end);
      if (order === "startTime") items.sort((a,b) => instant(a.start) - instant(b.start) || a.id.localeCompare(b.id));
      json(res,200,{items:items.slice(offset,offset+max),...(offset+max < items.length ? {nextPageToken:String(offset+max)} : {})}); return;
    }
    if (!id && method === "POST") {
      exactKeys(value,["id","summary","description","location","start","end","attendees","reminders","transparency","extendedProperties","status"]);
      const eventId = value.id === undefined ? randomUUID().replaceAll("-","") : string(value.id);
      if (!/^[a-v0-9]{5,1024}$/.test(eventId) || !value.start || !value.end) { json(res,400,{error:{code:400}}); return; }
      if (events.has(eventId)) { json(res,409,{error:{code:409,message:"Identifier already exists"}}); return; }
      const event = {...value,id:eventId,etag:etag(),status:"confirmed"} as CalendarEvent; events.set(eventId,event); json(res,200,event); return;
    }
    const event = id ? events.get(id) : undefined;
    if (!event) { json(res,404,{error:{code:404}}); return; }
    if (method === "GET") { json(res,200,corruptReadback ? {...event,summary:"Deliberately wrong readback"} : event); return; }
    if (!["PUT","PATCH","DELETE"].includes(method)) { json(res,405,{error:{code:405}}); return; }
    if (req.headers["if-match"] && req.headers["if-match"] !== event.etag) { json(res,412,{error:{code:412,message:"Precondition Failed"}}); return; }
    if (method === "DELETE") { events.set(event.id,{...event,status:"cancelled",etag:etag()}); res.writeHead(204); res.end(); return; }
    exactKeys(value,["id","etag","status","summary","description","location","start","end","attendees","reminders","transparency","extendedProperties"]);
    const updated: CalendarEvent = {...(method === "PATCH" ? event : {}),...value,id:event.id,etag:etag(),status:value.status === undefined ? "confirmed" : string(value.status)};
    events.set(event.id,updated); json(res,200,updated);
  });
  function seedRecurringSeries(master: CalendarEvent, occurrences: CalendarEvent[], window: { timeMin: string; timeMax: string }): void {
    const start = Date.parse(window.timeMin), end = Date.parse(window.timeMax);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end ||
        !Array.isArray(master.recurrence) || !master.recurrence.length || master.recurringEventId ||
        events.has(master.id) || occurrences.some(event =>
          event.id === master.id || events.has(event.id) || event.recurrence ||
          event.recurringEventId !== master.id || !event.originalStartTime ||
          !Number.isFinite(instant(event.originalStartTime)) || !Number.isFinite(instant(event.start)) ||
          !Number.isFinite(instant(event.end)) || instant(event.start) >= instant(event.end)) ||
        new Set(occurrences.map(event => event.id)).size !== occurrences.length) {
      throw new Error("Invalid explicit fixture recurring series");
    }
    events.set(master.id,master);
    for (const occurrence of occurrences) events.set(occurrence.id,occurrence);
    seriesWindows.set(master.id,{start,end});
  }
  return {...server,events,journal,calendar,seedRecurringSeries,holdNextFreebusy(until){if(freebusyGate)throw new Error("Freebusy gate already armed");freebusyGate=until;},failNext(status:number){nextStatus=status;},wrongReadback(value=true){corruptReadback=value;},raceUpdate(id:string,patch:Record<string,unknown>){const event=events.get(id);if(!event)throw new Error("Unknown event");events.set(id,{...event,...patch,etag:etag()});}};
}
