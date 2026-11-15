import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { createHttpClient, type HttpClient } from "@finn/sources/http/client";

/** Exchange archives where filings live; company IR hosts are added per run from screener's own links. */
export const DOCUMENT_HOST_SUFFIXES = ["nseindia.com", "nseindia.in", "bseindia.com"];

const MAX_PDF_BYTES = 60 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 120_000;

export class UnsafeUrlError extends Error {
  constructor(url: string, reason: string) {
    super(`Refusing to download ${url}: ${reason}`);
    this.name = "UnsafeUrlError";
  }
}

/** Rejects non-HTTPS-ish schemes, IP literals and local names before any request (SSRF guard). */
export function assertSafeUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UnsafeUrlError(url, "not a URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new UnsafeUrlError(url, "scheme not allowed");
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(host)) throw new UnsafeUrlError(url, "IP-literal hosts are not allowed");
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") || !host.includes(".")) throw new UnsafeUrlError(url, "local host");
  return parsed;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** HTTP client for PDF downloads, allowing exchange archives plus the exact IR hosts screener links to. */
export function createDocumentDownloader(urls: string[]): HttpClient {
  const suffixes = new Set(DOCUMENT_HOST_SUFFIXES);
  for (const u of urls) {
    const h = hostOf(u);
    if (h && !isIP(h)) suffixes.add(h);
  }
  return createHttpClient({ allowedHostSuffixes: [...suffixes], timeoutMs: DOWNLOAD_TIMEOUT_MS, maxBytes: MAX_PDF_BYTES, retries: 2 });
}

/**
 * BSE's AnnPdfOpen.aspx answers some requests with a redirect whose headers Node's strict HTTP parser
 * rejects ("fetch failed"). The file itself lives at a predictable archive path, so those are tried next.
 */
export function downloadCandidates(url: string): string[] {
  const parsed = new URL(url);
  if (!parsed.hostname.endsWith("bseindia.com") || !/\/annpdfopen\.aspx$/i.test(parsed.pathname)) return [url];
  const name = parsed.searchParams.get("Pname");
  if (!name || !/^[\w.-]+\.pdf$/i.test(name)) return [url];
  return [url, ...["AttachLive", "AttachHis"].map((dir) => `https://www.bseindia.com/xml-data/corpfiling/${dir}/${name}`)];
}

export async function downloadPdf(http: HttpClient, url: string): Promise<{ bytes: Uint8Array; sha256: string }> {
  const parsed = assertSafeUrl(url);
  const referer = parsed.hostname.endsWith("bseindia.com") ? { Referer: "https://www.bseindia.com/" } : undefined;
  let firstError: unknown;
  for (const candidate of downloadCandidates(url)) {
    try {
      const bytes = await http.getBuffer(candidate, referer);
      const head = new TextDecoder().decode(bytes.slice(0, 5));
      if (head !== "%PDF-") throw new Error(`Not a PDF (starts with ${JSON.stringify(head)})`);
      return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
    } catch (err) {
      firstError ??= err;
    }
  }
  throw firstError;
}
