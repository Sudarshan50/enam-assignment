import { cn } from "@/lib/cn";

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("font-display leading-none tracking-[-0.01em] text-ink", className)}>
      FINN<span className="text-act">.</span>
    </span>
  );
}
