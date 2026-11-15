import { z } from "zod";
import {
  CategorySchema,
  DigestItemSchema,
  EngineStatsSchema,
  PreviewAlertRuleResponseSchema,
  PromiseLedgerPayloadSchema,
  PromiseSchema,
  ResearchModuleSchema,
  ResearchRunSchema,
  RunStatusSchema,
  SourceHealthSchema,
  StatementFamilySchema,
  USER_WEIGHT_RANGE,
} from "@finn/shared";

/**
 * Request/response shapes the shared package does not define. Everything else the API returns
 * is a shared schema verbatim (DigestResponseSchema, HoldingSchema, ResearchRunSchema, ...).
 */

export const SymbolSchema = z.string().trim().toUpperCase().regex(/^[A-Z0-9&\-]{1,20}$/, "Not a valid NSE symbol");
export const SymbolParamSchema = z.object({ symbol: SymbolSchema });
export const SeqIdParamSchema = z.object({ seqId: z.string().trim().min(1).max(64) });
export const UuidParamSchema = z.object({ id: z.uuid() });

export const OkSchema = z.object({ ok: z.literal(true) });

export const HealthSchema = z.object({
  ok: z.boolean(),
  db: z.enum(["up", "down"]),
  latencyMs: z.number().nullable(),
  uptimeS: z.number(),
});
export type Health = z.infer<typeof HealthSchema>;

export const SessionRequestSchema = z.object({ token: z.string().min(1).max(256) });

export const INTERACTION_ACTIONS = ["open", "dismiss", "undo_dismiss", "pin"] as const;
export const InteractionActionSchema = z.enum(INTERACTION_ACTIONS);
export type InteractionAction = z.infer<typeof InteractionActionSchema>;
export const InteractionRequestSchema = z.object({ seqId: z.string().trim().min(1).max(64), action: InteractionActionSchema });
export const InteractionResponseSchema = z.object({
  ok: z.literal(true),
  category: CategorySchema.nullable(),
  weight: z.number().nullable(),
});
export type InteractionResponse = z.infer<typeof InteractionResponseSchema>;

export const AnnouncementDetailSchema = DigestItemSchema.extend({
  bodyText: z.string().nullable(),
  parentId: z.string().nullable(),
  status: z.string(),
  dismissed: z.boolean(),
});
export type AnnouncementDetail = z.infer<typeof AnnouncementDetailSchema>;

export const CompanySearchQuerySchema = z.object({ q: z.string().trim().min(1).max(40) });
export const CompanySearchResultSchema = z.object({
  symbol: z.string(),
  name: z.string(),
  statementFamily: StatementFamilySchema.nullable(),
  isHolding: z.boolean(),
});
export type CompanySearchResult = z.infer<typeof CompanySearchResultSchema>;

const BasisSchema = z.enum(["consolidated", "standalone"]);
export const FinancialQuarterSchema = z.object({
  seqId: z.string(),
  periodEnd: z.string(),
  periodLabel: z.string(),
  basis: BasisSchema,
  statementFamily: StatementFamilySchema,
  audited: z.boolean(),
  status: z.string(),
  broadcastAt: z.string().nullable(),
  xbrlUrl: z.string(),
  /** Absolute rupees for the quarter (XBRL OneD context), keyed by XBRL concept. */
  quarter: z.record(z.string(), z.number()),
  /** Year-to-date (FourD). Never summed with `quarter`. */
  yearToDate: z.record(z.string(), z.number()),
  derived: z.array(z.string()),
  source: z.literal("nse_xbrl"),
  sourceLabel: z.string(),
});
export const FinancialHistorySchema = z.object({
  statement: z.string(),
  basis: BasisSchema,
  periods: z.array(z.string()),
  rows: z.unknown(),
  unit: z.string(),
  source: z.string(),
  sourceLabel: z.string(),
  fetchedAt: z.string(),
});
export const FinancialsResponseSchema = z.object({
  symbol: z.string(),
  name: z.string(),
  statementFamily: StatementFamilySchema.nullable(),
  basis: BasisSchema.nullable(),
  quarters: z.array(FinancialQuarterSchema),
  history: z.array(FinancialHistorySchema),
});
export type FinancialsResponse = z.infer<typeof FinancialsResponseSchema>;

