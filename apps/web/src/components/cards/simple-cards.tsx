import type { Card } from "@finn/shared";
import { ArrowRight } from "lucide-react";
import { Badge, type Tone } from "@/components/ui/badge";
import { Delta } from "@/components/ui/delta";
import { formatCount, formatInr, formatPlainPct } from "@/lib/format";
import { cn } from "@/lib/cn";
import { Fact, Facts, formatIsoDate } from "./parts";

type Of<K extends Card["kind"]> = Extract<Card, { kind: K }>;

const DEAL_LABEL: Record<Of<"deal">["dealType"], string> = {
  acquisition: "Acquisition",
  merger: "Merger",
  demerger: "Demerger",
  joint_venture: "Joint venture",
  stake_sale: "Stake sale",
  investment: "Investment",
  fund_raise: "Fund raise",
  buyback: "Buyback",
  capex: "Capex",
};

export function DealCard({ card }: { card: Of<"deal"> }) {
  return (
    <div className="space-y-4">
      <Facts>
        <Fact label="Type">{DEAL_LABEL[card.dealType]}</Fact>
        <Fact label="Size">
          <span className="font-mono tnum">{card.amountInr ? formatInr(card.amountInr.value) : "Not disclosed"}</span>
        </Fact>
        <Fact label="vs market cap">
          <span className="font-mono tnum">{card.pctOfMarketCap == null ? "—" : formatPlainPct(card.pctOfMarketCap, 2)}</span>
        </Fact>
        {card.counterparty ? <Fact label="Counterparty">{card.counterparty}</Fact> : null}
      </Facts>
      {card.rationale ? <p className="text-[14.5px] leading-relaxed text-ink-muted">{card.rationale}</p> : null}
      {card.amountInr?.source?.page ? (
        <p className="font-mono text-[11px] text-ink-faint">Amount from the filing, p.{card.amountInr.source.page}</p>
      ) : null}
    </div>
  );
}

const RATING_ACTION: Record<Of<"credit_rating">["action"], { label: string; tone: Tone }> = {
  upgrade: { label: "Upgrade", tone: "pos" },
  downgrade: { label: "Downgrade", tone: "neg" },
  reaffirm: { label: "Reaffirmed", tone: "neutral" },
  assign: { label: "Assigned", tone: "know" },
  withdraw: { label: "Withdrawn", tone: "noise" },
  watch: { label: "On watch", tone: "amber" },
  unknown: { label: "Rating action", tone: "neutral" },
};

export function CreditRatingCard({ card }: { card: Of<"credit_rating"> }) {
  const action = RATING_ACTION[card.action];
  const arrowTone = card.action === "upgrade" ? "text-pos" : card.action === "downgrade" ? "text-neg" : "text-ink-faint";
  return (
    <div className="space-y-4">
      <div className="flex items-end gap-4">
        <div>
          <p className="kicker text-ink-faint">Was</p>
          <p className="font-display text-[44px] leading-none text-ink-faint">{card.previousRating ?? "—"}</p>
        </div>
        <ArrowRight className={cn("mb-2 size-6 shrink-0", arrowTone)} aria-label="changed to" />
        <div>
          <p className="kicker text-ink-faint">Now</p>
          <p className="font-display text-[44px] leading-none text-ink">{card.newRating ?? "—"}</p>
        </div>
        <Badge tone={action.tone} className="mb-1.5 ml-auto">
          {action.label}
        </Badge>
      </div>
      <Facts>
        <Fact label="Agency">{card.agency}</Fact>
        <Fact label="Outlook">{card.outlook}</Fact>
        <Fact label="Instrument" wide>
          {card.instrument}
        </Fact>
      </Facts>
    </div>
  );
}

export function CorporateActionCard({ card }: { card: Of<"corporate_action"> }) {
  const headline =
    card.action === "dividend"
      ? card.amountPerShare != null
        ? `₹${card.amountPerShare.toLocaleString("en-IN", { minimumFractionDigits: 2 })}`
        : "Dividend"
      : (card.ratio ?? (card.action === "bonus" ? "Bonus issue" : "Stock split"));
  return (
    <div className="space-y-4">
      <div className="flex items-baseline gap-3">
        <span className="font-display text-[44px] leading-none text-ink tnum">{headline}</span>
        <span className="text-[13.5px] text-ink-muted">{card.action === "dividend" ? "per share" : card.action === "bonus" ? "bonus ratio" : "split ratio"}</span>
      </div>
      <Facts>
        <Fact label="Record date">{formatIsoDate(card.recordDate)}</Fact>
        {card.action === "dividend" ? <Fact label="Yield at last close">{card.yieldPct == null ? null : formatPlainPct(card.yieldPct, 2)}</Fact> : null}
      </Facts>
      {card.action !== "dividend" ? <p className="text-[13.5px] text-ink-muted">Share count changes; no cash changes hands. Price alerts are muted on the ex-date.</p> : null}
    </div>
  );
}

const OWNERSHIP_LABEL: Record<Of<"ownership">["action"], string> = {
  insider_buy: "Insider buy",
  insider_sell: "Insider sell",
  pledge_created: "Pledge created",
  pledge_released: "Pledge released",
  pledge_changed: "Pledge changed",
};

export function OwnershipCard({ card }: { card: Of<"ownership"> }) {
  const change = card.holdingPctBefore != null && card.holdingPctAfter != null ? (card.holdingPctAfter - card.holdingPctBefore) * 100 : null;
  return (
    <Facts>
      <Fact label="Action">{OWNERSHIP_LABEL[card.action]}</Fact>
      <Fact label="By">{card.person}</Fact>
      <Fact label="Shares">
        <span className="font-mono tnum">{formatCount(card.shares, true)}</span>
      </Fact>
      <Fact label="Holding">
        <span className="font-mono tnum">
          {formatPlainPct(card.holdingPctBefore, 2)} → {formatPlainPct(card.holdingPctAfter, 2)}
        </span>{" "}
        {change != null ? <Delta value={change} unit="bps" arrow={false} className="text-[12px]" /> : null}
      </Fact>
    </Facts>
  );
}

export function LitigationCard({ card }: { card: Of<"litigation"> }) {
  return (
    <div className="space-y-4">
      <Facts>
        <Fact label="Amount">
          <span className="font-mono tnum">{card.amountInr ? formatInr(card.amountInr.value) : "Not quantified"}</span>
        </Fact>
        <Fact label="vs net worth">
          <span className="font-mono tnum">{card.pctOfNetWorth == null ? "—" : formatPlainPct(card.pctOfNetWorth)}</span>
        </Fact>
        <Fact label="Authority" wide>
          {card.authority}
        </Fact>
      </Facts>
      {card.summary ? <p className="text-[14.5px] leading-relaxed text-ink-muted">{card.summary}</p> : null}
    </div>
  );
}

export function GenericCard({ card }: { card: Of<"generic"> }) {
  return card.oneLiner ? <p className="text-[14.5px] leading-relaxed text-ink-muted">{card.oneLiner}</p> : null;
}
