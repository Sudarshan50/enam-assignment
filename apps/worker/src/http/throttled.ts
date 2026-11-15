import type { HttpClient } from "@finn/sources/http/client";
import { createThrottle } from "@finn/sources/http/throttle";

export interface ThrottledHttpOptions {
  minIntervalMs: number;
  /** Only hosts matching this predicate are throttled (NSE); others pass straight through. */
  shouldThrottle: (host: string) => boolean;
}

export const isNseHost = (host: string) => /(^|\.)nseindia\.(com|in)$/i.test(host);

/** Spaces out calls to rate-sensitive hosts. Retries stay inside the wrapped client. */
export function throttleHttp(inner: HttpClient, options: ThrottledHttpOptions): HttpClient {
  const throttle = createThrottle({ minIntervalMs: options.minIntervalMs });
  const gate = async (url: string) => {
    let host = "";
    try {
      host = new URL(url).hostname;
    } catch {
      return;
    }
    if (options.shouldThrottle(host)) await throttle.wait();
  };
  return {
    isAllowed: (url) => inner.isAllowed(url),
    async getJson<T>(url: string, headers?: Record<string, string>) {
      await gate(url);
      return inner.getJson<T>(url, headers);
    },
    async getText(url, headers) {
      await gate(url);
      return inner.getText(url, headers);
    },
    async getBuffer(url, headers) {
      await gate(url);
      return inner.getBuffer(url, headers);
    },
  };
}
