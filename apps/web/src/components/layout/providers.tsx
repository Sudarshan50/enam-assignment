"use client";

import { MotionConfig } from "motion/react";
import { useEffect, type ReactNode } from "react";
import { SWRConfig } from "swr";
import { ApiError } from "@/lib/api";
import { CitationProvider } from "@/components/research/citation-sheet";
import { ToastProvider } from "@/components/ui/toast";

function useServiceWorker() {
  useEffect(() => {
    if (!("serviceWorker" in navigator) || process.env.NODE_ENV !== "production") return;
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {});
  }, []);
}

export function Providers({ children }: { children: ReactNode }) {
  useServiceWorker();
  return (
    <SWRConfig
      value={{
        revalidateOnFocus: true,
        dedupingInterval: 4000,
        shouldRetryOnError: (error: unknown) => !(error instanceof ApiError && error.status >= 400 && error.status < 500),
        errorRetryCount: 3,
      }}
    >
      <MotionConfig reducedMotion="user">
        <ToastProvider>
          <CitationProvider>{children}</CitationProvider>
        </ToastProvider>
      </MotionConfig>
    </SWRConfig>
  );
}
