import { cn } from "@/lib/cn";

export interface Stage {
  name: string;
  detail: string;
}

/** A row of numbered stages on wide screens, a vertical rail on phones. */
export function Pipeline({ title, kicker, stages, accent }: { title: string; kicker: string; stages: Stage[]; accent: string }) {
  return (
    <section className="mt-10" aria-label={title}>
      <p className="kicker flex items-center gap-2 text-ink-faint">
        <span aria-hidden className="inline-block size-[7px] rounded-[1.5px]" style={{ background: accent }} />
        {kicker}
      </p>
      <h3 className="mt-1 font-display text-[26px] leading-tight text-ink">{title}</h3>
      <ol className="relative mt-5 grid gap-0 sm:grid-cols-5 sm:gap-3">
        {stages.map((s, i) => (
          <li key={s.name} className="relative flex gap-4 pb-5 last:pb-0 sm:flex-col sm:gap-3 sm:pb-0">
            {i < stages.length - 1 ? (
              <>
                <span aria-hidden className="absolute top-8 bottom-0 left-[15px] w-px bg-rule-strong sm:hidden" />
                <span aria-hidden className="absolute top-[15px] right-[-12px] left-8 hidden h-px bg-rule-strong sm:block">
                  <span className="finn-flow absolute -top-[2px] size-[5px] rounded-full" style={{ background: accent, animationDelay: `${i * 0.5}s` }} />
                </span>
              </>
            ) : null}
            <span
              className={cn("relative z-10 flex size-8 shrink-0 items-center justify-center rounded-full border bg-paper font-mono text-[11px] tnum")}
              style={{ borderColor: accent, color: accent }}
            >
              {String(i + 1).padStart(2, "0")}
            </span>
            <div className="min-w-0 pt-1 sm:pt-0">
              <p className="text-[15px] font-medium text-ink">{s.name}</p>
              <p className="mt-1 text-[12.5px] leading-relaxed text-ink-muted">{s.detail}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
