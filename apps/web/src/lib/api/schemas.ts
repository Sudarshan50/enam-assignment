/**
 * Response shapes the web app needs that @finn/shared does not (yet) define. Each one is
 * deliberately tolerant (array or `{ items }` envelopes) so the client keeps working
 * whichever envelope the API settles on.
 */
import { z } from "zod";
import {
  AlertRuleDefinitionSchema,
  AlertRuleSchema,
  AlertSchema,
  EngineStatsSchema,
  HoldingSchema,
  PreviewAlertRuleResponseSchema,
  ResearchRunSchema,
  RunStatusSchema,
  SourceHealthSchema,
  StatementFamilySchema,
} from "@finn/shared";

/** Accepts `[...]` or `{ [key]: [...] }` and always yields the array. */
export function listOf<T extends z.ZodType>(item: T, key: string) {
  return z.union([z.array(item), z.object({ [key]: z.array(item) }).loose()]).transform((value) =>
    Array.isArray(value) ? value : ((value as Record<string, unknown>)[key] as z.output<T>[]),
  );
}

export const HoldingsResponseSchema = listOf(HoldingSchema, "holdings");
export const AlertsResponseSchema = listOf(AlertSchema, "alerts");
export const AlertRulesResponseSchema = listOf(AlertRuleSchema, "rules");

export const CompanySearchResultSchema = z
  .object({
    symbol: z.string(),
    name: z.string(),
    statementFamily: StatementFamilySchema.nullable().optional(),
    inPortfolio: z.boolean().optional(),
    isHolding: z.boolean().optional(),
    researchReady: z.boolean().optional(),
  })
  .loose()
  .transform(({ isHolding, ...rest }) => ({ ...rest, inPortfolio: rest.inPortfolio ?? isHolding }));
export type CompanySearchResult = z.output<typeof CompanySearchResultSchema>;
export const CompanySearchResponseSchema = listOf(CompanySearchResultSchema, "results");

export const StartRunResponseSchema = z.object({
  runId: z.string(),
  status: RunStatusSchema,
  cached: z.boolean().optional(),
});
export type StartRunResponse = z.infer<typeof StartRunResponseSchema>;

/** GET /companies/:symbol/research — `{ run }` envelope, a bare run, or null when never researched. */
export const SymbolResearchResponseSchema = z
  .union([z.object({ run: ResearchRunSchema.nullable() }).loose(), ResearchRunSchema, z.null()])
  .transform((value) => {
    if (value === null) return { run: null };
    // The API envelope also carries `symbol`/`modules`; a bare run never has a `run` key.
    if ("run" in value) return { run: value.run as z.infer<typeof ResearchRunSchema> | null };
    return { run: value as z.infer<typeof ResearchRunSchema> };
  });

const BacktestHitSchema = z.object({ date: z.string(), symbol: z.string(), detail: z.string() });

/** Per-session `hits`, or the API's per-symbol `bySymbol` summary (mapped onto each symbol's last fire). */
export const BacktestSchema = z
  .object({
    fires: z.number().int(),
    sessions: z.number().int(),
    hits: z.array(BacktestHitSchema).optional(),
    bySymbol: z.array(z.object({ symbol: z.string(), fires: z.number().int(), lastFiredOn: z.string().nullable() })).optional(),
    note: z.string().nullable().optional(),
  })
  .transform(({ fires, sessions, hits, bySymbol, note }) => ({
    fires,
    sessions,
    note: note ?? null,
    hits:
      hits ??
      (bySymbol ?? []).flatMap((s) =>
        s.lastFiredOn && s.fires > 0 ? [{ date: s.lastFiredOn, symbol: s.symbol, detail: s.fires === 1 ? "fired once" : `fired ${s.fires}× · last` }] : [],
      ),
  }));
export type Backtest = z.output<typeof BacktestSchema>;

export const RulePreviewSchema = PreviewAlertRuleResponseSchema.extend({
  name: z.string().optional(),
  backtest: BacktestSchema.nullable().optional(),
});
export type RulePreview = z.output<typeof RulePreviewSchema>;

export const CreateRuleInputSchema = z.object({ name: z.string().min(1).max(80), definition: AlertRuleDefinitionSchema });

export const EngineResponseSchema = EngineStatsSchema.extend({
  sourceHealth: z.array(SourceHealthSchema).optional(),
  asOf: z.string().optional(),
});
export type EngineResponse = z.infer<typeof EngineResponseSchema>;

/** Yields the key, or null when the server has push turned off (`{ enabled: false, publicKey: null }`). */
export const VapidKeyResponseSchema = z
  .union([z.object({ enabled: z.boolean().optional(), publicKey: z.string().nullable() }), z.object({ key: z.string() })])
  .transform((value) => ("key" in value ? value.key : value.enabled === false ? null : value.publicKey));

export const PrefsSchema = z
  .object({
    defaultWindow: z.enum(["24h", "3d", "7d"]).optional(),
    mutedCategories: z.array(z.string()).optional(),
    categoryWeights: z.record(z.string(), z.number()).optional(),
  })
  .loose();
export type Prefs = z.infer<typeof PrefsSchema>;

export const FinancialsResponseSchema = z.unknown();
