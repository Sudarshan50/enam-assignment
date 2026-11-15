import { CATEGORY_LABELS, type AlertRuleDefinition } from "@finn/shared";

export function describeScope(scope: AlertRuleDefinition["scope"]): string {
  if (scope.kind === "portfolio") return "Any holding";
  if (scope.kind === "statement_family") return scope.family === "banking" ? "Banks in your portfolio" : scope.family === "nbfc" ? "NBFCs in your portfolio" : "Industrial companies";
  return scope.symbols.join(", ");
}

export function describeTrigger(def: AlertRuleDefinition): { when: string; threshold: string } {
  switch (def.type) {
    case "price_move":
      return {
        when: def.direction === "up" ? "Closes up" : def.direction === "down" ? "Closes down" : "Moves either way",
        threshold: `${def.direction === "either" ? "±" : ""}${def.thresholdPct}% vs previous close`,
      };
    case "volume_spike":
      return { when: "Volume spikes", threshold: `${def.multiple}× the 20-session average` };
    case "category":
      return { when: "Files an announcement", threshold: def.categories.map((c) => CATEGORY_LABELS[c]).join(", ") };
  }
}
