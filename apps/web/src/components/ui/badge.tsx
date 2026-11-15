import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export type Tone = "neutral" | "act" | "know" | "noise" | "pos" | "neg" | "amber" | "outline";

const tones: Record<Tone, string> = {
  neutral: "bg-white/[0.05] text-ink-muted",
  act: "bg-act-soft text-act",
  know: "bg-know-soft text-know",
  noise: "bg-noise-soft text-noise",
  pos: "bg-pos-soft text-pos",
  neg: "bg-neg-soft text-neg",
  amber: "bg-amber-soft text-amber",
  outline: "border border-rule-strong text-ink-faint",
};

export function Badge({ tone = "neutral", children, className, icon }: { tone?: Tone; children: ReactNode; className?: string; icon?: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center gap-1 rounded-full px-2.5 font-mono text-[10.5px] font-medium uppercase tracking-[0.08em] whitespace-nowrap",
        tones[tone],
        className,
      )}
    >
      {icon}
      {children}
    </span>
  );
}

/** Monospace ticker chip used next to company names. */
export function SymbolChip({ symbol, className }: { symbol: string; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-[22px] items-center rounded-[5px] border border-rule-strong px-1.5 font-mono text-[11px] font-semibold tracking-[0.04em] text-ink",
        className,
      )}
    >
      {symbol}
    </span>
  );
}

/** Quiet reason-code chip. */
export function ReasonChip({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex h-[22px] items-center rounded-full border border-rule px-2 font-mono text-[10.5px] tracking-[0.02em] text-ink-faint whitespace-nowrap">
      {children}
    </span>
  );
}
