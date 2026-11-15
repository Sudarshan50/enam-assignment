export type NumberDimension = "money" | "pct" | "bps" | "multiple" | "plain";

export interface ExtractedNumber {
  raw: string;
  /** The number as written, commas removed, sign dropped (see `negative`). */
  value: number;
  /** Decimal places as written, used for rounding-aware comparison. */
  decimals: number;
  dimension: NumberDimension;
  /** Absolute rupees for money amounts with a scale word, otherwise null. */
  rupees: number | null;
  /** Written with a leading minus, as a bare parenthesised figure "(1,234)", or as a loss. */
  negative: boolean;
}

const MONEY_SCALE: [RegExp, number][] = [
  [/^lakh\s*(crores?|cr\.?)$/i, 1e12],
  [/^(crores?|cr\.?|crs\.?)$/i, 1e7],
  [/^(lakhs?|lacs?|lkh)$/i, 1e5],
  [/^(bn|billion)$/i, 1e9],
  [/^(mn|million)$/i, 1e6],
  [/^thousands?$/i, 1e3],
];

const NUMBER_RE =
  /(?<![A-Za-z0-9.,])(?:(₹|rs\.?|inr|usd|\$)\s*)?(\d{1,3}(?:,\d{2,3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*(lakh\s*crores?|lakh\s*cr\.?|crores?|crs?\.?|lakhs?|lacs?|bn|billion|mn|million|thousands?|%|per\s?cent|percent|bps|basis\s+points|x|times)?(?![A-Za-z0-9])/gi;

const LOSS_BEFORE = /(?<!\/\s*\(?\s*)\(?\blosse?s?\)?\s*(?:(?:of|at|was|is|stood|amounting|amounted|to)\s+)*[:-]?\s*$/i;
const LOSS_AFTER = /^\s*(?:net\s+)?\(?losse?s?\b/i;

function classify(unit: string | undefined, currency: string | undefined, value: number): Pick<ExtractedNumber, "dimension" | "rupees"> {
  const u = (unit ?? "").trim().toLowerCase();
  if (u === "%" || /^per\s?cent$|^percent$/.test(u)) return { dimension: "pct", rupees: null };
  if (u === "bps" || /^basis\s+points$/.test(u)) return { dimension: "bps", rupees: null };
  if (u === "x" || u === "times") return { dimension: "multiple", rupees: null };
  for (const [re, scale] of MONEY_SCALE) if (re.test(u)) return { dimension: "money", rupees: value * scale };
  if (currency) return { dimension: "money", rupees: null };
  return { dimension: "plain", rupees: null };
}

function isNegative(text: string, start: number, end: number, dimension: NumberDimension, bare: boolean): boolean {
  const before = text.slice(Math.max(0, start - 40), start);
  const after = text.slice(end, end + 20);
  if (/(?:^|[^A-Za-z0-9.,])[-\u2212]$/.test(before)) return true;
  if (bare && /\(\s*$/.test(before) && /^\s*\)/.test(after)) return true;
  if (dimension === "money" || dimension === "plain") return LOSS_BEFORE.test(before) || LOSS_AFTER.test(after);
  return false;
}

/** Pulls numbers out of prose or tables, skipping fiscal labels (FY27, Q2, H1) and ordinals (1st). */
export function extractNumbers(text: string): ExtractedNumber[] {
  const out: ExtractedNumber[] = [];
  for (const m of text.matchAll(NUMBER_RE)) {
    const digits = m[2]!;
    const value = Number(digits.replace(/,/g, ""));
    if (!Number.isFinite(value)) continue;
    const decimals = digits.includes(".") ? digits.split(".")[1]!.length : 0;
    const kind = classify(m[3], m[1], value);
    const start = m.index ?? 0;
    const negative = isNegative(text, start, start + m[0].length, kind.dimension, !m[1] && !m[3]);
    out.push({ raw: m[0].trim(), value, decimals, ...kind, negative });
  }
  return out;
}

/** Numbers that do not need grounding: calendar years and tiny list markers. */
export function isExemptNumber(n: ExtractedNumber): boolean {
  if (n.dimension !== "plain") return false;
  return n.decimals === 0 && n.value >= 1990 && n.value <= 2100 && !n.raw.includes(",");
}

function relClose(a: number, b: number, tolerance: number): boolean {
  if (a === b) return true;
  const scale = Math.max(Math.abs(a), Math.abs(b));
  return scale > 0 && Math.abs(a - b) / scale <= tolerance;
}

function roundsTo(source: number, claimed: number, decimals: number): boolean {
  const f = 10 ** decimals;
  return Math.round(source * f) / f === claimed;
}

interface Measure {
  kind: "money" | "pct" | "multiple";
  /** Value in rupees or percent; null when the scale is not written (₹450 in a "₹ crore" table). */
  amount: number | null;
  /** Size of one written unit on that scale. */
  unit: number | null;
}

function measure(n: ExtractedNumber): Measure | null {
  switch (n.dimension) {
    case "pct":
      return { kind: "pct", amount: n.value, unit: 1 };
    case "bps":
      return { kind: "pct", amount: n.value / 100, unit: 0.01 };
    case "multiple":
      return { kind: "multiple", amount: n.value, unit: 1 };
    case "money":
      return { kind: "money", amount: n.rupees, unit: n.rupees === null || n.value === 0 ? null : n.rupees / n.value };
    case "plain":
      return null;
  }
}

function sameSign(a: ExtractedNumber, b: ExtractedNumber): boolean {
  return a.negative === b.negative || a.value === 0 || b.value === 0;
}

/**
 * A claimed number is supported by a source number of the same sign and dimension (an amount never supports a
 * percentage; 100 bps is 1%) whose value agrees within the tolerance after scaling (₹1.2 lakh crore vs
 * 1,20,000 crore; ₹100 lakh is not ₹100 crore), or that rounds to the claimed precision in the same unit
 * (11.8% -> "12%"). When either side has no unit or no scale word, the figures are compared as written.
 */
export function numberSupported(claimed: ExtractedNumber, sources: readonly ExtractedNumber[], facts: readonly number[] = [], tolerance = 0.01): boolean {
  const c = measure(claimed);
  for (const s of sources) {
    if (!sameSign(claimed, s)) continue;
    const m = measure(s);
    if (c && m && c.kind !== m.kind) continue;
    if (c?.amount != null && m?.amount != null) {
      if (relClose(c.amount, m.amount, tolerance)) return true;
      const sameUnit = c.unit !== null && m.unit !== null && relClose(c.unit, m.unit, 1e-9);
      if (sameUnit && claimed.decimals < s.decimals && roundsTo(s.value, claimed.value, claimed.decimals)) return true;
      continue;
    }
    if (relClose(claimed.value, s.value, tolerance)) return true;
    if (claimed.decimals < s.decimals && roundsTo(s.value, claimed.value, claimed.decimals)) return true;
  }
  for (const f of facts) {
    const v = Math.abs(f);
    if (relClose(claimed.value, v, tolerance) || roundsTo(v, claimed.value, claimed.decimals)) return true;
    if (claimed.rupees !== null && relClose(claimed.rupees, v, tolerance)) return true;
  }
  return false;
}
