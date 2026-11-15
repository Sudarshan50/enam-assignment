"use client";

import { AnimatePresence, motion } from "motion/react";
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";

interface ToastInput {
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  durationMs?: number;
}

interface ToastState extends ToastInput {
  id: number;
}

const ToastContext = createContext<{ show: (toast: ToastInput) => void } | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ToastState | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seq = useRef(0);

  const dismiss = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    setToast(null);
  }, []);

  const show = useCallback(
    (input: ToastInput) => {
      if (timer.current) clearTimeout(timer.current);
      seq.current += 1;
      setToast({ ...input, id: seq.current });
      timer.current = setTimeout(dismiss, input.durationMs ?? 5000);
    },
    [dismiss],
  );

  const value = useMemo(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-[calc(76px+env(safe-area-inset-bottom))] z-[70] flex justify-center px-4 lg:bottom-8"
      >
        <AnimatePresence>
          {toast ? (
            <motion.div
              key={toast.id}
              initial={{ opacity: 0, y: 16, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.98 }}
              transition={{ type: "spring", stiffness: 420, damping: 34 }}
              className="pointer-events-auto flex min-h-12 max-w-md items-center gap-3 rounded-full border border-rule-strong bg-paper-high/95 py-1.5 pr-1.5 pl-5 text-sm text-ink shadow-[0_16px_48px_rgba(0,0,0,0.5)] backdrop-blur"
              role="status"
            >
              <span className="min-w-0 truncate">{toast.message}</span>
              {toast.actionLabel ? (
                <button
                  type="button"
                  onClick={() => {
                    toast.onAction?.();
                    dismiss();
                  }}
                  className="min-h-10 shrink-0 rounded-full bg-ink px-4 text-[13px] font-medium text-paper hover:bg-white"
                >
                  {toast.actionLabel}
                </button>
              ) : null}
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}
