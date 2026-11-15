/**
 * Isolation for pipeline tests that run against the shared local database.
 *
 * Pipelines read global state (all tracked companies, every pending announcement, every alert rule,
 * every push subscription) and write fixed source names (nse_announcements, nse_bhavcopy...). Each test
 * file vi.mock()s the repository modules through these wrappers so reads only see rows carrying the
 * file's prefix and bookkeeping rows are written under a prefixed source name.
 */
import type { Sql } from "@finn/db";
import type { CategoryWeights } from "@finn/db/repositories/prefs";

export interface TestScope {
  /** Upper-case symbol prefix, e.g. "ZTDI". Must start with "ZTD". */
  symbol: string;
  /** seq_id prefix for announcements and filings, e.g. "ztdi". */
  seq: string;
  /** Prefix added to source_health / ingestion_watermarks source names. */
  source: string;
  /** alert_rules.name prefix. */
  rule: string;
  /** push_subscriptions.endpoint prefix. */
  endpoint: string;
  /** Category weights the pipelines see instead of the shared user_prefs singleton. */
  weights: CategoryWeights;
  /** saveClassification throws for these seq ids (simulates a database failure mid-processing). */
  failSave: Set<string>;
}

export const scope: TestScope = {
  symbol: "ZTD",
  seq: "ztd",
  source: "ztd_",
  rule: "ztd",
  endpoint: "https://ztd",
  weights: {},
  failSave: new Set(),
};

export function setScope(prefix: string): TestScope {
  if (!prefix.toUpperCase().startsWith("ZTD")) throw new Error(`Test prefix must start with ZTD: ${prefix}`);
  const lower = prefix.toLowerCase();
  Object.assign(scope, {
    symbol: prefix.toUpperCase(),
    seq: lower,
    source: `${lower}_`,
    rule: lower,
    endpoint: `https://${lower}.push.test/`,
    weights: {},
    failSave: new Set<string>(),
  });
  return scope;
}

const mineSymbol = (s: string) => s.toUpperCase().startsWith(scope.symbol);
const mineSeq = (s: string) => s.startsWith(scope.seq);
const src = (s: string) => `${scope.source}${s}`;
const likeSymbol = () => `${scope.symbol}%`;

type Mod<K extends string> = Record<K, (sql: Sql) => Record<string, unknown>>;

export function scopeCompanies<M extends Mod<"companiesRepo">>(mod: M): M {
  return {
    ...mod,
    companiesRepo: (sql: Sql) => {
      const r = mod.companiesRepo(sql) as ReturnType<typeof import("@finn/db/repositories/companies").companiesRepo>;
      return {
        ...r,
        listTracked: async () => (await r.listTracked()).filter((c) => mineSymbol(c.symbol)),
        listAll: async () => (await r.listAll()).filter((c) => mineSymbol(c.symbol)),
        listHoldingSymbols: async () => (await r.listHoldingSymbols()).filter(mineSymbol),
        familyMap: async () => new Map([...(await r.familyMap())].filter(([s]) => mineSymbol(s))),
      };
    },
  };
}

export function scopeAnnouncements<M extends Mod<"announcementsRepo">>(mod: M): M {
  return {
    ...mod,
    announcementsRepo: (sql: Sql) => {
      const r = mod.announcementsRepo(sql) as ReturnType<typeof import("@finn/db/repositories/announcements").announcementsRepo>;
      return {
        ...r,
        listPending: async (opts: { limit?: number; maxAttempts?: number } = {}) =>
          (await r.listPending({ ...opts, limit: 100_000 })).filter((a) => mineSeq(a.seqId)).slice(0, opts.limit ?? 300),
        listResultsAwaitingXbrl: async (sinceDays?: number) => (await r.listResultsAwaitingXbrl(sinceDays)).filter((a) => mineSymbol(a.symbol)),
        corporateActionsBetween: async (...args: Parameters<typeof r.corporateActionsBetween>) =>
          (await r.corporateActionsBetween(...args)).filter((a) => mineSymbol(a.symbol)),
        saveClassification: async (...args: Parameters<typeof r.saveClassification>) => {
          if (scope.failSave.has(args[0])) throw new Error(`simulated database failure for ${args[0]}`);
          return r.saveClassification(...args);
        },
      };
    },
  };
}

