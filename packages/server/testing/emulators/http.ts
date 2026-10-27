import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
export type FixtureHandler = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void> | void;
export interface FixtureServer { url: string; failures: Error[]; server: Server; close(): Promise<void> }
export async function listenFixture(handler: FixtureHandler): Promise<FixtureServer> {
  const failures: Error[] = [];
  const server = createServer((req, res) => {
    Promise.resolve().then(() => handler(req, res, new URL(req.url ?? "/", "http://127.0.0.1"))).catch(error => {
      failures.push(error instanceof Error ? error : new Error(String(error)));
      if (!res.headersSent) json(res, 500, { error: String(error) }); else res.destroy();
    });
  });
  const ready = Promise.withResolvers<void>();
  server.once("error", ready.reject); server.listen(0, "127.0.0.1", ready.resolve);
  await ready.promise;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture did not bind TCP");
  return { url: `http://127.0.0.1:${address.port}`, failures, server,
    async close() { const stopped = Promise.withResolvers<void>(); server.close(e => e ? stopped.reject(e) : stopped.resolve()); server.closeAllConnections(); await stopped.promise; },
  };
}
export function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value));
}
export async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 30 * 1024 * 1024) throw new Error("Fixture body too large"); chunks.push(Buffer.from(chunk)); }
  return record(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
}
export function exactKeys(value: Record<string, unknown>, allowed: string[]): void {
  const unknown = Object.keys(value).filter(key => !allowed.includes(key));
  if (unknown.length) throw new Error(`Unsupported fixture fields: ${unknown.join(", ")}`);
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected fixture object");
  return value as Record<string, unknown>;
}
export function string(value: unknown): string { if (typeof value !== "string") throw new Error("Expected fixture string"); return value; }
export function mcpReply(res: ServerResponse, request: Record<string, unknown>, tools: unknown[], invoke: (name: string, args: Record<string, unknown>) => unknown): void {
  if (!("id" in request)) { if (request.method !== "notifications/initialized" && request.method !== "notifications/cancelled") throw new Error(`Unsupported MCP notification ${request.method}`); res.writeHead(202); res.end(); return; }
  let result: unknown;
  const params = record(request.params ?? {});
  switch (request.method) {
    case "initialize": result = { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "synthetic-local-fixture", version: "1" } }; break;
    case "ping": result = {}; break;
    case "tools/list": result = { tools }; break;
    case "tools/call": result = invoke(string(params.name), record(params.arguments ?? {})); break;
    default: json(res, 200, { jsonrpc: "2.0", id: request.id, error: { code: -32601, message: `Unsupported method ${request.method}` } }); return;
  }
  json(res, 200, { jsonrpc: "2.0", id: request.id, result });
}
export function text(value: unknown) { return { content: [{ type: "text" as const, text: JSON.stringify(value) }] }; }
