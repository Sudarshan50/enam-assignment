export type NumberDimension = "money" | "pct" | "bps" | "multiple" | "plain";

export interface ExtractedNumber {
  raw: string;
  /** The number as written, commas removed, sign dropped. */
  value: number;
  /** Decimal places as written, used for rounding-aware comparison. */
  decimals: number;
  dimension: NumberDimension;
  /** Absolute rupees for money amounts with a scale word, otherwise null. */
  rupees: number | null;
}

const MONEY_SCALE: [RegExp, number][] = [
  [/^lakh\s*(crores?|cr\.?)$/i, 1e12],
  [/^(crores?|cr\.?|crs\.?)$/i, 1e7],
  [/^(lakhs?|lacs?|lkh)$/i, 1e5],
  [/^(bn|billion)$/i, 1e9],
  [/^(mn|million)$/i, 1e6],
];

const NUMBER_RE =
  /(?<![A-Za-z0-9.,])(?:(₹|rs\.?|inr|usd|\$)\s*)?(\d{1,3}(?:,\d{2,3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*(lakh\s*crores?|lakh\s*cr\.?|crores?|crs?\.?|lakhs?|lacs?|bn|billion|mn|million|%|per\s?cent|percent|bps|basis\s+points|x|times)?(?![A-Za-z0-9])/gi;

function classify(unit: string | undefined, currency: string | undefined, value: number): Pick<ExtractedNumber, "dimension" | "rupees"> {
  const u = (unit ?? "").trim().toLowerCase();
  if (u === "%" || /^per\s?cent$|^percent$/.test(u)) return { dimension: "pct", rupees: null };
  if (u === "bps" || /^basis\s+points$/.test(u)) return { dimension: "bps", rupees: null };
  if (u === "x" || u === "times") return { dimension: "multiple", rupees: null };
  for (const [re, scale] of MONEY_SCALE) if (re.test(u)) return { dimension: "money", rupees: value * scale };
  if (currency) return { dimension: "money", rupees: value };
  return { dimension: "plain", rupees: null };
}

/** Pulls numbers out of prose or tables, skipping fiscal labels (FY27, Q2, H1) and ordinals (1st). */
export function extractNumbers(text: string): ExtractedNumber[] {
  const out: ExtractedNumber[] = [];
  for (const m of text.matchAll(NUMBER_RE)) {
    const digits = m[2]!;
    const value = Number(digits.replace(/,/g, ""));
    if (!Number.isFinite(value)) continue;
    const decimals = digits.includes(".") ? digits.split(".")[1]!.length : 0;
    out.push({ raw: m[0].trim(), value, decimals, ...classify(m[3], m[1], value) });
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

/**
 * A claimed number is supported by a source number when the raw values agree within the tolerance, the source
 * rounds to the claimed precision (11.8% -> "12%"), or both are rupee amounts that agree after unit conversion
 * (₹1.2 lakh crore vs 1,20,000 crore).
 */
export function numberSupported(claimed: ExtractedNumber, sources: readonly ExtractedNumber[], facts: readonly number[] = [], tolerance = 0.01): boolean {
  for (const s of sources) {
    if (relClose(claimed.value, s.value, tolerance)) return true;
    if (claimed.decimals < s.decimals && roundsTo(s.value, claimed.value, claimed.decimals)) return true;
    if (claimed.rupees !== null && s.rupees !== null && relClose(claimed.rupees, s.rupees, tolerance)) return true;
  }
  for (const f of facts) {
    const v = Math.abs(f);
    if (relClose(claimed.value, v, tolerance) || roundsTo(v, claimed.value, claimed.decimals)) return true;
    if (claimed.rupees !== null && relClose(claimed.rupees, v, tolerance)) return true;
  }
  return false;
}
