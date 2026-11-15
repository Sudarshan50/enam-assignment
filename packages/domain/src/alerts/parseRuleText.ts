import { AlertRuleDefinitionSchema, type AlertRuleDefinition } from "@finn/shared/contracts/alerts";
import { CATEGORY_LABELS, type Category, type StatementFamily } from "@finn/shared/taxonomy";
import { clamp } from "../score/score";

export interface ParseRuleContext {
  /** Validates candidate tickers against the master list. Without it, any ALL-CAPS token not in the stop list counts. */
  isKnownSymbol?: (symbol: string) => boolean;
}

const STOP_TOKENS = new Set([
  "I", "A", "AN", "THE", "ME", "MY", "IF", "ON", "OF", "IN", "AT", "OR", "AND", "ANY", "ALL", "NSE", "BSE", "EOD", "AGM", "EGM",
  "QIP", "NCD", "NCDS", "CEO", "CFO", "MD", "KMP", "EBITDA", "PAT", "IPO", "M&A", "X", "PCT", "INR", "RS", "UP", "DOWN",
]);

const CATEGORY_PHRASES: [RegExp, Category][] = [
  [/credit rating|rating (change|upgrade|downgrade|action)|\bdowngrade|\bupgrade/i, "credit_rating"],
  [/earnings call|con-?call|concall|transcript/i, "earnings_call"],
  [/\bresults?\b|earnings|quarterly numbers/i, "results"],
  [/dividend/i, "dividend"],
  [/\bbonus\b|\bsplit\b/i, "bonus_split"],
  [/pledg|encumbrance/i, "pledging"],
  [/insider|promoter (buy|sell|selling|buying)/i, "insider_trading"],
  [/management|\bceo\b|\bcfo\b|\bmd\b|director|resign|appointment|kmp/i, "management_change"],
  [/acquisition|acquire|merger|m&a|takeover|demerger|\bdeals?\b/i, "m_and_a"],
  [/fund ?rais|\bqip\b|preferential|rights issue|\bncds?\b|buy-?back/i, "fund_raise"],
  [/litigation|lawsuit|penalt|court|regulatory order|sebi order/i, "litigation"],
  [/capex|capacity|expansion|new plant/i, "capex"],
  [/postal ballot/i, "postal_ballot"],
  [/\bagm\b|\begm\b|general meeting/i, "agm_egm"],
  [/press release/i, "press_release"],
  [/investor meet|analyst meet/i, "investor_meetings"],
];

const DOWN_WORDS = /\b(falls?|fell|drops?|dropped|down|declines?|declined|crash(es|ed)?|tanks?|slips?|slides?|loses?|lost|plunges?|below|sinks?)\b/i;
const UP_WORDS = /\b(rises?|rose|jumps?|jumped|up|gains?|gained|surges?|surged|rall(y|ies|ied)|climbs?|climbed|soars?|above)\b/i;

function parseScope(original: string, ctx: ParseRuleContext): AlertRuleDefinition["scope"] {
  const family = parseFamily(original);
  if (family) return { kind: "statement_family", family };
  const symbols = extractSymbols(original, ctx);
  if (symbols.length > 0) return { kind: "symbols", symbols };
  return { kind: "portfolio" };
}

const RULE_WORDS = new Set([
  "ALERT", "TELL", "NOTIFY", "PING", "WARN", "WHEN", "ABOUT", "MORE", "LESS", "THAN", "OVER", "UNDER", "MOVES", "MOVE", "FALLS",
  "RISES", "DROPS", "GAINS", "JUMPS", "VOLUME", "SPIKE", "PRICE", "STOCK", "STOCKS", "SHARES", "CHANGES", "CHANGE", "NEWS", "TODAY",
  "DAY", "DAILY", "BY", "TO", "FOR", "IS", "IT", "ITS", "GOES", "EITHER", "WAY", "TIMES", "AVERAGE", "PORTFOLIO", "HOLDINGS",
]);

function parseFamily(text: string): StatementFamily | null {
  if (/\bnbfcs?\b|non-?bank(ing)? financ|finance compan/i.test(text)) return "nbfc";
  if (/\b(any|every|all|my)\s+banks?\b|\bbanks\b|\bbanking\b/i.test(text)) return "banking";
  return null;
}

function extractSymbols(original: string, ctx: ParseRuleContext): string[] {
  const tokens = (original.match(/[A-Za-z0-9][A-Za-z0-9&-]*/g) ?? []).filter((t) => {
    const upper = t.toUpperCase();
    return !STOP_TOKENS.has(upper) && !RULE_WORDS.has(upper) && !/^\d/.test(upper);
  });
  const isKnown = ctx.isKnownSymbol;
  const pick = (candidates: string[]) => [...new Set(candidates.map((t) => t.toUpperCase()))].slice(0, 50);
  const caps = tokens.filter((t) => t === t.toUpperCase() && /[A-Z]/.test(t) && t.length >= 2);
  if (!isKnown) return pick(caps);
  const knownCaps = caps.filter((t) => isKnown(t.toUpperCase()));
  if (knownCaps.length > 0) return pick(knownCaps);
  return pick(tokens.filter((t) => t.length >= 3 && isKnown(t.toUpperCase())));
}

