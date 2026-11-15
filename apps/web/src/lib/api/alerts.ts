import { AlertRuleSchema, type AlertRule, type AlertRuleDefinition } from "@finn/shared";
import { USE_MOCKS } from "@/lib/env";
import { parseMock, request, requestVoid } from "./http";
import { mocks } from "./mock";
import { AlertRulesResponseSchema, AlertsResponseSchema, RulePreviewSchema } from "./schemas";

export async function getAlerts() {
  if (USE_MOCKS) return parseMock(AlertsResponseSchema, (await mocks()).alerts(), "alerts");
  return request("/alerts", AlertsResponseSchema);
}

export async function markAlertRead(id: string) {
  if (USE_MOCKS) return (await mocks(false)).markAlertRead(id);
  return requestVoid(`/alerts/${encodeURIComponent(id)}/read`, { method: "POST" });
}

export async function getRules() {
  if (USE_MOCKS) return parseMock(AlertRulesResponseSchema, (await mocks()).rules(), "rules");
  return request("/alert-rules", AlertRulesResponseSchema);
}

export async function previewRule(text: string) {
  if (USE_MOCKS) {
    const api = await mocks();
    await new Promise((r) => setTimeout(r, 700));
    return parseMock(RulePreviewSchema, api.previewRule(text), "rulePreview");
  }
  return request("/alert-rules/preview", RulePreviewSchema, { method: "POST", body: { text } });
}

export async function createRule(input: { name: string; definition: AlertRuleDefinition }) {
  if (USE_MOCKS) return parseMock(AlertRuleSchema, (await mocks()).createRule(input), "createRule");
  return request("/alert-rules", AlertRuleSchema, { method: "POST", body: input });
}

export async function updateRule(id: string, patch: Partial<Pick<AlertRule, "enabled" | "name">>) {
  if (USE_MOCKS) return parseMock(AlertRuleSchema, (await mocks(false)).updateRule(id, patch), "updateRule");
  return request(`/alert-rules/${encodeURIComponent(id)}`, AlertRuleSchema, { method: "PATCH", body: patch });
}

export async function deleteRule(id: string) {
  if (USE_MOCKS) return (await mocks(false)).deleteRule(id);
  return requestVoid(`/alert-rules/${encodeURIComponent(id)}`, { method: "DELETE" });
}
