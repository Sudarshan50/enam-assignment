import { z } from "zod";
import { StatementFamilySchema } from "../taxonomy";

/** A number shown on a card, always traceable to where it came from. */
export const ProvenancedNumberSchema = z.object({
  value: z.number().nullable(),
  unit: z.enum(["inr", "pct", "bps", "x", "count", "inr_per_share"]),
  derived: z.boolean().default(false),
  source: z
    .object({
      kind: z.enum(["xbrl", "filing_pdf", "bhavcopy", "screener"]),
      ref: z.string(),
      page: z.number().int().optional(),
    })
    .optional(),
});
export type ProvenancedNumber = z.infer<typeof ProvenancedNumberSchema>;

export const ResultsMetricSchema = z.object({
  key: z.string(),
  label: z.string(),
  current: ProvenancedNumberSchema,
  previousQuarter: ProvenancedNumberSchema.nullable(),
  yearAgoQuarter: ProvenancedNumberSchema.nullable(),
  qoqPct: z.number().nullable(),
  yoyPct: z.number().nullable(),
});
export type ResultsMetric = z.infer<typeof ResultsMetricSchema>;

export const ResultsCardSchema = z.object({
  kind: z.literal("results"),
  periodEnd: z.string(),
  periodLabel: z.string(),
  basis: z.enum(["consolidated", "standalone"]),
  statementFamily: StatementFamilySchema,
  audited: z.boolean(),
  status: z.enum(["ready", "not_filed_yet", "under_review"]),
  metrics: z.array(ResultsMetricSchema),
  marginBps: z
    .object({ label: z.string(), current: z.number().nullable(), qoqBps: z.number().nullable(), yoyBps: z.number().nullable() })
    .nullable(),
  read: z.string().nullable(),
  ebitdaDefinition: z.string().nullable(),
});
export type ResultsCard = z.infer<typeof ResultsCardSchema>;

export const PersonSchema = z.object({
  name: z.string(),
  role: z.string().nullable(),
  direction: z.enum(["incoming", "outgoing", "redesignated"]),
  effectiveDate: z.string().nullable(),
  reason: z.string().nullable(),
  filingProfile: z.string().nullable(),
  profilePage: z.number().int().nullable(),
  link: z.object({ url: z.string(), headline: z.string().nullable(), source: z.string() }).nullable(),
});
export type Person = z.infer<typeof PersonSchema>;

export const ManagementChangeCardSchema = z.object({
  kind: z.literal("management_change"),
  people: z.array(PersonSchema),
  seniority: z.enum(["board_or_cxo", "kmp", "senior_management", "other"]),
  summary: z.string().nullable(),
});

export const DealCardSchema = z.object({
  kind: z.literal("deal"),
  dealType: z.enum(["acquisition", "merger", "demerger", "joint_venture", "stake_sale", "investment", "fund_raise", "buyback", "capex"]),
  counterparty: z.string().nullable(),
  amountInr: ProvenancedNumberSchema.nullable(),
  pctOfMarketCap: z.number().nullable(),
  rationale: z.string().nullable(),
});

export const CreditRatingCardSchema = z.object({
  kind: z.literal("credit_rating"),
  agency: z.string().nullable(),
  instrument: z.string().nullable(),
  previousRating: z.string().nullable(),
  newRating: z.string().nullable(),
  outlook: z.string().nullable(),
  action: z.enum(["upgrade", "downgrade", "reaffirm", "assign", "withdraw", "watch", "unknown"]),
});

export const CorporateActionCardSchema = z.object({
  kind: z.literal("corporate_action"),
  action: z.enum(["dividend", "bonus", "split"]),
  amountPerShare: z.number().nullable(),
  ratio: z.string().nullable(),
  recordDate: z.string().nullable(),
  yieldPct: z.number().nullable(),
});

export const OwnershipCardSchema = z.object({
  kind: z.literal("ownership"),
  action: z.enum(["insider_buy", "insider_sell", "pledge_created", "pledge_released", "pledge_changed"]),
  person: z.string().nullable(),
  shares: z.number().nullable(),
  holdingPctBefore: z.number().nullable(),
  holdingPctAfter: z.number().nullable(),
});

export const LitigationCardSchema = z.object({
  kind: z.literal("litigation"),
  authority: z.string().nullable(),
  amountInr: ProvenancedNumberSchema.nullable(),
  pctOfNetWorth: z.number().nullable(),
  summary: z.string().nullable(),
});

export const GenericCardSchema = z.object({
  kind: z.literal("generic"),
  oneLiner: z.string().nullable(),
});

export const CardSchema = z.discriminatedUnion("kind", [
  ResultsCardSchema,
  ManagementChangeCardSchema,
  DealCardSchema,
  CreditRatingCardSchema,
  CorporateActionCardSchema,
  OwnershipCardSchema,
  LitigationCardSchema,
  GenericCardSchema,
]);
export type Card = z.infer<typeof CardSchema>;
