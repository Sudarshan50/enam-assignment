/** Trimmed non-empty string, or null. Numbers are stringified (NSE ids arrive as either). */
export function str(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Rows from an NSE payload that is either a bare array or `{ data: [...] }`; null for anything else. */
export function nseRows(payload: unknown): Record<string, unknown>[] | null {
  const rows = Array.isArray(payload) ? payload : isRecord(payload) && Array.isArray(payload.data) ? payload.data : null;
  return rows ? rows.filter(isRecord) : null;
}

export function collapseWhitespace(text: string): string {
  return text.replace(/[\s\u00a0]+/g, " ").trim();
}

/** "1,234.5", "-96", "+8%", "12%" -> number; "" / "-" / garbage -> null. */
export function parseLooseNumber(value: string | null | undefined): number | null {
  if (value == null) return null;
  const cleaned = value.replace(/[,%\s\u00a0]/g, "").replace(/\u2212/g, "-");
  if (cleaned === "" || cleaned === "-" || cleaned === "+") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}
