"use client";

import type { ResearchModule } from "@finn/shared";
import { motion } from "motion/react";
import { CircleDashed, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import type { z } from "zod";
import { Skeleton, Notice } from "@/components/ui/states";

export function ModuleFrame<S extends z.ZodType>({
  index,
  title,
  subtitle,
  module,
  schema,
  children,
}: {
  index: number;
  title: string;
  subtitle: string;
  module: ResearchModule | undefined;
  schema: S;
  children: (payload: z.output<S>) => ReactNode;
}) {
  const status = module?.status ?? "pending";
  let body: ReactNode;
  if (status === "done") {
    const parsed = schema.safeParse(module?.payload);
    body = parsed.success ? (
      children(parsed.data)
    ) : (
      <Notice tone="neg" icon={<TriangleAlert className="size-4" />} title="This module came back in an unexpected shape">
        It was hidden rather than shown half-parsed.
      </Notice>
    );
  } else if (status === "failed") {
    body = (
      <Notice tone="neg" icon={<TriangleAlert className="size-4" />} title="This module failed">
        {module?.error ?? "The rest of the research is unaffected. Rebuild to retry."}
      </Notice>
    );
  } else if (status === "insufficient_sources") {
    body = (
      <Notice icon={<CircleDashed className="size-4" />} title="Not enough source material">
        {module?.error ?? "FINN found too little in the annual reports and transcripts to say anything grounded here, so it says nothing."}
      </Notice>
    );
  } else {
    body = (
      <div className="space-y-3" aria-busy="true">
        <p className="flex items-center gap-2 font-mono text-[11px] text-ink-faint">
          <span className="finn-pulse inline-block size-1.5 rounded-full bg-amber" aria-hidden />
          {status === "running" ? "Building from the documents…" : "Waiting for documents…"}
        </p>
        <Skeleton className="h-6 w-[70%]" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-[85%]" />
      </div>
    );
  }

  return (
    <motion.section
      id={module?.key}
      aria-labelledby={`${module?.key ?? title}-title`}
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: [0.2, 0.7, 0.2, 1] }}
      className="mt-14 scroll-mt-20 first:mt-10"
    >
      <div className="flex items-baseline gap-3 border-b border-rule-strong pb-3">
        <span className="font-mono text-[11px] text-ink-faint tnum">{String(index).padStart(2, "0")}</span>
        <h2 id={`${module?.key ?? title}-title`} className="font-display text-[32px] leading-none tracking-[-0.01em] text-ink">
          {title}
        </h2>
      </div>
      <p className="mt-2.5 text-[13.5px] text-ink-faint">{subtitle}</p>
      <div className="mt-6">{body}</div>
    </motion.section>
  );
}
