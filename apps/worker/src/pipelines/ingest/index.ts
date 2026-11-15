import { pickClusterHead } from "@finn/domain/cluster/clusterKey";
import { announcementsRepo, type NewAnnouncement } from "@finn/db/repositories/announcements";
import { companiesRepo } from "@finn/db/repositories/companies";
import { prefsRepo } from "@finn/db/repositories/prefs";
import { sourceHealthRepo } from "@finn/db/repositories/sourceHealth";
import { watermarksRepo } from "@finn/db/repositories/watermarks";
import { fetchAnnouncements } from "@finn/sources/nse/announcements";
import type { RawAnnouncement } from "@finn/sources/types";
import { argIsoDate, argInt } from "../../args";
import type { Command, WorkerContext } from "../../context";
import { deliverPendingPushes } from "../../notify/webPush";
import { dateRange, istDayStart, todayIst } from "../../time";
import { runCategoryAlerts } from "../alerts";
import { runResults } from "../results";
import { processAnnouncement, type ProcessedAnnouncement } from "./process";

export const ANNOUNCEMENTS_SOURCE = "nse_announcements";
export const INTEGRATED_FILINGS_SOURCE = "nse_integrated_filings";
const OVERLAP_MS = 30 * 60 * 1000;
const DEFAULT_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RESULTS_PER_RUN = 15;

export interface IngestOptions {
  /** Backfill mode: IST dates, fetched one day per request. The watermark is not moved. */
  from?: string;
  to?: string;
  maxPending?: number;
}

