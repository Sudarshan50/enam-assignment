export interface PageText {
  page: number;
  text: string;
}

export interface TextChunk {
  index: number;
  pageStart: number;
  pageEnd: number;
  section: string | null;
  text: string;
  tokenEstimate: number;
}

export interface ChunkOptions {
  targetTokens?: number;
  minTokens?: number;
  maxTokens?: number;
  overlapRatio?: number;
  charsPerToken?: number;
}

const DEFAULTS: Required<ChunkOptions> = { targetTokens: 800, minTokens: 700, maxTokens: 900, overlapRatio: 0.15, charsPerToken: 4 };

const SMALL_WORDS = new Set(["a", "an", "and", "as", "at", "by", "for", "from", "in", "of", "on", "or", "the", "to", "with", "&", "-", "vs"]);
const PAGE_NUMBER_LINE = /^(page\s*)?\d{1,4}(\s*(of|\/)\s*\d{1,4})?$/i;

export function estimateTokens(text: string, charsPerToken = DEFAULTS.charsPerToken): number {
  return Math.ceil(text.length / charsPerToken);
}

function boilerplateKey(line: string): string {
  return line.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
}

/** Running headers and footers live in the first/last few lines of a page; body text is never touched. */
const EDGE_LINES = 3;

function edgeIndexes(count: number): Set<number> {
  const out = new Set<number>();
  for (let i = 0; i < Math.min(EDGE_LINES, count); i++) (out.add(i), out.add(count - 1 - i));
  return out;
}

/**
 * Drops running headers/footers: short edge-of-page lines that recur (digits ignored, so "Page 3"/"Page 4"
 * match) on at least half of the pages, plus bare page-number lines at the page edges.
 */
export function stripBoilerplate(pages: PageText[]): PageText[] {
  const split = pages.map((p) => p.text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0));
  const pageCount = new Map<string, number>();
  if (pages.length >= 4) {
    for (const lines of split) {
      const seen = new Set<string>();
      for (const i of edgeIndexes(lines.length)) {
        const key = boilerplateKey(lines[i]!);
        if (key.length > 150 || seen.has(key)) continue;
        seen.add(key);
        pageCount.set(key, (pageCount.get(key) ?? 0) + 1);
      }
    }
  }
  const threshold = Math.max(3, Math.ceil(pages.length * 0.5));
  return pages.map((p, pi) => {
    const lines = split[pi]!;
    const edges = edgeIndexes(lines.length);
    return {
      page: p.page,
      text: lines
        .filter((line, i) => {
          if (!edges.has(i)) return true;
          if (PAGE_NUMBER_LINE.test(line)) return false;
          return (pageCount.get(boilerplateKey(line)) ?? 0) < threshold;
        })
        .join("\n"),
    };
  });
}

/** Heuristic: short, unpunctuated, Title Case or ALL CAPS lines are section headings. */
export function looksLikeHeading(line: string): boolean {
  const t = line.trim();
  if (t.length < 6 || t.length > 80) return false;
  if (/[.,;:!?]$/.test(t) || t.includes(": ")) return false;
  const letters = t.replace(/[^A-Za-z]/g, "");
  if (letters.length < 4) return false;
  const digits = (t.match(/\d/g) ?? []).length;
  if (digits > letters.length / 3) return false;
  const words = t.split(/\s+/).filter((w) => /[A-Za-z]/.test(w));
  if (words.length === 0 || words.length > 10) return false;
  const allCaps = t === t.toUpperCase() && /[A-Z]{3}/.test(t);
  const titleCase = words.length >= 2 && words.every((w) => /^[^A-Za-z]*[A-Z]/.test(w) || SMALL_WORDS.has(w.toLowerCase()));
  return allCaps || titleCase;
}

function normaliseHeading(line: string): string {
  const t = line.trim().replace(/\s+/g, " ");
  return t === t.toUpperCase() ? t.toLowerCase().replace(/(^|\s)([a-z])/g, (_m, s: string, c: string) => s + c.toUpperCase()) : t;
}

interface Unit {
  page: number;
  text: string;
  section: string | null;
  isHeading: boolean;
}

function splitLongLine(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const sentences = text.split(/(?<=[.!?])\s+/);
  const out: string[] = [];
  let buf = "";
  for (const s of sentences) {
    if (s.length > maxChars) {
      if (buf) (out.push(buf), (buf = ""));
      for (let i = 0; i < s.length; i += maxChars) out.push(s.slice(i, i + maxChars));
      continue;
    }
    if (buf.length + s.length + 1 > maxChars) (out.push(buf), (buf = s));
    else buf = buf ? `${buf} ${s}` : s;
  }
  if (buf) out.push(buf);
  return out;
}

/**
 * Packs a single document's pages into ~700–900 token chunks with ~15% overlap. Chunks prefer to break at a
 * heading once they reach the minimum size, carry their page range, and the heading they start under.
 */
export function chunkPages(pages: PageText[], options: ChunkOptions = {}): TextChunk[] {
  const o = { ...DEFAULTS, ...options };
  const minChars = o.minTokens * o.charsPerToken;
  const targetChars = o.targetTokens * o.charsPerToken;
  const maxChars = o.maxTokens * o.charsPerToken;
  const overlapChars = Math.floor(targetChars * o.overlapRatio);
  // Units must be well below the overlap budget or no overlap could ever be carried.
  const maxUnitChars = Math.max(200, Math.floor(overlapChars * 0.9));

  const units: Unit[] = [];
  let section: string | null = null;
  for (const p of stripBoilerplate(pages)) {
    for (const raw of p.text.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      const isHeading = looksLikeHeading(line);
      if (isHeading) section = normaliseHeading(line);
      for (const piece of splitLongLine(line, maxUnitChars)) units.push({ page: p.page, text: piece, section, isHeading });
    }
  }

  const chunks: TextChunk[] = [];
  let current: Unit[] = [];
  let currentChars = 0;
  let newStart = 0;

  const size = (u: Unit) => u.text.length + 1;
  const newChars = () => current.slice(newStart).reduce((n, u) => n + size(u), 0);

  const flush = () => {
    if (current.length === 0 || newStart >= current.length) return;
    const text = current.map((u) => u.text).join("\n");
    chunks.push({
      index: chunks.length,
      pageStart: current[0]!.page,
      pageEnd: current[current.length - 1]!.page,
      section: current[newStart]!.section,
      text,
      tokenEstimate: estimateTokens(text, o.charsPerToken),
    });
    const carry: Unit[] = [];
    let carryChars = 0;
    for (let i = current.length - 1; i > newStart; i--) {
      const u = current[i]!;
      if (carryChars + size(u) > overlapChars) break;
      carry.unshift(u);
      carryChars += size(u);
    }
    current = carry;
    currentChars = carryChars;
    newStart = carry.length;
  };

  for (const u of units) {
    if (newStart < current.length) {
      const fresh = newChars();
      if ((u.isHeading && fresh >= minChars) || currentChars + size(u) > maxChars) flush();
    }
    current.push(u);
    currentChars += size(u);
    if (currentChars >= targetChars && !u.isHeading) flush();
  }
  flush();
  return chunks;
}
