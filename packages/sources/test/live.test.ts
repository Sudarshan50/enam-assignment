import { describe, expect, it } from "vitest";
import { createHttpClient } from "../src/http/client";
import { fetchAnnouncements } from "../src/nse/announcements";
import { fetchBhavcopy } from "../src/nse/bhavcopy";
import { listIntegratedFilings, selectFilingsForCard, latestPeriodEnd } from "../src/nse/integratedFilings";

/** Opt-in smoke test against the real endpoints: LIVE=1 npx vitest run packages/sources/test/live.test.ts */
describe.skipIf(process.env.LIVE !== "1")("live NSE smoke", () => {
  const http = createHttpClient({ retries: 1, timeoutMs: 20_000 });

  it("fetches the market-wide announcements feed", async () => {
    const to = new Date();
    const from = new Date(to.getTime() - 3 * 24 * 3600 * 1000);
    const rows = await fetchAnnouncements(http, { from, to });
    expect(rows.length).toBeGreaterThan(0);
  }, 30_000);

  it("lists integrated filings and selects a card set for TCS", async () => {
    const refs = await listIntegratedFilings(http, "TCS");
    const latest = latestPeriodEnd(refs);
    expect(latest).not.toBeNull();
    expect(selectFilingsForCard(refs, latest!).current).not.toBeNull();
  }, 30_000);

  it("finds a bhavcopy within the last week", async () => {
    let found = null;
    for (let back = 0; back < 7 && !found; back++) {
      found = await fetchBhavcopy(http, new Date(Date.now() - back * 24 * 3600 * 1000));
    }
    expect(found?.some((r) => r.symbol === "RELIANCE")).toBe(true);
  }, 60_000);
});