export function scopePrices<M extends Mod<"pricesRepo">>(mod: M & { AVG_VOLUME_SESSIONS: number }): M {
  return {
    ...mod,
    pricesRepo: (sql: Sql) => {
      const r = mod.pricesRepo(sql) as ReturnType<typeof import("@finn/db/repositories/prices").pricesRepo>;
      return {
        ...r,
        forSession: async (sessionDate: string) => (await r.forSession(sessionDate)).filter((p) => mineSymbol(p.symbol)),
        latestSessionDate: async () => {
          const [row] = await sql<{ d: string | null }[]>`SELECT max(session_date)::text AS d FROM prices_eod WHERE symbol LIKE ${likeSymbol()}`;
          return row?.d ?? null;
        },
        countForSession: async (sessionDate: string, source?: string) => {
          const [row] = await sql<{ n: number }[]>`
            SELECT count(*)::int AS n FROM prices_eod
            WHERE session_date = ${sessionDate} AND symbol LIKE ${likeSymbol()} ${source ? sql`AND source = ${source}` : sql``}`;
          return row?.n ?? 0;
        },
        // Same statement as the repository, restricted to this test's symbols.
        recomputeAvg20: async (opts: { from?: string } = {}) => {
          const n = mod.AVG_VOLUME_SESSIONS;
          const res = await sql`
            WITH w AS (
              SELECT symbol, session_date,
                     CASE WHEN count(volume) OVER prev20 = ${n} THEN avg(volume) OVER prev20 END AS avg20
              FROM prices_eod WHERE symbol LIKE ${likeSymbol()}
              WINDOW prev20 AS (PARTITION BY symbol ORDER BY session_date ROWS BETWEEN ${n} PRECEDING AND 1 PRECEDING)
            )
            UPDATE prices_eod p SET avg20_volume = w.avg20
            FROM w
            WHERE p.symbol = w.symbol AND p.session_date = w.session_date
              ${opts.from ? sql`AND p.session_date >= ${opts.from}` : sql``}
              AND p.avg20_volume IS DISTINCT FROM w.avg20`;
          return res.count ?? 0;
        },
      };
    },
  };
}

export function scopeAlerts<M extends Mod<"alertsRepo">>(mod: M): M {
  return {
    ...mod,
    alertsRepo: (sql: Sql) => {
      const r = mod.alertsRepo(sql) as ReturnType<typeof import("@finn/db/repositories/alerts").alertsRepo>;
      return {
        ...r,
        listRules: async (opts?: { enabledOnly?: boolean }) => {
          const { rules, invalid } = await r.listRules(opts);
          const ids = new Set((await sql<{ id: string }[]>`SELECT id FROM alert_rules WHERE name LIKE ${`${scope.rule}%`}`).map((x) => x.id));
          return { rules: rules.filter((x) => ids.has(x.id)), invalid: invalid.filter((x) => ids.has(x.id)) };
        },
      };
    },
  };
}

export function scopePush<M extends Mod<"pushRepo">>(mod: M): M {
  return {
    ...mod,
    pushRepo: (sql: Sql) => {
      const r = mod.pushRepo(sql) as ReturnType<typeof import("@finn/db/repositories/push").pushRepo>;
      return {
        ...r,
        listUndelivered: async (opts: { sinceHours?: number; maxAttempts?: number; limit?: number } = {}) =>
          (await r.listUndelivered({ ...opts, limit: 100_000 }))
            .filter((p) => mineSymbol(p.symbol) && p.endpoint.startsWith(scope.endpoint))
            .slice(0, opts.limit ?? 200),
      };
    },
  };
}

export function scopeSourceHealth<M extends Mod<"sourceHealthRepo">>(mod: M): M {
  return {
    ...mod,
    sourceHealthRepo: (sql: Sql) => {
      const r = mod.sourceHealthRepo(sql) as ReturnType<typeof import("@finn/db/repositories/sourceHealth").sourceHealthRepo>;
      return {
        ...r,
        recordSuccess: (source: string, records: number) => r.recordSuccess(src(source), records),
        recordFailure: (source: string, error: string) => r.recordFailure(src(source), error),
        get: (source: string) => r.get(src(source)),
        list: async () => (await r.list()).filter((h) => h.source.startsWith(scope.source)),
      };
    },
  };
}

export function scopeWatermarks<M extends Mod<"watermarksRepo">>(mod: M): M {
  return {
    ...mod,
    watermarksRepo: (sql: Sql) => {
      const r = mod.watermarksRepo(sql) as ReturnType<typeof import("@finn/db/repositories/watermarks").watermarksRepo>;
      return { ...r, get: (source: string) => r.get(src(source)), advance: (source: string, to: Date) => r.advance(src(source), to) };
    },
  };
}

export function scopePrefs<M extends Mod<"prefsRepo">>(mod: M): M {
  return {
    ...mod,
    prefsRepo: (sql: Sql) => ({ ...mod.prefsRepo(sql), getCategoryWeights: async () => ({ ...scope.weights }) }),
  };
}
