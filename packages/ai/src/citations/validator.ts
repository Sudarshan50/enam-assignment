import type { Citation, Claim } from "@finn/shared/contracts/research";
import { z } from "zod";
import { extractNumbers, isExemptNumber, numberSupported } from "./numbers";

export const RawCitationSchema = z.object({ chunkId: z.string(), quote: z.string() });
export const RawClaimSchema = z.object({ text: z.string(), citations: z.array(RawCitationSchema) });
export type RawCitation = z.infer<typeof RawCitationSchema>;
export type RawClaim = z.infer<typeof RawClaimSchema>;

/** The parts of a retrieved chunk the validator needs. */
export interface SourceChunk {
  chunkId: string;
  documentId: string;
  documentLabel: string;
  url: string | null;
  pageStart: number;
  pageEnd: number;
  text: string;
  pages?: { page: number; text: string }[];
}

export interface ValidationContext {
  /** Only chunks retrieved for this symbol; a citation outside this set is rejected. */
  chunks: readonly SourceChunk[];
  /** Trusted figures (e.g. computed financials) that claims may quote without a document citation. */
  facts?: readonly number[];
  minQuoteChars?: number;
}

export interface ClaimCheck {
  claim: RawClaim;
  ok: boolean;
  problems: string[];
  citations: Citation[];
}

export type ClaimRegenerator = (failures: { claim: RawClaim; problems: string[] }[]) => Promise<RawClaim[]>;

