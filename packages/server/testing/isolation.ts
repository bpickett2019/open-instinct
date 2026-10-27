export class OutboundIsolation {
  readonly origins = new Set<string>();
  readonly violations: string[] = [];
  private readonly nativeFetch = globalThis.fetch.bind(globalThis);
  private previous?: typeof fetch;
  allow(origin: string): void {
    const url = new URL(origin);
    if (url.hostname !== "127.0.0.1" || url.protocol !== "http:" || url.username || url.password) throw new Error(`Not a fixture origin: ${origin}`);
    this.origins.add(url.origin);
  }
  assertAllowed(input: string | URL): URL {
    const url = new URL(input);
    if (url.username || url.password || !this.origins.has(url.origin)) {
      const message = `Forbidden nonfixture destination: ${url.origin}${url.pathname}`;
      this.violations.push(message);
      throw new Error(message);
    }
    return url;
  }
  readonly fetch: typeof fetch = async (input, init) => {
    let request = new Request(input, init);
    for (let hop = 0; hop <= 10; hop++) {
      this.assertAllowed(request.url);
      const replay = request.clone();
      const response = await this.nativeFetch(request, { redirect: "manual" });
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      const location = response.headers.get("location");
      if (!location) return response;
      const target = this.assertAllowed(new URL(location, request.url));
      if (request.redirect === "manual") return response;
      if (request.redirect === "error") throw new Error("Fixture redirect forbidden by caller");
      await response.body?.cancel();
      const toGet = response.status === 303 || ((response.status === 301 || response.status === 302) && request.method === "POST");
      request = toGet ? new Request(target, { headers: request.headers, signal: request.signal }) : new Request(target, replay);
    }
    throw new Error("Fixture redirect limit exceeded");
  };
  install(): void {
    if (this.previous) throw new Error("Isolation already installed; suites must run serially");
    this.previous = globalThis.fetch;
    globalThis.fetch = this.fetch;
  }
  restore(): void {
    if (this.previous) { globalThis.fetch = this.previous; this.previous = undefined; }
  }
  assertClean(): void {
    if (this.violations.length) throw new Error(`Outbound isolation violations (including swallowed errors):\n${this.violations.join("\n")}`);
  }
}
