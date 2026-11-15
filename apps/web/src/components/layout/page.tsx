import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/** Reading column with an optional desktop-only aside (the second column of the 2-column layout). */
export function PageColumns({ children, aside, className, wide }: { children: ReactNode; aside?: ReactNode; className?: string; wide?: boolean }) {
  return (
    <div className={cn("mx-auto w-full px-5 pt-5 sm:px-8 lg:px-12 lg:pt-12", aside ? "max-w-[1120px]" : wide ? "max-w-[980px]" : "max-w-[780px]", className)}>
      {aside ? (
        <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_300px] lg:gap-14">
          <div className="min-w-0">{children}</div>
          <aside className="hidden lg:sticky lg:top-12 lg:block lg:self-start">{aside}</aside>
        </div>
      ) : (
        children
      )}
    </div>
  );
}

export function PageTitle({ kicker, title, children }: { kicker: string; title: ReactNode; children?: ReactNode }) {
  return (
    <header className="pt-2">
      <p className="kicker text-ink-faint">{kicker}</p>
      <div className="mt-3 h-px bg-rule-strong" aria-hidden />
      <h1 className="mt-5 font-display text-[42px] leading-[1] tracking-[-0.02em] text-ink text-balance sm:text-[52px]">{title}</h1>
      {children ? <div className="mt-3 max-w-xl text-[15px] leading-relaxed text-ink-muted text-pretty">{children}</div> : null}
    </header>
  );
}