/** Case, whitespace, quote-character and dash insensitive form used for substring checks. */
export function normaliseForMatch(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\u00ad/g, "")
    .replace(/[\u2018\u2019\u201a\u201b\u2032`\u00b4]/g, "'")
    .replace(/[\u201c\u201d\u201e\u201f\u2033]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2212]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function squash(text: string): string {
  return text.replace(/\s+/g, "");
}

/** Each fragment of an elided quote needs this many non-space characters or words, so "… 40% …" cannot match. */
const MIN_FRAGMENT_CHARS = 12;
const MIN_FRAGMENT_WORDS = 3;
/** Most source text (non-space characters) an ellipsis may stand for. */
const MAX_ELISION = 300;
/** Context either side of a quoted fragment whose numbers may support the claim. */
const NUMBER_WINDOW = 160;

function fragmentsOf(quote: string): string[] {
  return normaliseForMatch(quote)
    .split(/\s*(?:\.\.\.|\u2026)\s*/)
    .map((f) => f.replace(/^["']|["']$/g, "").trim())
    .filter((f) => /[\p{L}\p{N}]/u.test(f));
}

function elisionTooShort(fragments: readonly string[]): boolean {
  return fragments.length > 1 && fragments.some((f) => squash(f).length < MIN_FRAGMENT_CHARS && f.split(" ").length < MIN_FRAGMENT_WORDS);
}

interface QuoteMatch {
  hay: string;
  /** [start, end) of each fragment in `hay`. */
  spans: [number, number][];
}

/** Finds the fragments in order, each starting within MAX_ELISION of the previous one's end. */
function locateQuote(quote: string, text: string): QuoteMatch | null {
  const fragments = fragmentsOf(quote);
  if (fragments.length === 0 || elisionTooShort(fragments)) return null;
  const hay = normaliseForMatch(text);
  const pos: number[] = [];
  let tight = "";
  for (let i = 0; i < hay.length; i++) {
    if (hay[i] === " ") continue;
    tight += hay[i];
    pos.push(i);
  }
  const needles = fragments.map(squash);
  const spans: [number, number][] = [];
  const find = (i: number, from: number, limit: number): boolean => {
    const needle = needles[i];
    if (needle === undefined) return true;
    for (let at = tight.indexOf(needle, from); at !== -1 && at <= limit; at = tight.indexOf(needle, at + 1)) {
      spans[i] = [at, at + needle.length];
      if (find(i + 1, at + needle.length, at + needle.length + MAX_ELISION)) return true;
    }
    return false;
  };
  if (!find(0, 0, Infinity)) return null;
  return { hay, spans: spans.map(([s, e]) => [pos[s]!, pos[e - 1]! + 1]) };
}

/** The quoted fragments plus a word-aligned window around each. */
function quoteContext(m: QuoteMatch): string {
  return m.spans
    .map(([s, e]) => {
      const from = m.hay.lastIndexOf(" ", Math.max(0, s - NUMBER_WINDOW)) + 1;
      const to = m.hay.indexOf(" ", Math.min(m.hay.length, e + NUMBER_WINDOW));
      return m.hay.slice(from, to === -1 ? m.hay.length : to);
    })
    .join("\n");
}

/** True when the quote occurs in the source text; "..."-separated fragments must be substantial, in order and close together. */
export function quoteInText(quote: string, text: string): boolean {
  return locateQuote(quote, text) !== null;
}

function pageOf(chunk: SourceChunk, quote: string): number {
  const hit = chunk.pages?.find((p) => quoteInText(quote, p.text));
  return hit?.page ?? chunk.pageStart;
}

export function checkClaim(claim: RawClaim, ctx: ValidationContext): ClaimCheck {
  const minQuote = ctx.minQuoteChars ?? 12;
  const byId = new Map(ctx.chunks.map((c) => [c.chunkId, c] as const));
  const problems: string[] = [];
  const citations: Citation[] = [];
  const quotedTexts: string[] = [];

  if (!claim.text.trim()) problems.push("claim text is empty");
  if (claim.citations.length === 0) problems.push("claim has no citation");

  for (const cit of claim.citations) {
    const chunk = byId.get(cit.chunkId);
    if (!chunk) {
      problems.push(`chunk ${cit.chunkId} is not one of the provided sources`);
      continue;
    }
    if (squash(normaliseForMatch(cit.quote)).length < minQuote) {
      problems.push(`quote "${cit.quote}" is too short to verify`);
      continue;
    }
    if (elisionTooShort(fragmentsOf(cit.quote))) {
      problems.push(`quote "${cit.quote.slice(0, 120)}" joins fragments too short to verify; quote whole phrases`);
      continue;
    }
    const match = locateQuote(cit.quote, chunk.text);
    if (!match) {
      problems.push(`quote "${cit.quote.slice(0, 120)}" does not appear verbatim in chunk ${cit.chunkId}`);
      continue;
    }
    quotedTexts.push(quoteContext(match));
    citations.push({
      chunkId: chunk.chunkId,
      documentId: chunk.documentId,
      documentLabel: chunk.documentLabel,
      page: pageOf(chunk, cit.quote),
      quote: cit.quote,
      url: chunk.url,
    });
  }

  if (citations.length > 0) {
    const sourceNumbers = quotedTexts.flatMap(extractNumbers);
    for (const n of extractNumbers(claim.text)) {
      if (isExemptNumber(n)) continue;
      if (!numberSupported(n, sourceNumbers, ctx.facts ?? [])) problems.push(`number "${n.raw}" is not in the cited sources`);
    }
  } else if (claim.citations.length > 0) {
    problems.push("no citation could be verified");
  }

  return { claim, ok: problems.length === 0, problems, citations };
}

const WORD_CHAR = /[\p{L}\p{N}]/u;

/** Whether `c` (with `beyond` one further out) continues a token that ends in `edge`: "1" in "15%", "2" in "1.2". */
function continuesToken(edge: string, c: string | undefined, beyond: string | undefined): boolean {
  if (c === undefined) return false;
  return WORD_CHAR.test(c) || (/\d/.test(edge) && /[.,]/.test(c) && /\d/.test(beyond ?? ""));
}

/** `needle` occurs in `hay` as whole words/numbers, so "5%" is not inside "15%". */
function containsPhrase(hay: string, needle: string): boolean {
  if (!needle) return true;
  const first = needle[0]!;
  const last = needle[needle.length - 1]!;
  for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + 1)) {
    const end = at + needle.length;
    const startOk = !WORD_CHAR.test(first) || !continuesToken(first, hay[at - 1], hay[at - 2]);
    const endOk = !WORD_CHAR.test(last) || !continuesToken(last, hay[end], hay[end + 1]);
    if (startOk && endOk) return true;
  }
  return false;
}

function joinQuotes(a: string, b: string, chunkText: string | undefined): string | null {
  const forward = `${a} … ${b}`;
  if (chunkText === undefined) return forward;
  return [forward, `${b} … ${a}`].find((q) => quoteInText(q, chunkText)) ?? null;
}

/**
 * One citation per chunk and page where possible; distinct quotes from it are joined with an ellipsis in text
 * order. Given the chunk text, quotes are joined only when quoteInText still verifies the result.
 */
export function mergeCitations(citations: readonly Citation[], chunkText?: (chunkId: string) => string | undefined): Citation[] {
  const groups = new Map<string, Citation[]>();
  for (const c of citations) {
    const key = `${c.chunkId}\u0000${c.page ?? ""}`;
    const group = groups.get(key);
    if (!group) {
      groups.set(key, [{ ...c }]);
      continue;
    }
    const b = normaliseForMatch(c.quote);
    if (group.some((p) => containsPhrase(normaliseForMatch(p.quote), b))) continue;
    const narrower = group.find((p) => containsPhrase(b, normaliseForMatch(p.quote)));
    if (narrower) {
      narrower.quote = c.quote;
      continue;
    }
    const last = group[group.length - 1]!;
    const joined = joinQuotes(last.quote, c.quote, chunkText?.(c.chunkId));
    if (joined) last.quote = joined;
    else group.push({ ...c });
  }
  return [...groups.values()].flat();
}

function toClaim(check: ClaimCheck, chunkText: (chunkId: string) => string | undefined): Claim {
  return { text: check.claim.text.trim(), citations: mergeCitations(check.citations, chunkText), grounded: check.ok };
}

/**
 * Validates claims; failures are sent back once to `regenerate` with the reasons. Anything still failing is
 * kept with grounded=false (shown as "could not be grounded"), never silently dropped.
 */
export async function validateClaims(claims: RawClaim[], ctx: ValidationContext, regenerate?: ClaimRegenerator): Promise<Claim[]> {
  const checks = claims.map((c) => checkClaim(c, ctx));
  const failing = checks.map((c, i) => ({ c, i })).filter(({ c }) => !c.ok);
  if (failing.length > 0 && regenerate) {
    let fixed: RawClaim[] = [];
    try {
      fixed = await regenerate(failing.map(({ c }) => ({ claim: c.claim, problems: c.problems })));
    } catch {
      fixed = [];
    }
    failing.forEach(({ i }, j) => {
      const replacement = fixed[j];
      if (!replacement) return;
      const recheck = checkClaim(replacement, ctx);
      if (recheck.ok) checks[i] = recheck;
    });
  }
  const textById = new Map(ctx.chunks.map((c) => [c.chunkId, c.text] as const));
  return checks.map((c) => toClaim(c, (id) => textById.get(id)));
}