function parseNumber(re: RegExp, text: string): number | null {
  const m = re.exec(text);
  return m ? Number(m[1]) : null;
}

/**
 * Deterministic parser for alert phrasing such as "alert me if TRENT falls more than 4%",
 * "any bank moves 3%", "volume 3x on DIXON" or "tell me about credit rating changes".
 * Returns null when the text doesn't describe a supported rule.
 */
export function parseRuleText(text: string, ctx: ParseRuleContext = {}): AlertRuleDefinition | null {
  const original = text.trim();
  if (!original) return null;
  const scope = parseScope(original, ctx);
  let candidate: unknown = null;

  const multiple = parseNumber(/(\d+(?:\.\d+)?)\s*(?:x\b|×|times\b)/i, original);
  const pct = parseNumber(/(\d+(?:\.\d+)?)\s*(?:%|percent|per cent|pc\b)/i, original);

  if (/\bvol(ume)?\b/i.test(original) || (multiple != null && pct == null)) {
    candidate = { type: "volume_spike", scope, multiple: clamp(multiple ?? 2, 1.5, 10) };
  } else if (pct != null) {
    const down = DOWN_WORDS.test(original);
    const up = UP_WORDS.test(original);
    const direction = down && !up ? "down" : up && !down ? "up" : "either";
    candidate = { type: "price_move", scope, direction, thresholdPct: clamp(pct, 0.5, 20) };
  } else {
    const categories = CATEGORY_PHRASES.filter(([re]) => re.test(original)).map(([, c]) => c);
    const unique = [...new Set(categories)];
    if (unique.length > 0) candidate = { type: "category", scope, categories: unique };
  }

  const parsed = AlertRuleDefinitionSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

export interface PreviewContext extends ParseRuleContext {
  holdings?: readonly string[];
  symbolsInFamily?: (family: StatementFamily) => readonly string[];
}

export interface RulePreview {
  definition: AlertRuleDefinition | null;
  resolvedSymbols: string[];
  explanation: string;
}

/** Shape of PreviewAlertRuleResponseSchema: parse, resolve the scope to tickers, explain. Nothing is saved. */
export function previewRuleText(text: string, ctx: PreviewContext = {}): RulePreview {
  const definition = parseRuleText(text, ctx);
  if (!definition) {
    return {
      definition: null,
      resolvedSymbols: [],
      explanation: 'Couldn\'t read that as an alert. Try "alert me if TRENT falls more than 4%", "volume 3x on DIXON" or "credit rating changes".',
    };
  }
  const scope = definition.scope;
  const resolvedSymbols =
    scope.kind === "symbols" ? scope.symbols : scope.kind === "portfolio" ? [...(ctx.holdings ?? [])] : [...(ctx.symbolsInFamily?.(scope.family) ?? [])];
  return { definition, resolvedSymbols, explanation: explain(definition) };
}

function describeScope(scope: AlertRuleDefinition["scope"], noun: "stock" | "company"): string {
  switch (scope.kind) {
    case "portfolio":
      return `any ${noun} in your portfolio`;
    case "symbols":
      return scope.symbols.length === 1 ? scope.symbols[0]! : `${scope.symbols.slice(0, -1).join(", ")} or ${scope.symbols.at(-1)}`;
    case "statement_family":
      return scope.family === "banking" ? `any bank you track` : scope.family === "nbfc" ? `any NBFC you track` : `any industrial ${noun} you track`;
  }
}

/** Plain-English preview shown before the user confirms a rule. */
export function explain(definition: AlertRuleDefinition): string {
  switch (definition.type) {
    case "price_move": {
      const who = describeScope(definition.scope, "stock");
      const move =
        definition.direction === "up" ? `rises ${definition.thresholdPct}% or more` : definition.direction === "down" ? `falls ${definition.thresholdPct}% or more` : `moves ${definition.thresholdPct}% or more either way`;
      return `Alert when ${who} ${move} in a session, measured close vs previous close (checked after market close).`;
    }
    case "volume_spike":
      return `Alert when ${describeScope(definition.scope, "stock")} trades at least ${definition.multiple}× its average volume of the previous 20 sessions.`;
    case "category": {
      const labels = definition.categories.map((c) => CATEGORY_LABELS[c]);
      const list = labels.length === 1 ? labels[0]! : `${labels.slice(0, -1).join(", ")} or ${labels.at(-1)}`;
      return `Alert on new ${list} filings from ${describeScope(definition.scope, "company")}.`;
    }
  }
}
