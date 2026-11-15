import { CashQualityPayloadSchema } from "@finn/shared";
import type { z } from "zod";
import { formatInr } from "@/lib/format";
import { cn } from "@/lib/cn";
import { ClaimLine } from "./claim";

type Cash = z.output<typeof CashQualityPayloadSchema>;
type Period = Cash["periods"][number];

const ROWS: Array<{ key: keyof Period; label: string; kind: "inr" | "x" | "de" }> = [
  { key: "cfo", label: "Cash from ops", kind: "inr" },
  { key: "pat", label: "PAT", kind: "inr" },
  { key: "cashConversion", label: "Conversion", kind: "x" },
  { key: "capex", label: "Capex", kind: "inr" },
  { key: "fcf", label: "Free cash flow", kind: "inr" },
  { key: "debtToEquity", label: "Debt / equity", kind: "de" },
];

function cell(value: unknown, kind: "inr" | "x" | "de"): string {
  if (typeof value !== "number") return "n/m";
  if (kind === "inr") return formatInr(value, { compact: true });
  return `${value.toFixed(2)}×`;
}

export function CashQuality({ data }: { data: Cash }) {
  const notes = data.periods.filter((p) => p.note);
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-3 gap-2">
        {data.periods.map((p) => {
          const c = p.cashConversion;
          const pct = c == null ? 0 : Math.min(1.4, Math.max(0, c)) / 1.4;
          return (
            <div key={p.period} className="rounded-xl border border-rule px-3 py-3">
              <p className="kicker text-ink-faint">{p.period}</p>
              <p className={cn("mt-1 font-mono text-[20px] tnum", c == null ? "text-ink-faint" : c >= 0.9 ? "text-pos" : c >= 0.7 ? "text-amber" : "text-neg")}>
                {c == null ? "n/m" : `${c.toFixed(2)}×`}
              </p>
              <div className="relative mt-2 h-1 rounded-full bg-white/[0.06]" aria-hidden>
                <div className="absolute inset-y-0 left-0 rounded-full bg-current text-ink-muted" style={{ width: `${pct * 100}%` }} />
                <div className="absolute -top-1 -bottom-1 w-px bg-ink-faint" style={{ left: `${(1 / 1.4) * 100}%` }} />
              </div>
            </div>
          );
        })}
      </div>
      <p className="-mt-3 font-mono text-[10.5px] text-ink-faint">Cash from operations ÷ PAT. The tick marks 1.0×. Half-year and full-year only — matched periods.</p>

      <div className="-mx-5 overflow-x-auto px-5">
        <table className="w-full min-w-[320px] border-collapse text-[13px]">
          <caption className="sr-only">Cash quality by period</caption>
          <thead>
            <tr className="kicker text-ink-faint">
              <th scope="col" className="pb-2 text-left font-normal">
                <span className="sr-only">Measure</span>
              </th>
              {data.periods.map((p) => (
                <th key={p.period} scope="col" className="pb-2 text-right font-normal">
                  {p.period}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ROWS.map((r) => (
              <tr key={r.key} className="border-t border-rule">
                <th scope="row" className="py-2.5 pr-2 text-left font-normal text-ink-muted">
                  {r.label}
                </th>
                {data.periods.map((p) => (
                  <td key={p.period} className="py-2.5 pl-2 text-right font-mono text-ink tnum whitespace-nowrap">
                    {cell(p[r.key], r.kind)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {notes.map((p) => (
        <p key={p.period} className="font-mono text-[10.5px] text-ink-faint">
          {p.period}: {p.note}
        </p>
      ))}

      {data.takeaways.length ? (
        <ul className="space-y-3 border-t border-rule pt-5 text-[15px]">
          {data.takeaways.map((c) => (
            <ClaimLine key={c.text} claim={c} as="li" />
          ))}
        </ul>
      ) : null}
    </div>
  );
}
