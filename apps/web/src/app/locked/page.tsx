import type { Metadata } from "next";
import { BRAND, MONOGRAM_DOT, MONOGRAM_F_PATH } from "@/lib/brand";

export const metadata: Metadata = { title: "Private demo" };

export default function LockedPage() {
  return (
    <main className="relative z-10 flex min-h-dvh flex-col items-center justify-center px-8 text-center">
      <svg width="88" height="88" viewBox="0 0 512 512" aria-hidden>
        <path d={MONOGRAM_F_PATH} fill={BRAND.ink} />
        <circle cx={MONOGRAM_DOT.cx} cy={MONOGRAM_DOT.cy} r={MONOGRAM_DOT.r} fill={BRAND.act} />
      </svg>
      <div className="mt-10 h-px w-16 bg-rule-strong" aria-hidden />
      <p className="kicker mt-10 text-ink-faint">FINN · Private demo</p>
      <h1 className="mt-4 max-w-md font-display text-[44px] leading-[1.02] tracking-[-0.02em] text-ink text-balance">This is a private demo.</h1>
      <p className="mt-4 max-w-sm text-[15px] leading-relaxed text-ink-muted text-pretty">
        Open the link you were sent — it carries a private key that unlocks FINN on this device for 30 days.
      </p>
      <p className="absolute bottom-[max(2rem,env(safe-area-inset-bottom))] font-mono text-[10.5px] text-ink-faint">
        NSE filings · annual reports · concall transcripts
      </p>
    </main>
  );
}
