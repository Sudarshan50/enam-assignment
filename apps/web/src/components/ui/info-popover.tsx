"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";

/** A tap-or-click explanation bubble: works on touch, keyboard (Enter/Esc) and mouse. */
export function InfoPopover({ trigger, children, label, align = "left" }: { trigger: ReactNode; children: ReactNode; label: string; align?: "left" | "right" }) {
  const [open, setOpen] = useState(false);
  const [shift, setShift] = useState(0);
  const id = useId();
  const root = useRef<HTMLSpanElement>(null);
  const bubble = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    if (!open || !bubble.current) return setShift(0);
    const r = bubble.current.getBoundingClientRect();
    const margin = 12;
    const vw = document.documentElement.clientWidth;
    setShift(r.right > vw - margin ? vw - margin - r.right : r.left < margin ? margin - r.left : 0);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <span ref={root} className="relative inline-flex">
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={id}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="relative inline-flex items-center rounded-full outline-offset-2 before:absolute before:-inset-x-1.5 before:-inset-y-2.5 before:content-['']"
      >
        {trigger}
      </button>
      <AnimatePresence>
        {open ? (
          <motion.span
            ref={bubble}
            style={{ x: shift }}
            id={id}
            role="tooltip"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            transition={{ duration: 0.16 }}
            onClick={(e) => e.stopPropagation()}
            className={cn(
              "absolute top-[calc(100%+8px)] z-40 block w-[min(18rem,calc(100vw-3rem))] rounded-xl border border-rule-strong bg-paper-high p-3.5 text-left font-sans text-[13px] leading-relaxed font-normal tracking-normal normal-case text-ink-muted shadow-[0_18px_50px_rgba(0,0,0,0.55)]",
              align === "left" ? "left-0" : "right-0",
            )}
          >
            {children}
          </motion.span>
        ) : null}
      </AnimatePresence>
    </span>
  );
}
