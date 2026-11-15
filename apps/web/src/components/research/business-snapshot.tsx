import { BusinessSnapshotPayloadSchema } from "@finn/shared";
import type { z } from "zod";
import { formatPlainPct } from "@/lib/format";
import { ClaimLine, CitationChips } from "./claim";

type Business = z.output<typeof BusinessSnapshotPayloadSchema>;

const SHADES = [0.88, 0.62, 0.42, 0.27, 0.15];

export function BusinessSnapshot({ data }: { data: Business }) {
  const total = data.segments.reduce((s, x) => s + (x.sharePct ?? 0), 0) || 1;
  return (
    <div className="space-y-6">
      {data.description ? <ClaimLine claim={data.description} className="font-display text-[21px] leading-[1.4]" /> : null}
      {data.segments.length ? (
        <div>
          <p className="kicker text-ink-faint">Revenue mix</p>
          <div className="mt-2.5 flex h-3 overflow-hidden rounded-full" role="img" aria-label="Revenue mix by segment">
            {data.segments.map((s, i) => (
              <span key={s.name} style={{ width: `${((s.sharePct ?? 0) / total) * 100}%`, background: `rgb(236 230 218 / ${SHADES[i % SHADES.length]})` }} className="h-full border-r border-paper last:border-r-0" />
            ))}
          </div>
          <ul className="mt-4 divide-y divide-rule">
            {data.segments.map((s, i) => (
              <li key={s.name} className="flex items-center gap-3 py-2.5">
                <span aria-hidden className="size-2.5 shrink-0 rounded-[2px]" style={{ background: `rgb(236 230 218 / ${SHADES[i % SHADES.length]})` }} />
                <span className="min-w-0 flex-1 text-[14px] text-ink">{s.name}</span>
                <CitationChips citations={s.claim.citations} claim={s.claim.text} />
                <span className="w-12 text-right font-mono text-[13px] text-ink-muted tnum">{formatPlainPct(s.sharePct, 0)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
