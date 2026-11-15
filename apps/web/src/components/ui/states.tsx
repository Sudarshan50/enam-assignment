import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden className={cn("finn-skeleton block", className)} />;
}

export function ListSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="divide-y divide-rule" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="space-y-3 py-5">
          <Skeleton className="h-3 w-32" />
          <Skeleton className="h-5 w-[85%]" />
          <Skeleton className="h-3 w-[60%]" />
        </div>
      ))}
    </div>
  );
}

export function Notice({
  tone = "neutral",
  title,
  children,
  icon,
  action,
  className,
}: {
  tone?: "neutral" | "amber" | "neg";
  title: string;
  children?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  const toneCls = tone === "amber" ? "border-amber/30 bg-amber-soft" : tone === "neg" ? "border-neg/30 bg-neg-soft" : "border-rule-strong bg-white/[0.02]";
  const iconCls = tone === "amber" ? "text-amber" : tone === "neg" ? "text-neg" : "text-ink-faint";
  return (
    <div className={cn("flex gap-3 rounded-2xl border px-4 py-3.5", toneCls, className)} role={tone === "neutral" ? undefined : "status"}>
      {icon ? <span className={cn("mt-0.5 shrink-0", iconCls)}>{icon}</span> : null}
      <div className="min-w-0 flex-1">
        <p className="text-[14px] font-medium text-ink">{title}</p>
        {children ? <div className="mt-1 text-[13px] leading-relaxed text-ink-muted">{children}</div> : null}
        {action ? <div className="mt-2.5">{action}</div> : null}
      </div>
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <Notice
      tone="neg"
      title="Couldn't load this"
      action={
        onRetry ? (
          <button type="button" onClick={onRetry} className="min-h-11 text-[13px] font-medium text-ink underline decoration-rule-strong underline-offset-4 hover:decoration-ink">
            Try again
          </button>
        ) : null
      }
    >
      {message}
    </Notice>
  );
}
