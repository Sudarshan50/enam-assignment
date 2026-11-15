import { z } from "zod";

export const CitationSchema = z.object({
  chunkId: z.string(),
  documentId: z.string(),
  documentLabel: z.string(),
  page: z.number().int().nullable(),
  quote: z.string(),
  url: z.string().nullable(),
});
export type Citation = z.infer<typeof CitationSchema>;

export const ClaimSchema = z.object({
  text: z.string(),
  citations: z.array(CitationSchema),
  grounded: z.boolean(),
});
export type Claim = z.infer<typeof ClaimSchema>;

export const MODULE_KEYS = ["promise_ledger", "financial_snapshot", "cash_quality", "bull_bear", "business_snapshot"] as const;
export const ModuleKeySchema = z.enum(MODULE_KEYS);
export type ModuleKey = z.infer<typeof ModuleKeySchema>;

export const MODULE_STATUSES = ["pending", "running", "done", "failed", "insufficient_sources"] as const;
export const ModuleStatusSchema = z.enum(MODULE_STATUSES);

export const GUIDANCE_METRICS = [
  "revenue_growth",
  "ebitda_margin",
  "pat_growth",
  "capex",
  "order_book",
  "volume_growth",
  "net_debt",
] as const;
export const GuidanceMetricSchema = z.enum(GUIDANCE_METRICS);
export type GuidanceMetric = z.infer<typeof GuidanceMetricSchema>;

export const VERDICTS = ["delivered", "missed", "pending", "quietly_dropped", "not_scored"] as const;
export const VerdictSchema = z.enum(VERDICTS);
export type Verdict = z.infer<typeof VerdictSchema>;

export const PromiseSchema = z.object({
  id: z.string(),
  metric: GuidanceMetricSchema,
  statementType: z.enum(["explicit_guidance", "target", "aspiration"]),
  low: z.number().nullable(),
  high: z.number().nullable(),
  unit: z.enum(["pct", "inr_crore", "x"]),
  horizonLabel: z.string(),
  horizonEnd: z.string().nullable(),
  saidIn: z.string(),
  speaker: z.string().nullable(),
  quote: z.string(),
  citation: CitationSchema,
  actual: z.number().nullable(),
  actualPeriod: z.string().nullable(),
  actualSource: z.string().nullable(),
  verdict: VerdictSchema,
  explanation: z.string(),
});
export type PromiseItem = z.infer<typeof PromiseSchema>;

export const PromiseLedgerPayloadSchema = z.object({
  summary: z.object({ elapsed: z.number(), delivered: z.number(), missed: z.number(), pending: z.number(), quietlyDropped: z.number() }),
  promises: z.array(PromiseSchema),
  transcriptsUsed: z.array(z.string()),
  /** Calls whose guidance could not be read this run; absent when every call was read. */
  transcriptsUnread: z.array(z.string()).optional(),
});

export const FinancialSeriesPointSchema = z.object({ period: z.string(), value: z.number().nullable() });
export const FinancialSnapshotPayloadSchema = z.object({
  headline: z.array(z.object({ label: z.string(), value: z.number().nullable(), unit: z.string(), period: z.string(), source: z.string() })),
  series: z.array(z.object({ key: z.string(), label: z.string(), unit: z.string(), source: z.string(), points: z.array(FinancialSeriesPointSchema) })),
  takeaways: z.array(ClaimSchema),
});

export const CashQualityPayloadSchema = z.object({
  periods: z.array(
    z.object({
      period: z.string(),
      cfo: z.number().nullable(),
      pat: z.number().nullable(),
      cashConversion: z.number().nullable(),
      capex: z.number().nullable(),
      fcf: z.number().nullable(),
      debtToEquity: z.number().nullable(),
      note: z.string().nullable(),
    }),
  ),
  takeaways: z.array(ClaimSchema),
});

export const BullBearPayloadSchema = z.object({ bull: z.array(ClaimSchema), bear: z.array(ClaimSchema) });

export const BusinessSnapshotPayloadSchema = z.object({
  description: ClaimSchema.nullable(),
  segments: z.array(z.object({ name: z.string(), sharePct: z.number().nullable(), claim: ClaimSchema })),
});

/** An automatic retry of a module that failed or came back incomplete; dead means it gave up. */
export const ModuleRetrySchema = z.object({
  status: z.enum(["pending", "dead"]),
  attempts: z.number().int().nonnegative(),
  nextAttemptAt: z.string().nullable(),
});
export type ModuleRetry = z.infer<typeof ModuleRetrySchema>;

export const ResearchModuleSchema = z.object({
  key: ModuleKeySchema,
  status: ModuleStatusSchema,
  payload: z.unknown().nullable(),
  error: z.string().nullable(),
  updatedAt: z.string(),
  retry: ModuleRetrySchema.optional(),
});
export type ResearchModule = z.infer<typeof ResearchModuleSchema>;

export const RUN_STATUSES = ["queued", "processing_docs", "synthesizing", "completed", "partial", "failed", "cancelled"] as const;
export const RunStatusSchema = z.enum(RUN_STATUSES);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const CreateResearchRunSchema = z.object({
  symbol: z.string().trim().toUpperCase().regex(/^[A-Z0-9&\-]{1,20}$/),
  modules: z.array(ModuleKeySchema).optional(),
});

export const ResearchRunSchema = z.object({
  id: z.string(),
  symbol: z.string(),
  companyName: z.string().nullable(),
  status: RunStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  modules: z.array(ResearchModuleSchema),
  documents: z.array(z.object({ id: z.string(), label: z.string(), status: z.string(), pages: z.number().nullable(), url: z.string() })),
});
export type ResearchRun = z.infer<typeof ResearchRunSchema>;

export const RESEARCH_EVENT_TYPES = [
  "run.queued",
  "run.started",
  "document.discovered",
  "document.downloaded",
  "document.extracted",
  "document.embedded",
  "document.failed",
  "module.started",
  "module.completed",
  "module.failed",
  "run.completed",
  "run.failed",
] as const;
export const ResearchEventSchema = z.object({
  id: z.number().int(),
  runId: z.string(),
  type: z.enum(RESEARCH_EVENT_TYPES),
  message: z.string(),
  data: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string(),
});
export type ResearchEvent = z.infer<typeof ResearchEventSchema>;

export const AskRequestSchema = z.object({ symbol: z.string().trim().toUpperCase(), question: z.string().trim().min(3).max(500) });
export const AskResponseSchema = z.object({ answer: z.array(ClaimSchema), insufficientSources: z.boolean() });
