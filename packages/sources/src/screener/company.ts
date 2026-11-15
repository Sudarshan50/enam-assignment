import { parse } from "node-html-parser";
import type { HttpClient } from "../http/client";
import { createThrottle, type Throttle } from "../http/throttle";
import type { ScreenerCompany } from "../types";
import { parseScreenerDocuments, SCREENER_BASE } from "./documents";
import { parseScreenerHistory } from "./history";

export function parseScreenerCompany(
  html: string,
  symbol: string,
  basis: ScreenerCompany["basis"],
  fetchedAt: Date = new Date(),
): ScreenerCompany {
  const root = parse(html);
  return {
    symbol,
    basis,
    documents: parseScreenerDocuments(root, fetchedAt),
    history: parseScreenerHistory(root),
    fetchedAt,
  };
}

/** Screener serves an empty consolidated page for companies without subsidiaries. */
export function hasHistoryData(company: ScreenerCompany): boolean {
  return company.history.some(
    (t) => (t.statement === "quarters" || t.statement === "profit_loss") && t.rows.some((r) => r.values.some((v) => v !== null)),
  );
}

export function screenerCompanyUrl(symbol: string, basis: ScreenerCompany["basis"]): string {
  const slug = encodeURIComponent(symbol.trim().toUpperCase());
  return basis === "consolidated" ? `${SCREENER_BASE}/company/${slug}/consolidated/` : `${SCREENER_BASE}/company/${slug}/`;
}

export interface ScreenerClientOptions {
  /** Screener is a secondary source; keep well under its rate limits. */
  minIntervalMs?: number;
  throttle?: Throttle;
  now?: () => Date;
}

export interface ScreenerClient {
  fetchCompany(symbol: string): Promise<ScreenerCompany>;
}

/** Reuse one client across symbols so the throttle spaces out every request it makes. */
export function createScreenerClient(http: HttpClient, options: ScreenerClientOptions = {}): ScreenerClient {
  const throttle = options.throttle ?? createThrottle({ minIntervalMs: options.minIntervalMs ?? 3_000 });
  const now = options.now ?? (() => new Date());

  async function load(symbol: string, basis: ScreenerCompany["basis"]): Promise<ScreenerCompany> {
    await throttle.wait();
    const html = await http.getText(screenerCompanyUrl(symbol, basis));
    return parseScreenerCompany(html, symbol, basis, now());
  }

  return {
    async fetchCompany(symbol) {
      const consolidated = await load(symbol, "consolidated");
      if (hasHistoryData(consolidated)) return consolidated;
      return load(symbol, "standalone");
    },
  };
}

export function fetchScreenerCompany(http: HttpClient, symbol: string, options?: ScreenerClientOptions): Promise<ScreenerCompany> {
  return createScreenerClient(http, options).fetchCompany(symbol);
}