export const CreateResearchRunResponseSchema = z.object({ runId: z.string(), status: RunStatusSchema, cached: z.boolean() });
export type CreateResearchRunResponse = z.infer<typeof CreateResearchRunResponseSchema>;

export const PromiseLedgerSchema = z.object({ summary: PromiseLedgerPayloadSchema.shape.summary, promises: z.array(PromiseSchema) });
export type PromiseLedger = z.infer<typeof PromiseLedgerSchema>;
export const CompanyResearchSchema = z.object({
  symbol: z.string(),
  companyName: z.string(),
  run: ResearchRunSchema.nullable(),
  modules: z.array(ResearchModuleSchema),
  promiseLedger: PromiseLedgerSchema.nullable(),
});
export type CompanyResearch = z.infer<typeof CompanyResearchSchema>;

export const EventsQuerySchema = z.object({ lastEventId: z.coerce.number().int().min(0).optional() });

export const UpdateAlertRuleSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    enabled: z.boolean().optional(),
    /** price_move: thresholdPct; volume_spike: multiple. */
    threshold: z.number().positive().optional(),
  })
  .refine((v) => v.name !== undefined || v.enabled !== undefined || v.threshold !== undefined, { message: "Nothing to update" });
export type UpdateAlertRule = z.infer<typeof UpdateAlertRuleSchema>;

export const BacktestSchema = z.object({
  sessions: z.number().int(),
  fires: z.number().int(),
  bySymbol: z.array(z.object({ symbol: z.string(), fires: z.number().int(), lastFiredOn: z.string().nullable() })),
  note: z.string().nullable(),
});
export type Backtest = z.infer<typeof BacktestSchema>;
export const PreviewResponseSchema = PreviewAlertRuleResponseSchema.extend({ backtest: BacktestSchema.nullable() });
export type PreviewResponse = z.infer<typeof PreviewResponseSchema>;

export const AlertsQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30) });

export const VapidKeyResponseSchema = z.object({ enabled: z.boolean(), publicKey: z.string().nullable() });
export const DeletePushSubscriptionSchema = z.object({ endpoint: z.url() });
export const PushTestResponseSchema = z.object({ sent: z.number().int(), failed: z.number().int(), pruned: z.number().int() });

export const WINDOWS = ["24h", "3d", "7d"] as const;
const Hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM (24h)");
export const QuietHoursSchema = z.object({ enabled: z.boolean(), start: Hhmm, end: Hhmm });
export const CategoryWeightsSchema = z.partialRecord(CategorySchema, z.number().min(USER_WEIGHT_RANGE.min).max(USER_WEIGHT_RANGE.max));
export const PrefsSchema = z.object({
  categoryWeights: CategoryWeightsSchema,
  defaultWindow: z.enum(WINDOWS),
  quietHours: QuietHoursSchema.nullable(),
  updatedAt: z.string(),
});
export type Prefs = z.infer<typeof PrefsSchema>;
export const UpdatePrefsSchema = z
  .object({
    categoryWeights: CategoryWeightsSchema.optional(),
    defaultWindow: z.enum(WINDOWS).optional(),
    quietHours: QuietHoursSchema.nullable().optional(),
  })
  .refine((v) => v.categoryWeights !== undefined || v.defaultWindow !== undefined || v.quietHours !== undefined, {
    message: "Nothing to update",
  });
export type UpdatePrefs = z.infer<typeof UpdatePrefsSchema>;

export const EngineResponseSchema = EngineStatsSchema.extend({
  llm7d: z.object({ calls: z.number(), promptTokens: z.number(), completionTokens: z.number(), cacheHits: z.number() }),
  announcements: z.object({ processedToday: z.number(), processed7d: z.number(), ready: z.number(), pending: z.number(), failed: z.number() }),
  sourceHealth: z.array(SourceHealthSchema),
  lastIngestAt: z.string().nullable(),
  asOf: z.string(),
});
export type EngineResponse = z.infer<typeof EngineResponseSchema>;

export const JobNameParamSchema = z.object({ name: z.string().regex(/^[a-z0-9-]{1,40}$/) });
export const JobResultSchema = z.object({ job: z.string(), ok: z.boolean(), result: z.record(z.string(), z.unknown()) });
export const JobListSchema = z.array(z.object({ name: z.string(), description: z.string() }));
