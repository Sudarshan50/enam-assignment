import { BullBearPayloadSchema, type Claim } from "@finn/shared";
import type { z } from "zod";
import { ClaimLine } from "./claim";

type BullBear = z.output<typeof BullBearPayloadSchema>;

function Case({ title, claims, color }: { title: string; claims: Claim[]; color: string }) {
  return (
    <div>
      <div className="flex items-center gap-2 border-b border-rule pb-2">
        <span aria-hidden className="inline-block size-[7px] rounded-[1.5px]" style={{ background: color }} />
        <h3 className="kicker text-ink-muted">{title}</h3>
      </div>
      <ol className="mt-1">
        {claims.map((c, i) => (
          <li key={c.text} className="flex gap-3 border-b border-rule py-4 last:border-b-0">
            <span className="w-5 shrink-0 font-display text-[22px] leading-none text-ink-faint">{i + 1}</span>
            <ClaimLine claim={c} as="span" className="text-[15px]" />
          </li>
        ))}
      </ol>
    </div>
  );
}

export function BullBearView({ data }: { data: BullBear }) {
  return (
    <div className="grid gap-8 md:grid-cols-2 md:gap-10">
      <Case title="The bull case" claims={data.bull} color="var(--color-pos)" />
      <Case title="The bear case" claims={data.bear} color="var(--color-neg)" />
    </div>
  );
}