export interface IngestSummary {
  windows: number;
  fetched: number;
  relevant: number;
  inserted: number;
  processed: number;
  ready: number;
  failed: number;
  clusters: number;
  results: { symbol: string; periodEnd: string | null; outcome: string }[];
  alertsCreated: number;
  pushesSent: number;
  watermark: string | null;
  fetchError: string | null;
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

function toNew(a: RawAnnouncement): NewAnnouncement {
  return {
    seqId: a.seqId,
    symbol: a.symbol.toUpperCase(),
    subject: a.subject,
    headline: (a.text || a.subject || "(no text)").trim(),
    bodyText: a.exchangeSummary,
    pdfUrl: a.attachmentUrl,
    publishedAt: a.publishedAt,
    raw: a.raw,
  };
}

export async function runIngest(ctx: WorkerContext, opts: IngestOptions = {}): Promise<IngestSummary> {
  const announcements = announcementsRepo(ctx.sql);
  const health = sourceHealthRepo(ctx.sql);
  const watermarks = watermarksRepo(ctx.sql);
  const summary: IngestSummary = {
    windows: 0,
    fetched: 0,
    relevant: 0,
    inserted: 0,
    processed: 0,
    ready: 0,
    failed: 0,
    clusters: 0,
    results: [],
    alertsCreated: 0,
    pushesSent: 0,
    watermark: null,
    fetchError: null,
  };

  // 1. Fetch: one market-wide call per window, filtered to tracked companies, upserted on seq_id.
  const tracked = new Set((await companiesRepo(ctx.sql).listTracked()).map((c) => c.symbol));
  const backfill = Boolean(opts.from);
  const now = new Date();
  const windows = backfill
    ? dateRange(opts.from!, opts.to ?? todayIst(now)).map((d) => ({ from: istDayStart(d), to: new Date(istDayStart(d).getTime() + DAY_MS - 1000) }))
    : await (async () => {
        const wm = await watermarks.get(ANNOUNCEMENTS_SOURCE);
        return [{ from: wm ? new Date(wm.getTime() - OVERLAP_MS) : new Date(now.getTime() - DEFAULT_LOOKBACK_MS), to: now }];
      })();

  try {
    for (const w of windows) {
      const rows = await fetchAnnouncements(ctx.http, {
        from: w.from,
        to: w.to,
        onInvalidRow: (e) => ctx.log.warn({ error: e.message }, "Skipping malformed announcement row"),
      });
      const relevant = rows.filter((r) => tracked.has(r.symbol.toUpperCase()));
      const inserted = await announcements.upsertRaw(relevant.map(toNew));
      summary.windows++;
      summary.fetched += rows.length;
      summary.relevant += relevant.length;
      summary.inserted += inserted.length;
      ctx.log.info({ from: w.from.toISOString(), to: w.to.toISOString(), fetched: rows.length, relevant: relevant.length, inserted: inserted.length }, "Announcements window saved");
    }
    await health.recordSuccess(ANNOUNCEMENTS_SOURCE, summary.relevant);
    if (!backfill) summary.watermark = (await watermarks.advance(ANNOUNCEMENTS_SOURCE, now)).toISOString();
  } catch (err) {
    summary.fetchError = errorMessage(err);
    const failures = await health.recordFailure(ANNOUNCEMENTS_SOURCE, summary.fetchError);
    ctx.log.error({ error: summary.fetchError, consecutiveFailures: failures }, "Announcements fetch failed; watermark not advanced");
  }

  // 2. Process the queue (new rows plus retries left over from earlier runs).
  const weights = await prefsRepo(ctx.sql).getCategoryWeights();
  const pending = await announcements.listPending({ limit: opts.maxPending ?? 300 });
  const processed: ProcessedAnnouncement[] = [];
  for (const row of pending) {
    try {
      const p = await processAnnouncement(ctx, announcements, row, weights);
      processed.push(p);
      if (p.status === "ready") summary.ready++;
      else summary.failed++;
    } catch (err) {
      summary.failed++;
      await announcements.markFailed(row.seqId, errorMessage(err), true);
      ctx.log.error({ seqId: row.seqId, error: errorMessage(err) }, "Announcement processing failed");
    }
  }
  summary.processed = processed.length;

  const touched = new Set<string>();
  for (const p of processed) {
    touched.add(p.clusterKey);
    if (p.previousClusterKey) touched.add(p.previousClusterKey);
  }
  for (const key of touched) {
    const head = pickClusterHead(await announcements.listClusterMembers(key));
    if (head) await announcements.setClusterHead(key, head.seqId);
  }
  summary.clusters = touched.size;

  const targets = new Map<string, { symbol: string; periodEnd: string }>();
  for (const p of processed) if (p.category === "results" && p.periodEnd) targets.set(p.clusterKey, { symbol: p.symbol, periodEnd: p.periodEnd });
  for (const r of await announcements.listResultsAwaitingXbrl()) {
    const periodEnd = r.clusterKey.split(":")[2];
    if (periodEnd && !targets.has(r.clusterKey)) targets.set(r.clusterKey, { symbol: r.symbol, periodEnd });
  }
  let resultsFailed = 0;
  for (const t of [...targets.values()].slice(0, MAX_RESULTS_PER_RUN)) {
    try {
      const res = await runResults(ctx, { symbol: t.symbol, period: t.periodEnd });
      summary.results.push({ symbol: t.symbol, periodEnd: t.periodEnd, outcome: res.outcome });
    } catch (err) {
      resultsFailed++;
      summary.results.push({ symbol: t.symbol, periodEnd: t.periodEnd, outcome: `error: ${errorMessage(err)}` });
      ctx.log.warn({ ...t, error: errorMessage(err) }, "Results card failed; will retry next run");
    }
  }
  if (targets.size > 0) {
    if (resultsFailed === 0) await health.recordSuccess(INTEGRATED_FILINGS_SOURCE, targets.size);
    else await health.recordFailure(INTEGRATED_FILINGS_SOURCE, `${resultsFailed}/${targets.size} results lookups failed`);
  }

  // 5. Category alerts (deduped per cluster) and push.
  summary.alertsCreated = await runCategoryAlerts(
    ctx,
    processed
      .filter((p) => p.status === "ready")
      .map((p) => ({ seqId: p.seqId, symbol: p.symbol, category: p.category, headline: p.headline, oneLiner: p.oneLiner, publishedAt: p.publishedAt, clusterKey: p.clusterKey })),
  );
  summary.pushesSent = (await deliverPendingPushes(ctx)).sent;

  return summary;
}

export const ingestCommand: Command = {
  name: "ingest",
  description: "Poll NSE announcements since the watermark (or --from/--to YYYY-MM-DD backfill), classify, score, cluster, enrich",
  async run(ctx, args) {
    const from = argIsoDate(args, "from");
    const to = argIsoDate(args, "to");
    const summary = await runIngest(ctx, { from, to: from ? to : undefined, maxPending: argInt(args, "max-pending", 300) });
    ctx.log.info(summary, "Ingest finished");
    if (summary.fetchError) throw new Error(`Announcements fetch failed: ${summary.fetchError}`);
  },
};
