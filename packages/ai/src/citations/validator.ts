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

/** True when the quote (or each "..."-separated fragment of it) occurs in the source text. */
export function quoteInText(quote: string, text: string): boolean {
  const hay = normaliseForMatch(text);
  const hayTight = squash(hay);
  const fragments = normaliseForMatch(quote)
    .split(/\s*(?:\.\.\.|\u2026)\s*/)
    .map((f) => f.replace(/^["']|["']$/g, "").trim())
    .filter((f) => f.length > 0);
  if (fragments.length === 0) return false;
  return fragments.every((f) => hay.includes(f) || hayTight.includes(squash(f)));
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
  const citedTexts: string[] = [];

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
    if (!quoteInText(cit.quote, chunk.text)) {
      problems.push(`quote "${cit.quote.slice(0, 120)}" does not appear verbatim in chunk ${cit.chunkId}`);
      continue;
    }
    citedTexts.push(chunk.text);
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
    const sourceNumbers = citedTexts.flatMap(extractNumbers);
    for (const n of extractNumbers(claim.text)) {
      if (isExemptNumber(n)) continue;
      if (!numberSupported(n, sourceNumbers, ctx.facts ?? [])) problems.push(`number "${n.raw}" is not in the cited sources`);
    }
  } else if (claim.citations.length > 0) {
    problems.push("no citation could be verified");
  }

  return { claim, ok: problems.length === 0, problems, citations };
}

/** One citation per chunk and page; distinct quotes from it are joined with an ellipsis, which quoteInText still verifies. */
export function mergeCitations(citations: readonly Citation[]): Citation[] {
  const merged = new Map<string, Citation>();
  for (const c of citations) {
    const key = `${c.chunkId}\u0000${c.page ?? ""}`;
    const prev = merged.get(key);
    if (!prev) {
      merged.set(key, { ...c });
      continue;
    }
    const a = normaliseForMatch(prev.quote);
    const b = normaliseForMatch(c.quote);
    if (a.includes(b)) continue;
    prev.quote = b.includes(a) ? c.quote : `${prev.quote} … ${c.quote}`;
  }
  return [...merged.values()];
}

function toClaim(check: ClaimCheck): Claim {
  return { text: check.claim.text.trim(), citations: mergeCitations(check.citations), grounded: check.ok };
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
  return checks.map(toClaim);
}
