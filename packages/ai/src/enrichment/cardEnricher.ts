import { CardSchema, type Card, type ProvenancedNumber } from "@finn/shared/contracts/cards";
import type { CardEnricher, EnrichmentInput, LlmPort } from "@finn/shared/ports";
import type { Category } from "@finn/shared/taxonomy";
import type { z } from "zod";
import { extractNumbers, numberSupported, type ExtractedNumber } from "../citations/numbers";
import { quoteInText } from "../citations/validator";
import * as prompt from "../prompts/cards";
import { toStrictJsonSchema } from "../util/schema";

type Kind = keyof typeof prompt.SYSTEMS;

const KIND_BY_CATEGORY: Partial<Record<Category, Kind>> = {
  management_change: "management_change",
  m_and_a: "deal",
  fund_raise: "deal",
  capex: "deal",
  credit_rating: "credit_rating",
  dividend: "corporate_action",
  bonus_split: "corporate_action",
  insider_trading: "ownership",
  pledging: "ownership",
  litigation: "litigation",
};

const SCALE: Record<NonNullable<prompt.ExtractedAmount["scale"]>, number> = {
  rupees: 1,
  thousand: 1e3,
  lakh: 1e5,
  crore: 1e7,
  million: 1e6,
  billion: 1e9,
};

function sourceText(input: EnrichmentInput): string {
  return [input.subject, input.text, input.exchangeSummary ?? "", input.attachmentText ?? ""].join("\n");
}

function asNumber(value: number): ExtractedNumber {
  const decimals = String(value).split(".")[1]?.length ?? 0;
  return { raw: String(value), value: Math.abs(value), decimals, dimension: "plain", rupees: null };
}

/** Numbers are kept only if the filing text contains them (within 1%, rounding-aware). */
function makeGuard(text: string) {
  const nums = extractNumbers(text);
  return {
    num(value: number | null): number | null {
      return value === null || !numberSupported(asNumber(value), nums) ? null : value;
    },
    /** Free text survives only if every number in it is in the filing. */
    text(value: string | null): string | null {
      if (!value) return null;
      return extractNumbers(value).every((n) => numberSupported(n, nums)) ? value : null;
    },
    date(value: string | null): string | null {
      return value && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) ? value : null;
    },
  };
}

function inrAmount(amount: prompt.ExtractedAmount, guard: ReturnType<typeof makeGuard>, input: EnrichmentInput): ProvenancedNumber | null {
  if (amount.value === null || amount.currency !== "INR" || amount.scale === null) return null;
  if (guard.num(amount.value) === null) return null;
  return {
    value: amount.value * SCALE[amount.scale],
    unit: "inr",
    derived: amount.scale !== "rupees",
    source: { kind: "filing_pdf", ref: input.attachmentUrl ?? input.seqId },
  };
}

async function extract<S extends z.ZodType>(llm: LlmPort, kind: Kind, schema: S, input: EnrichmentInput): Promise<z.infer<S>> {
  return llm.complete({
    task: `card.${kind}`,
    promptVersion: prompt.PROMPT_VERSION,
    system: prompt.SYSTEMS[kind],
    user: prompt.buildUser(input),
    jsonSchema: toStrictJsonSchema(schema),
    parse: (v) => schema.parse(v) as z.infer<S>,
    ref: { kind: "announcement", id: input.seqId },
    maxTokens: 2_000,
  });
}

/** Builds typed cards for non-results categories; results cards come from XBRL, not the model. */
export function createCardEnricher(deps: { llm: LlmPort }): CardEnricher {
  const { llm } = deps;
  return {
    async enrich(input: EnrichmentInput): Promise<Card | null> {
      const kind = KIND_BY_CATEGORY[input.category];
      if (!kind) return null;
      const text = sourceText(input);
      const guard = makeGuard(text);
      let card: unknown;

      switch (kind) {
        case "management_change": {
          const r = await extract(llm, kind, prompt.ManagementChangeExtraction, input);
          if (r.people.length === 0) return null;
          card = {
            kind,
            seniority: r.seniority,
            summary: guard.text(r.summary),
            people: r.people.map((p) => {
              let profile = p.filingProfile?.trim() || null;
              if (profile && !quoteInText(profile, text)) {
                // Lightly condensed profiles are kept only when every number in them is in the filing.
                const ok = extractNumbers(profile).every((n) => numberSupported(n, extractNumbers(text)));
                if (!ok) profile = null;
              }
              return {
                name: p.name,
                role: p.role,
                direction: p.direction,
                effectiveDate: guard.date(p.effectiveDate),
                reason: guard.text(p.reason),
                filingProfile: profile,
                profilePage: null,
                link: null,
              };
            }),
          };
          break;
        }
        case "deal": {
          const r = await extract(llm, kind, prompt.DealExtraction, input);
          card = { kind, dealType: r.dealType, counterparty: r.counterparty, amountInr: inrAmount(r.amount, guard, input), pctOfMarketCap: null, rationale: guard.text(r.rationale) };
          break;
        }
        case "credit_rating": {
          const r = await extract(llm, kind, prompt.CreditRatingExtraction, input);
          card = { kind, ...r };
          break;
        }
        case "corporate_action": {
          const r = await extract(llm, kind, prompt.CorporateActionExtraction, input);
          card = { kind, action: r.action, amountPerShare: guard.num(r.amountPerShare), ratio: r.ratio, recordDate: guard.date(r.recordDate), yieldPct: null };
          break;
        }
        case "ownership": {
          const r = await extract(llm, kind, prompt.OwnershipExtraction, input);
          card = {
            kind,
            action: r.action,
            person: r.person,
            shares: guard.num(r.shares),
            holdingPctBefore: guard.num(r.holdingPctBefore),
            holdingPctAfter: guard.num(r.holdingPctAfter),
          };
          break;
        }
        case "litigation": {
          const r = await extract(llm, kind, prompt.LitigationExtraction, input);
          card = { kind, authority: r.authority, amountInr: inrAmount(r.amount, guard, input), pctOfNetWorth: guard.num(r.pctOfNetWorth), summary: guard.text(r.summary) };
          break;
        }
      }
      return CardSchema.parse(card);
    },
  };
}
