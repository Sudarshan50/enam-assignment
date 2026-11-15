import type { AlertRuleDefinition } from "@finn/shared";
import type { Backtest } from "../contracts";
import { round } from "../lib/numbers";
import type { PricePoint } from "./holdingsService";
import { volumeVsAverage } from "./holdingsService";

export const BACKTEST_SESSIONS = 30;

type PriceRule = Extract<AlertRuleDefinition, { type: "price_move" | "volume_spike" }>;

/**
 * Replays a price or volume rule over the last 30 sessions of each symbol's EOD series (oldest first).
 * Price moves on days with a bonus/split filing are suppressed, as the live engine does.
 */
export function backtestPriceRule(
  rule: PriceRule,
  series: Map<string, PricePoint[]>,
  suppressed: Map<string, Set<string>> = new Map(),
): Backtest {
  let sessions = 0;
  const bySymbol: Backtest["bySymbol"] = [];
  for (const [symbol, points] of series) {
    const start = Math.max(0, points.length - BACKTEST_SESSIONS);
    sessions = Math.max(sessions, points.length - start);
    let fires = 0;
    let lastFiredOn: string | null = null;
    for (let i = start; i < points.length; i++) {
      const p = points[i]!;
      let fired = false;
      if (rule.type === "price_move") {
        const prev = p.prevClose ?? points[i - 1]?.close ?? null;
        if (!prev || suppressed.get(symbol)?.has(p.sessionDate)) continue;
        // Compared as displayed (2 dp) so an exact 5.00% move meets a 5% threshold despite float error.
        const movePct = round((p.close / prev - 1) * 100, 2);
        fired =
          rule.direction === "up"
            ? movePct >= rule.thresholdPct
            : rule.direction === "down"
              ? -movePct >= rule.thresholdPct
              : Math.abs(movePct) >= rule.thresholdPct;
      } else {
        const ratio = volumeVsAverage(points, i);
        fired = ratio !== null && round(ratio, 2) >= rule.multiple;
      }
      if (fired) {
        fires++;
        lastFiredOn = p.sessionDate;
      }
    }
    if (fires > 0) bySymbol.push({ symbol, fires, lastFiredOn });
  }
  bySymbol.sort((a, b) => b.fires - a.fires || a.symbol.localeCompare(b.symbol));
  const fires = bySymbol.reduce((s, b) => s + b.fires, 0);
  const note = sessions === 0 ? "No price history yet, so there is nothing to replay." : null;
  return { sessions, fires, bySymbol, note };
}

export function describeBacktest(b: Backtest): string {
  if (b.sessions === 0) return b.note ?? "No history to replay yet.";
  const span = `in the last ${b.sessions} session${b.sessions === 1 ? "" : "s"}`;
  if (b.fires === 0) return `It would not have fired ${span}.`;
  const top = b.bySymbol
    .slice(0, 3)
    .map((s) => (s.fires > 1 ? `${s.symbol} ×${s.fires}` : s.symbol))
    .join(", ");
  return `It would have fired ${b.fires} time${b.fires === 1 ? "" : "s"} ${span} (${top}${b.bySymbol.length > 3 ? ", …" : ""}).`;
}
