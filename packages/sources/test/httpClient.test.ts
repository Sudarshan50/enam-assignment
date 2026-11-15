import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHttpClient, HostNotAllowedError, HttpError } from "../src/http/client";
import { createThrottle } from "../src/http/throttle";

type Make = () => Response;
type FetchInput = Parameters<typeof fetch>[0];

/**
 * fetch stand-in that honours `redirect` like the real one: "follow" requests every hop itself,
 * "manual" hands the 3xx back. Each route is a queue of responses (the last one repeats).
 */
function fakeFetch(routes: Record<string, Make | Make[]>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const served: Record<string, number> = {};
  const impl = (async (input: FetchInput, init: RequestInit = {}) => {
    let url = String(input);
    for (let hop = 0; ; hop++) {
      if (hop > 20) throw new TypeError("fetch failed: redirect count exceeded");
      calls.push({ url, init });
      const route = routes[url];
      if (!route) return new Response("not found", { status: 404 });
      const queue = Array.isArray(route) ? route : [route];
      const i = served[url] ?? 0;
      served[url] = i + 1;
      const res = queue[Math.min(i, queue.length - 1)]!();
      const location = res.headers.get("location");
      if (location && res.status >= 300 && res.status < 400 && init.redirect !== "manual") {
        url = new URL(location, url).toString();
        continue;
      }
      Object.defineProperty(res, "url", { value: url });
      return res;
    }
  }) as typeof fetch;
  return { impl, calls };
}

const status = (code: number, body = "") => () => new Response(body, { status: code });
const ok = (body: string, headers: Record<string, string> = {}) => () => new Response(body, { status: 200, headers });
const redirect = (location: string) => () => new Response(null, { status: 302, headers: { location } });

const API = "https://www.nseindia.in/api/x";

