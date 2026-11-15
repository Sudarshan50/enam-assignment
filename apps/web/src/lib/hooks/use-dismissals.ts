"use client";

import { useCallback, useEffect, useState } from "react";
import { digestApi } from "@/lib/api";

const KEY = "finn:dismissed";
const MAX = 400;

export type DismissalAction = { type: "dismiss" | "undo"; id: string };

/** Pure transition for the dismissed-id set; never mutates `state`. */
export function dismissalsReducer(state: ReadonlySet<string>, action: DismissalAction): Set<string> {
  const next = new Set(state);
  if (action.type === "dismiss") next.add(action.id);
  else next.delete(action.id);
  return next;
}

/** Reads the persisted list, tolerating junk from older versions or manual edits. */
export function parseDismissals(raw: string | null): string[] {
  try {
    const parsed: unknown = JSON.parse(raw ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/** Keeps the most recent MAX ids (Sets iterate in insertion order). */
export function serializeDismissals(ids: ReadonlySet<string>, max = MAX): string {
  return JSON.stringify([...ids].slice(-max));
}

/** Optimistic, locally persisted dismissals; the server is told so it can learn mutes later. */
export function useDismissals() {
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());

  useEffect(() => setDismissed(new Set(parseDismissals(window.localStorage.getItem(KEY)))), []);

  const apply = useCallback((action: DismissalAction) => {
    setDismissed((prev) => {
      const next = dismissalsReducer(prev, action);
      window.localStorage.setItem(KEY, serializeDismissals(next));
      return next;
    });
    void digestApi.recordInteraction(action.id, action.type === "dismiss" ? "dismiss" : "undo_dismiss").catch(() => {});
  }, []);

  const dismiss = useCallback((id: string) => apply({ type: "dismiss", id }), [apply]);
  const undo = useCallback((id: string) => apply({ type: "undo", id }), [apply]);

  return { dismissed, dismiss, undo };
}
