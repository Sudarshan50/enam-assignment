"use client";

import { useCallback, useEffect, useState } from "react";
import { digestApi } from "@/lib/api";

const KEY = "finn:dismissed";
const MAX = 400;

function read(): string[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/** Optimistic, locally persisted dismissals; the server is told so it can learn mutes later. */
export function useDismissals() {
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());

  useEffect(() => setDismissed(new Set(read())), []);

  const persist = (next: Set<string>) => {
    window.localStorage.setItem(KEY, JSON.stringify([...next].slice(-MAX)));
    return next;
  };

  const dismiss = useCallback((id: string) => {
    setDismissed((prev) => persist(new Set(prev).add(id)));
    void digestApi.recordInteraction(id, "dismiss").catch(() => {});
  }, []);

  const undo = useCallback((id: string) => {
    setDismissed((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return persist(next);
    });
    void digestApi.recordInteraction(id, "undo_dismiss").catch(() => {});
  }, []);

  return { dismissed, dismiss, undo };
}
