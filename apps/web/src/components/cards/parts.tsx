import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export function Facts({ children, className }: { children: ReactNode; className?: string }) {
  return <dl className={cn("grid grid-cols-2 gap-x-5 gap-y-4", className)}>{children}</dl>;
}

export function Fact({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={cn("min-w-0", wide && "col-span-2")}>
      <dt className="kicker text-ink-faint">{label}</dt>
      <dd className="mt-1 text-[15px] leading-snug text-ink">{children ?? <span className="text-ink-faint">—</span>}</dd>
    </div>
  );
}

export function CardProse({ children, label = "FINN's read" }: { children: ReactNode; label?: string }) {
  return (
    <div className="border-l-2 border-amber/50 pl-4">
      <p className="kicker text-amber/90">{label}</p>
      <p className="mt-1.5 font-display text-[19px] leading-[1.35] text-ink">{children}</p>
    </div>
  );
}

export function formatIsoDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(`${iso.slice(0, 10)}T00:00:00+05:30`);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" }).format(d);
}
