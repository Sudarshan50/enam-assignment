import type { DigestItem, ResultsCard as ResultsCardData, ResultsMetric } from "@finn/shared";
import { FileClock, Info, ShieldAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { CountUp } from "@/components/ui/count-up";
import { Delta } from "@/components/ui/delta";
import { InfoPopover } from "@/components/ui/info-popover";
import { Notice } from "@/components/ui/states";
import { formatInr, formatPlainPct } from "@/lib/format";
import { CardProse } from "./parts";

const DERIVED_FALLBACK: Record<string, string> = {
  nii: "Net interest income = interest earned − interest expended. Computed by FINN from the XBRL line items.",
  ebitda: "Computed by FINN from filed line items; the company does not report EBITDA.",
};

function DerivedBadge({ metric, definition }: { metric: ResultsMetric; definition: string | null }) {
  const text = (metric.key === "ebitda" ? definition : null) ?? DERIVED_FALLBACK[metric.key] ?? "Computed by FINN from filed line items.";
  return (
    <InfoPopover
      label={`How ${metric.label} is computed`}
      trigger={
        <span className="inline-flex h-5 items-center gap-1 rounded-full border border-amber/35 px-1.5 font-mono text-[10px] tracking-[0.08em] text-amber uppercase">
          derived
          <Info className="size-3" aria-hidden />
        </span>
      }
    >
      <span className="block text-ink">{text}</span>
      {metric.current.source ? (
        <span className="mt-2 block font-mono text-[11px] text-ink-faint">Inputs: {metric.current.source.ref}</span>
      ) : null}
    </InfoPopover>
  );
}

function MetricRow({ metric, itemId, definition }: { metric: ResultsMetric; itemId: string; definition: string | null }) {
  return (
    <tr className="border-t border-rule">
      <th scope="row" className="py-3 pr-2 text-left align-middle font-normal">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="text-[14px] font-medium text-ink">{metric.label}</span>
          {metric.current.derived ? <DerivedBadge metric={metric} definition={definition} /> : null}
        </span>
      </th>
      <td className="py-3 pl-2 text-right align-middle font-mono text-[14px] text-ink tnum whitespace-nowrap xs:text-[15px]">
        <CountUp value={metric.current.value} format={(v) => formatInr(v)} id={`${itemId}-${metric.key}`} />
      </td>
      <td className="py-3 pl-2 text-right align-middle text-[12.5px] whitespace-nowrap xs:pl-3 xs:text-[13px]">
        <Delta value={metric.qoqPct} />
      </td>
      <td className="py-3 pl-2 text-right align-middle text-[12.5px] whitespace-nowrap xs:pl-3 xs:text-[13px]">
        <Delta value={metric.yoyPct} />
      </td>
    </tr>
  );
}

export function ResultsCard({ card, item }: { card: ResultsCardData; item: DigestItem }) {
  const xbrlRef = card.metrics[0]?.current.source?.ref;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-1.5">
        <Badge tone="outline">{card.periodLabel}</Badge>
        <Badge tone="outline">{card.basis}</Badge>
        {card.statementFamily !== "industrial" ? <Badge tone="outline">{card.statementFamily} format</Badge> : null}
        <Badge tone={card.audited ? "pos" : "neutral"}>{card.audited ? "Audited" : "Un-audited"}</Badge>
      </div>

      {card.status === "not_filed_yet" ? (
        <div className="rounded-2xl border border-dashed border-rule-strong px-5 py-6 text-center">
          <FileClock className="mx-auto size-6 text-ink-faint" aria-hidden />
          <p className="mt-3 font-display text-[24px] leading-tight text-ink">Numbers not filed yet</p>
          <p className="mx-auto mt-2 max-w-sm text-[13.5px] leading-relaxed text-ink-muted">
            The board has approved the results, but the XBRL with line items hasn&apos;t reached NSE. FINN never estimates figures — this card fills in
            when the filing lands.
          </p>
        </div>
      ) : null}

      {card.status === "under_review" ? (
        <Notice tone="amber" icon={<ShieldAlert className="size-4" />} title="Numbers under review">
          The filing failed FINN&apos;s internal identity checks (PBT, total income or year-to-date sums don&apos;t reconcile), so its figures are held back.
          Earlier quarters are unaffected.
        </Notice>
      ) : null}

      {card.status === "ready" && card.metrics.length > 0 ? (
        <table className="w-full border-collapse">
          <caption className="sr-only">
            {item.companyName} {card.periodLabel} results versus the previous quarter and the same quarter last year
          </caption>
          <thead>
            <tr className="kicker text-ink-faint">
              <th scope="col" className="pb-2 text-left font-normal">
                <span className="sr-only">Metric</span>
              </th>
              <th scope="col" className="pb-2 text-right font-normal whitespace-nowrap">
                {card.periodLabel}
              </th>
              <th scope="col" className="pb-2 text-right font-normal">
                QoQ
              </th>
              <th scope="col" className="pb-2 text-right font-normal">
                YoY
              </th>
            </tr>
          </thead>
          <tbody>
            {card.metrics.map((m) => (
              <MetricRow key={m.key} metric={m} itemId={item.id} definition={card.ebitdaDefinition} />
            ))}
          </tbody>
        </table>
      ) : null}

      {card.marginBps ? (
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 rounded-xl bg-white/[0.025] px-4 py-3">
          <span className="text-[13px] text-ink-muted">{card.marginBps.label}</span>
          <span className="font-mono text-[15px] text-ink tnum">{formatPlainPct(card.marginBps.current)}</span>
          <span className="flex gap-3 text-[12.5px]">
            <span className="text-ink-faint">
              QoQ <Delta value={card.marginBps.qoqBps} unit="bps" arrow={false} />
            </span>
            <span className="text-ink-faint">
              YoY <Delta value={card.marginBps.yoyBps} unit="bps" arrow={false} />
            </span>
          </span>
        </div>
      ) : null}

      {card.read ? <CardProse>{card.read}</CardProse> : null}

      {card.status === "ready" ? (
        <p className="font-mono text-[11px] leading-relaxed text-ink-faint [overflow-wrap:anywhere]">
          Source: NSE integrated filing (XBRL{xbrlRef ? ` · ${xbrlRef}` : ""}). QoQ and YoY use each quarter&apos;s own filing; consolidated basis
          throughout.
        </p>
      ) : null}
    </div>
  );
}
