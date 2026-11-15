"use client";

import { useCountUp } from "@/lib/hooks/ui";

/** Renders `format(value)` and counts up from zero on the first view in a session. */
export function CountUp({ value, format, id, className }: { value: number | null; format: (v: number | null) => string; id: string; className?: string }) {
  const { ref, value: shown } = useCountUp(value, id);
  return (
    <span ref={ref} className={className}>
      <span className="sr-only">{format(value)}</span>
      <span aria-hidden>{format(shown)}</span>
    </span>
  );
}