describe("HttpClient allowlist", () => {
  const http = createHttpClient({ allowedHostSuffixes: ["tcs.com"] });

  it("allows the default NSE / screener / yahoo hosts, case-insensitively", () => {
    expect(http.isAllowed("https://www.nseindia.com/api/x")).toBe(true);
    expect(http.isAllowed("https://NSEARCHIVES.NSEINDIA.COM/content/x.zip")).toBe(true);
    expect(http.isAllowed("https://www.screener.in/company/TCS/")).toBe(true);
    expect(http.isAllowed("https://query1.finance.yahoo.com/v8/finance/chart/TCS.NS")).toBe(true);
    expect(http.isAllowed("http://www.bseindia.com/x.pdf")).toBe(true);
  });

  it("matches suffixes on a label boundary only", () => {
    expect(http.isAllowed("https://tcs.com/ir.pdf")).toBe(true);
    expect(http.isAllowed("https://investors.ir.tcs.com/ar.pdf")).toBe(true);
    expect(http.isAllowed("https://eviltcs.com/ar.pdf")).toBe(false);
    expect(http.isAllowed("https://tcs.com.evil.io/ar.pdf")).toBe(false);
  });

  it("rejects look-alike hosts, userinfo tricks and unknown hosts", () => {
    expect(http.isAllowed("https://www.nseindia.com.evil.io/")).toBe(false);
    expect(http.isAllowed("https://nseindia.com/")).toBe(false);
    expect(http.isAllowed("https://www.nseindia.com@169.254.169.254/latest/meta-data")).toBe(false);
    expect(http.isAllowed("https://evil.io/#@www.nseindia.com")).toBe(false);
    expect(http.isAllowed("http://localhost:5432/")).toBe(false);
  });

  it("rejects non-http schemes and unparseable URLs", () => {
    for (const url of ["ftp://www.nseindia.com/x", "file:///etc/passwd", "javascript:alert(1)", "data:text/plain,hi", "not a url", ""]) {
      expect(http.isAllowed(url)).toBe(false);
    }
  });

  it("replaces the defaults when allowedHosts is given", () => {
    const custom = createHttpClient({ allowedHosts: ["example.org"] });
    expect(custom.isAllowed("https://example.org/")).toBe(true);
    expect(custom.isAllowed("https://www.nseindia.com/")).toBe(false);
  });

  it("refuses a disallowed URL without making a request", async () => {
    const { impl, calls } = fakeFetch({});
    const client = createHttpClient({ fetchImpl: impl });
    const err = await client.getText("https://evil.io/x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostNotAllowedError);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ url: "https://evil.io/x", status: null });
    expect(calls).toHaveLength(0);
  });
});

describe("HttpClient redirects", () => {
  it("follows redirects between allowed hosts, resolving relative locations", async () => {
    const { impl, calls } = fakeFetch({
      "https://www.nseindia.com/api/x": redirect("https://www.nseindia.in/api/x"),
      [API]: redirect("/api/y"),
      "https://www.nseindia.in/api/y": ok("done"),
    });
    const client = createHttpClient({ fetchImpl: impl });
    expect(await client.getText("https://www.nseindia.com/api/x")).toBe("done");
    expect(calls.map((c) => c.url)).toEqual(["https://www.nseindia.com/api/x", API, "https://www.nseindia.in/api/y"]);
  });

  it("rejects a redirect to a disallowed host without ever requesting it", async () => {
    const target = "http://169.254.169.254/latest/meta-data";
    const { impl, calls } = fakeFetch({ [API]: redirect(target), [target]: ok("secret") });
    const client = createHttpClient({ fetchImpl: impl, retries: 3 });
    await expect(client.getText(API)).rejects.toThrow(HostNotAllowedError);
    expect(calls.map((c) => c.url)).toEqual([API]);
  });

  it("rejects a response whose final URL is off the allowlist", async () => {
    const impl = (async () => {
      const res = new Response("x");
      Object.defineProperty(res, "url", { value: "https://evil.io/landing" });
      return res;
    }) as typeof fetch;
    await expect(createHttpClient({ fetchImpl: impl }).getText(API)).rejects.toThrow(/evil\.io/);
  });

  it("uses real fetch: follows an allowed redirect and never connects to a disallowed one", async () => {
    const hits: string[] = [];
    const server = createServer((req, res) => {
      hits.push(`${req.headers.host}${req.url}`);
      if (req.url === "/start") res.writeHead(302, { location: "/final" }).end();
      else if (req.url === "/escape") res.writeHead(302, { location: `http://localhost:${port()}/final` }).end();
      else res.end("landed");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = () => (server.address() as AddressInfo).port;
    try {
      const client = createHttpClient({ allowedHosts: ["127.0.0.1"], retries: 0, timeoutMs: 5_000 });
      expect(await client.getText(`http://127.0.0.1:${port()}/start`)).toBe("landed");
      await expect(client.getText(`http://127.0.0.1:${port()}/escape`)).rejects.toThrow(HostNotAllowedError);
      expect(hits.map((h) => h.replace(/:\d+/, ""))).toEqual(["127.0.0.1/start", "127.0.0.1/final", "127.0.0.1/escape"]);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it("gives up on redirect loops", async () => {
    const { impl, calls } = fakeFetch({ [API]: redirect(API) });
    await expect(createHttpClient({ fetchImpl: impl, retries: 0 }).getText(API)).rejects.toThrow(/Too many redirects/);
    expect(calls.length).toBeLessThanOrEqual(6);
  });
});

describe("HttpClient retries", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("retries 5xx and 429 with exponential backoff, then succeeds", async () => {
    const { impl, calls } = fakeFetch({ [API]: [status(503), status(429), ok("fine")] });
    const p = createHttpClient({ fetchImpl: impl }).getText(API);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(499);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(3);
    expect(await p).toBe("fine");
  });

  it("throws the last HttpError after exhausting retries", async () => {
    const { impl, calls } = fakeFetch({ [API]: status(500) });
    const p = createHttpClient({ fetchImpl: impl, retries: 2 }).getText(API);
    const assertion = expect(p).rejects.toMatchObject({ name: "HttpError", status: 500, url: API, message: `HTTP 500 for ${API}` });
    await vi.runAllTimersAsync();
    await assertion;
    expect(calls).toHaveLength(3);
  });

  it("retries network errors", async () => {
    let n = 0;
    const impl = (async () => {
      if (n++ === 0) throw new TypeError("fetch failed");
      return new Response("[]");
    }) as typeof fetch;
    const p = createHttpClient({ fetchImpl: impl }).getJson(API);
    await vi.runAllTimersAsync();
    expect(await p).toEqual([]);
    expect(n).toBe(2);
  });

  it.each([400, 401, 403, 404, 410])("does not retry HTTP %i", async (code) => {
    const { impl, calls } = fakeFetch({ [API]: status(code) });
    await expect(createHttpClient({ fetchImpl: impl }).getText(API)).rejects.toMatchObject({ status: code });
    expect(calls).toHaveLength(1);
  });

  it("wraps non-Error rejections in an HttpError", async () => {
    const impl = (() => Promise.reject("socket hang up")) as typeof fetch;
    await expect(createHttpClient({ fetchImpl: impl, retries: 0 }).getText(API)).rejects.toMatchObject({
      name: "HttpError",
      message: "socket hang up",
      status: null,
    });
  });
});

describe("HttpClient requests and bodies", () => {
  it("sends a browser UA, a per-method Accept and caller headers", async () => {
    const { impl, calls } = fakeFetch({ [API]: ok("{}") });
    const client = createHttpClient({ fetchImpl: impl, userAgent: "finn-test" });
    await client.getJson(API, { Referer: "https://www.nseindia.com/" });
    await client.getText(API);
    await client.getBuffer(API, { Accept: "application/zip" });
    const headers = calls.map((c) => c.init.headers as Record<string, string>);
    expect(headers[0]).toMatchObject({ "User-Agent": "finn-test", Accept: "application/json, text/plain, */*", Referer: "https://www.nseindia.com/" });
    expect(headers[1]!.Accept).toMatch(/^text\/html/);
    expect(headers[2]!.Accept).toBe("application/zip");
    expect(calls.every((c) => c.init.signal instanceof AbortSignal)).toBe(true);
  });

  it("returns raw bytes from getBuffer", async () => {
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    const impl = (async () => new Response(bytes)) as typeof fetch;
    expect(await createHttpClient({ fetchImpl: impl }).getBuffer(API)).toEqual(bytes);
  });

  it("rejects an oversized declared content-length before reading the body", async () => {
    const res = new Response("0123456789A", { headers: { "content-length": "11" } });
    const impl = (async () => res) as typeof fetch;
    await expect(createHttpClient({ fetchImpl: impl, maxBytes: 10 }).getText(API)).rejects.toThrow("Response too large (11 bytes)");
    expect(res.bodyUsed).toBe(false);
  });

  it("rejects an oversized body even when content-length is absent or lies", async () => {
    const body = "x".repeat(20);
    const noLength = (async () => new Response(body)) as typeof fetch;
    const lying = (async () => new Response(body, { headers: { "content-length": "5" } })) as typeof fetch;
    await expect(createHttpClient({ fetchImpl: noLength, maxBytes: 10 }).getText(API)).rejects.toThrow("Response too large (20 bytes)");
    await expect(createHttpClient({ fetchImpl: lying, maxBytes: 10 }).getBuffer(API)).rejects.toThrow("Response too large (20 bytes)");
  });

  it("accepts a body of exactly maxBytes", async () => {
    const impl = (async () => new Response("x".repeat(10))) as typeof fetch;
    expect(await createHttpClient({ fetchImpl: impl, maxBytes: 10 }).getText(API)).toHaveLength(10);
  });

  it("reports invalid JSON with the URL and the start of the body", async () => {
    const html = `<html><title>Access Denied</title>${"y".repeat(200)}</html>`;
    const impl = (async () => new Response(html)) as typeof fetch;
    const err = (await createHttpClient({ fetchImpl: impl }).getJson(API).catch((e: unknown) => e)) as HttpError;
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(200);
    expect(err.message).toBe(`Invalid JSON from ${API}: ${html.slice(0, 120)}`);
  });

  it("aborts a request that exceeds timeoutMs", async () => {
    const impl = ((_url: FetchInput, init?: RequestInit) =>
      new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)))) as typeof fetch;
    await expect(createHttpClient({ fetchImpl: impl, timeoutMs: 20, retries: 0 }).getText(API)).rejects.toMatchObject({ name: "TimeoutError" });
  });
});

describe("createThrottle", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("serialises concurrent waiters with the default timer-based sleep", async () => {
    vi.useFakeTimers();
    const throttle = createThrottle({ minIntervalMs: 1000 });
    const resolved: number[] = [];
    const all = [0, 1, 2].map((i) => throttle.wait().then(() => resolved.push(i)));
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toEqual([0]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(resolved).toEqual([0, 1]);
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all(all);
    expect(resolved).toEqual([0, 1, 2]);
  });
});
