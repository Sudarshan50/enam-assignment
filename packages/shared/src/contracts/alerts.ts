import { z } from "zod";
import { CategorySchema, StatementFamilySchema } from "../taxonomy";

export const RuleScopeSchema = z.union([
  z.object({ kind: z.literal("portfolio") }),
  z.object({ kind: z.literal("symbols"), symbols: z.array(z.string()).min(1).max(50) }),
  z.object({ kind: z.literal("statement_family"), family: StatementFamilySchema }),
]);

export const AlertRuleDefinitionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("price_move"),
    scope: RuleScopeSchema,
    direction: z.enum(["up", "down", "either"]),
    thresholdPct: z.number().min(0.5).max(20),
  }),
  z.object({
    type: z.literal("volume_spike"),
    scope: RuleScopeSchema,
    multiple: z.number().min(1.5).max(10),
  }),
  z.object({
    type: z.literal("category"),
    scope: RuleScopeSchema,
    categories: z.array(CategorySchema).min(1),
  }),
]);
export type AlertRuleDefinition = z.infer<typeof AlertRuleDefinitionSchema>;

export const AlertRuleSchema = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  definition: AlertRuleDefinitionSchema,
  createdAt: z.string(),
});
export type AlertRule = z.infer<typeof AlertRuleSchema>;

export const CreateAlertRuleSchema = z.object({ name: z.string().min(1).max(80), definition: AlertRuleDefinitionSchema });
export const PreviewAlertRuleSchema = z.object({ text: z.string().min(3).max(300) });
export const PreviewAlertRuleResponseSchema = z.object({
  definition: AlertRuleDefinitionSchema.nullable(),
  resolvedSymbols: z.array(z.string()),
  explanation: z.string(),
});

export const AlertSchema = z.object({
  id: z.string(),
  ruleId: z.string(),
  ruleName: z.string(),
  symbol: z.string(),
  kind: z.enum(["price_move", "volume_spike", "category"]),
  title: z.string(),
  body: z.string(),
  sessionDate: z.string().nullable(),
  announcementId: z.string().nullable(),
  createdAt: z.string(),
  readAt: z.string().nullable(),
});
export type Alert = z.infer<typeof AlertSchema>;

export const PushSubscriptionSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({ p256dh: z.string(), auth: z.string() }),
});
