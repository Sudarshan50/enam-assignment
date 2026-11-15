"use client";

import { motion } from "motion/react";
import { cn } from "@/lib/cn";

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="group inline-flex min-h-11 min-w-11 items-center justify-center disabled:opacity-40"
    >
      <span
        className={cn(
          "relative flex h-[26px] w-[44px] items-center rounded-full border p-[3px] transition-colors duration-200",
          checked ? "justify-end border-transparent bg-pos/80" : "justify-start border-rule-strong bg-white/[0.04]",
        )}
      >
        <motion.span layout transition={{ type: "spring", stiffness: 600, damping: 35 }} className={cn("size-[18px] rounded-full", checked ? "bg-paper" : "bg-ink-faint")} />
      </span>
    </button>
  );
}
