const DEFAULT_ALLOWED_HOSTS = [
  "www.nseindia.com",
  "www.nseindia.in",
  "nseindia.in",
  "nsearchives.nseindia.com",
  "nsearchives.nseindia.in",
  "archives.nseindia.com",
  "www.bseindia.com",
  "www.screener.in",
  "query1.finance.yahoo.com",
];

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36";

export class HttpError extends Error {
  constructor(
    message: string,
    readonly url: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export class HostNotAllowedError extends HttpError {
  constructor(url: string) {
    super(`Host not in allowlist: ${url}`, url, null);
    this.name = "HostNotAllowedError";
  }
}

export interface HttpClientOptions {
  allowedHosts?: string[];
  /** Hosts matching these suffixes are also allowed (e.g. company IR sites discovered via screener). */
  allowedHostSuffixes?: string[];
  timeoutMs?: number;
  retries?: number;
  maxBytes?: number;
  userAgent?: string;
  fetchImpl?: typeof fetch;
}

export interface HttpClient {
  getJson<T = unknown>(url: string, headers?: Record<string, string>): Promise<T>;
  getText(url: string, headers?: Record<string, string>): Promise<string>;
  getBuffer(url: string, headers?: Record<string, string>): Promise<Uint8Array>;
  isAllowed(url: string): boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createHttpClient(options: HttpClientOptions = {}): HttpClient {
  const allowed = new Set(options.allowedHosts ?? DEFAULT_ALLOWED_HOSTS);
  const suffixes = options.allowedHostSuffixes ?? [];
  const timeoutMs = options.timeoutMs ?? 30_000;
  const retries = options.retries ?? 3;
  const maxBytes = options.maxBytes ?? 60 * 1024 * 1024;
  const fetchImpl = options.fetchImpl ?? fetch;
  const ua = options.userAgent ?? BROWSER_UA;

  function isAllowed(url: string): boolean {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
    const host = parsed.hostname.toLowerCase();
    return allowed.has(host) || suffixes.some((s) => host === s || host.endsWith(`.${s}`));
  }

  async function request(url: string, accept: string, headers: Record<string, string> = {}): Promise<Response> {
    if (!isAllowed(url)) throw new HostNotAllowedError(url);
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetchImpl(url, {
          headers: { "User-Agent": ua, Accept: accept, "Accept-Language": "en-US,en;q=0.9", ...headers },
          redirect: "follow",
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.url && !isAllowed(res.url)) throw new HostNotAllowedError(res.url);
        if (res.ok) return res;
        const retryable = res.status === 429 || res.status >= 500;
        lastError = new HttpError(`HTTP ${res.status} for ${url}`, url, res.status);
        if (!retryable) throw lastError;
      } catch (err) {
        if (err instanceof HostNotAllowedError) throw err;
        if (err instanceof HttpError && err.status !== null && err.status < 500 && err.status !== 429) throw err;
        lastError = err;
      }
      if (attempt < retries) await sleep(500 * 2 ** attempt + Math.random() * 250);
    }
    throw lastError instanceof Error ? lastError : new HttpError(String(lastError), url, null);
  }

  async function readCapped(res: Response, url: string): Promise<Uint8Array> {
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > maxBytes) throw new HttpError(`Response too large (${declared} bytes)`, url, res.status);
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > maxBytes) throw new HttpError(`Response too large (${buf.byteLength} bytes)`, url, res.status);
    return buf;
  }

  return {
    isAllowed,
    async getJson<T>(url: string, headers?: Record<string, string>) {
      const res = await request(url, "application/json, text/plain, */*", headers);
      const text = new TextDecoder().decode(await readCapped(res, url));
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new HttpError(`Invalid JSON from ${url}: ${text.slice(0, 120)}`, url, res.status);
      }
    },
    async getText(url: string, headers?: Record<string, string>) {
      const res = await request(url, "text/html,application/xhtml+xml,application/xml,text/plain,*/*", headers);
      return new TextDecoder().decode(await readCapped(res, url));
    },
    async getBuffer(url: string, headers?: Record<string, string>) {
      const res = await request(url, "*/*", headers);
      return readCapped(res, url);
    },
  };
}
