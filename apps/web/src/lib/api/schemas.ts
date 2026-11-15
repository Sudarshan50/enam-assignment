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
    researchReady: z.boolean().optional(),
  })
  .loose();
export type CompanySearchResult = z.infer<typeof CompanySearchResultSchema>;
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
    if ("run" in value && !("symbol" in value)) return { run: value.run };
    return { run: value as z.infer<typeof ResearchRunSchema> };
  });

export const BacktestSchema = z.object({
  fires: z.number().int(),
  sessions: z.number().int(),
  hits: z.array(z.object({ date: z.string(), symbol: z.string(), detail: z.string() })).default([]),
});
export type Backtest = z.infer<typeof BacktestSchema>;

export const RulePreviewSchema = PreviewAlertRuleResponseSchema.extend({
  name: z.string().optional(),
  backtest: BacktestSchema.nullable().optional(),
});
export type RulePreview = z.infer<typeof RulePreviewSchema>;

export const CreateRuleInputSchema = z.object({ name: z.string().min(1).max(80), definition: AlertRuleDefinitionSchema });

export const EngineResponseSchema = EngineStatsSchema.extend({
  sourceHealth: z.array(SourceHealthSchema).optional(),
  asOf: z.string().optional(),
});
export type EngineResponse = z.infer<typeof EngineResponseSchema>;

export const VapidKeyResponseSchema = z
  .union([z.object({ publicKey: z.string() }), z.object({ key: z.string() })])
  .transform((value) => ("publicKey" in value ? value.publicKey : value.key));

export const PrefsSchema = z
  .object({
    defaultWindow: z.enum(["24h", "3d", "7d"]).optional(),
    mutedCategories: z.array(z.string()).optional(),
    categoryWeights: z.record(z.string(), z.number()).optional(),
  })
  .loose();
export type Prefs = z.infer<typeof PrefsSchema>;

export const FinancialsResponseSchema = z.unknown();
