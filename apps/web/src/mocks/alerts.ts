import { CATEGORIES, CATEGORY_LABELS, type Alert, type AlertRule, type AlertRuleDefinition, type Category } from "@finn/shared";
import type { RulePreview } from "../lib/api/schemas";
import { PORTFOLIO } from "./portfolio";
import { hoursAgo, lastSessionDate, seeded } from "./util";

export function buildRules(now: Date): AlertRule[] {
  return [
    {
      id: "rule-price",
      name: "Any holding moves more than 4% in a session",
      enabled: true,
      definition: { type: "price_move", scope: { kind: "portfolio" }, direction: "either", thresholdPct: 4 },
      createdAt: hoursAgo(now, 24 * 9),
    },
    {
      id: "rule-volume",
      name: "Volume above 2× its 20-session average",
      enabled: true,
      definition: { type: "volume_spike", scope: { kind: "portfolio" }, multiple: 2 },
      createdAt: hoursAgo(now, 24 * 9),
    },
    {
      id: "rule-material",
      name: "Results, M&A or a management change",
      enabled: true,
      definition: { type: "category", scope: { kind: "portfolio" }, categories: ["results", "m_and_a", "management_change"] },
      createdAt: hoursAgo(now, 24 * 8),
    },
    {
      id: "rule-bank-rating",
      name: "Any credit-rating action on a bank",
      enabled: false,
      definition: { type: "category", scope: { kind: "statement_family", family: "banking" }, categories: ["credit_rating"] },
      createdAt: hoursAgo(now, 24 * 3),
    },
  ];
}

export function buildAlerts(now: Date): Alert[] {
  const session = lastSessionDate(now);
  return [
    {
      id: "al-1",
      ruleId: "rule-material",
      ruleName: "Results, M&A or a management change",
      symbol: "TRENT",
      kind: "category",
      title: "TRENT · board approved Q2 FY27 results",
      body: "Numbers are not filed yet. FINN will update the card when the XBRL arrives.",
      sessionDate: null,
      announcementId: "2026111500412",
      createdAt: hoursAgo(now, 2.2),
      readAt: null,
    },
    {
      id: "al-2",
      ruleId: "rule-material",
      ruleName: "Results, M&A or a management change",
      symbol: "TCS",
      kind: "category",
      title: "TCS · Q2 FY27 results",
      body: "Revenue +11.2% YoY to ₹73,188 Cr; EBITDA margin −161 bps YoY.",
      sessionDate: null,
      announcementId: "2026111500388",
      createdAt: hoursAgo(now, 5.4),
      readAt: null,
    },
    {
      id: "al-3",
      ruleId: "rule-price",
      ruleName: "Any holding moves more than 4% in a session",
      symbol: "TRENT",
      kind: "price_move",
      title: "TRENT fell 4.8%",
      body: "Closed at ₹4,610.55, its largest one-day fall in 30 sessions.",
      sessionDate: session,
      announcementId: null,
      createdAt: hoursAgo(now, 40),
      readAt: null,
    },
    {
      id: "al-4",
      ruleId: "rule-volume",
      ruleName: "Volume above 2× its 20-session average",
      symbol: "TRENT",
      kind: "volume_spike",
      title: "TRENT volume 2.9× average",
      body: "35.8 lakh shares traded against a 20-session average of 12.5 lakh.",
      sessionDate: session,
      announcementId: null,
      createdAt: hoursAgo(now, 40),
      readAt: hoursAgo(now, 30),
    },
    {
      id: "al-5",
      ruleId: "rule-volume",
      ruleName: "Volume above 2× its 20-session average",
      symbol: "TCS",
      kind: "volume_spike",
      title: "TCS volume 2.4× average",
      body: "70 lakh shares traded on results day against an average of 29 lakh.",
      sessionDate: session,
      announcementId: null,
      createdAt: hoursAgo(now, 40),
      readAt: hoursAgo(now, 30),
    },
    {
      id: "al-6",
      ruleId: "rule-material",
      ruleName: "Results, M&A or a management change",
      symbol: "BAJFINANCE",
      kind: "category",
      title: "BAJFINANCE · new Chief Financial Officer",
      body: "Rohan Mehta joins from a large bank's retail-assets business, effective 1 Dec.",
      sessionDate: null,
      announcementId: "2026111300217",
      createdAt: hoursAgo(now, 31),
      readAt: hoursAgo(now, 20),
    },
  ];
}

const BANKS = PORTFOLIO.filter((h) => h.family === "banking").map((h) => h.symbol);
const CATEGORY_WORDS: Array<[RegExp, Category]> = [
  [/result|earning|quarter/i, "results"],
  [/m&a|merger|acqui|demerg|joint venture/i, "m_and_a"],
  [/management|ceo|cfo|director|resign/i, "management_change"],
  [/rating/i, "credit_rating"],
  [/pledg/i, "pledging"],
  [/insider|promoter (buy|sell)/i, "insider_trading"],
  [/litigation|lawsuit|order|penalt|fine/i, "litigation"],
  [/dividend/i, "dividend"],
  [/capex|plant|capacity/i, "capex"],
  [/fund ?rais|qip|rights issue|ncd/i, "fund_raise"],
];

function hitDetail(definition: AlertRuleDefinition | null, rand: () => number): string {
  if (definition?.type === "volume_spike") return `${(definition.multiple + rand() * 1.5).toFixed(1)}× average`;
  if (definition?.type === "price_move") {
    const sign = definition.direction === "down" ? "−" : definition.direction === "up" ? "+" : rand() > 0.5 ? "+" : "−";
    return `${sign}${(definition.thresholdPct + 0.2 + rand() * 2.5).toFixed(1)}%`;
  }
  return "Filing matched";
}

/** A deliberately small parser standing in for the API's LLM-backed preview. */
export function previewRule(text: string, now: Date): RulePreview {
  const upper = text.toUpperCase();
  const named = PORTFOLIO.map((h) => h.symbol).filter((s) => new RegExp(`\\b${s}\\b`).test(upper));
  const bank = /\bbank/i.test(text) && named.length === 0;
  const scope: AlertRuleDefinition["scope"] = named.length
    ? { kind: "symbols", symbols: named }
    : bank
      ? { kind: "statement_family", family: "banking" }
      : { kind: "portfolio" };
  const resolvedSymbols = named.length ? named : bank ? BANKS : PORTFOLIO.map((h) => h.symbol);
  const scopeText = named.length ? named.join(", ") : bank ? "banks in your portfolio" : "any holding";

  const num = Number(/(\d+(?:\.\d+)?)/.exec(text)?.[1] ?? NaN);
  let definition: AlertRuleDefinition | null = null;
  let explanation: string;
  let name: string;

  if (/vol/i.test(text)) {
    const multiple = Math.min(10, Math.max(1.5, Number.isFinite(num) ? num : 2));
    definition = { type: "volume_spike", scope, multiple };
    name = `Volume above ${multiple}× average · ${scopeText}`;
    explanation = `Fires when ${scopeText}'s end-of-day volume is at least ${multiple}× the average of the previous 20 completed sessions. Needs 20 sessions of history first.`;
  } else if (/%|percent|move|fall|drop|rise|jump|up|down/i.test(text)) {
    const thresholdPct = Math.min(20, Math.max(0.5, Number.isFinite(num) ? num : 4));
    const direction = /fall|drop|down|declin/i.test(text) ? "down" : /rise|jump|\bup\b|gain/i.test(text) ? "up" : "either";
    definition = { type: "price_move", scope, direction, thresholdPct };
    const s = bank || named.length > 1 ? "" : "s";
    const verb = direction === "down" ? `fall${s} more than ${thresholdPct}%` : direction === "up" ? `rise${s} more than ${thresholdPct}%` : `move${s} more than ±${thresholdPct}%`;
    name = `${scopeText[0]!.toUpperCase()}${scopeText.slice(1)} ${verb}`;
    explanation = `Fires when ${scopeText} ${verb} versus the previous close, from the NSE bhavcopy. Suppressed on bonus or split dates.`;
  } else {
    const categories = CATEGORY_WORDS.filter(([re]) => re.test(text)).map(([, c]) => c);
    if (categories.length) {
      definition = { type: "category", scope, categories };
      const labels = categories.map((c) => CATEGORY_LABELS[c].toLowerCase());
      name = `${labels.join(", ")} · ${scopeText}`;
      explanation = `Fires the moment ${scopeText} files an announcement FINN classifies as ${labels.join(" or ")}.`;
    } else {
      name = "Unrecognised rule";
      explanation = `I couldn't map that to a price move, a volume spike or one of the ${CATEGORIES.length} filing categories. Try "TCS falls more than 3%" or "any management change".`;
    }
  }

  const rand = seeded(text.toLowerCase());
  const fires = definition ? (definition.type === "category" ? 1 + Math.floor(rand() * 4) : Math.floor(rand() * 5)) : 0;
  const hits = Array.from({ length: fires }, (_, i) => {
    const d = new Date(now.getTime() - (2 + Math.floor(rand() * 40) + i) * 86_400_000);
    const symbol = resolvedSymbols[Math.floor(rand() * resolvedSymbols.length)] ?? "TCS";
    return { date: d.toISOString().slice(0, 10), symbol, detail: hitDetail(definition, rand) };
  }).sort((a, b) => b.date.localeCompare(a.date));

  return { definition, resolvedSymbols: definition ? resolvedSymbols : [], explanation, name, backtest: definition ? { fires, sessions: 30, hits } : null };
}
