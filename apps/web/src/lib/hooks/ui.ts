"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { animate, useInView, useReducedMotion } from "motion/react";

/** Current time, ticking every `intervalMs`; null during SSR so dates never mismatch on hydration. */
export function useNow(intervalMs = 60_000): Date | null {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function useDebounced<T>(value: T, delay = 250): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return debounced;
}

const seenCountUps = new Set<string>();

/**
 * Animates a number from 0 to `target` the first time it scrolls into view in this session.
 * Later renders (and reduced-motion users) see the final value immediately.
 */
export function useCountUp(target: number | null, key: string) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, margin: "-10% 0px" });
  const reduce = useReducedMotion();
  const [value, setValue] = useState<number | null>(() => (seenCountUps.has(key) ? target : target == null ? null : 0));

  useEffect(() => {
    if (target == null) return setValue(null);
    if (reduce || seenCountUps.has(key)) return setValue(target);
    if (!inView) return;
    seenCountUps.add(key);
    const controls = animate(0, target, { duration: 0.9, ease: [0.2, 0.7, 0.2, 1], onUpdate: setValue });
    return () => controls.stop();
  }, [inView, target, key, reduce]);

  return { ref, value };
}

function subscribeStorage(callback: () => void) {
  window.addEventListener("storage", callback);
  window.addEventListener("finn-storage", callback);
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener("finn-storage", callback);
  };
}

/** A tiny localStorage-backed string list (recent tickers etc.). */
export function useStoredList(key: string, max = 6) {
  const raw = useSyncExternalStore(
    subscribeStorage,
    () => window.localStorage.getItem(key) ?? "[]",
    () => "[]",
  );
  let list: string[] = [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) list = parsed.filter((v): v is string => typeof v === "string");
  } catch {
    /* ignore corrupt storage */
  }
  const push = (value: string) => {
    const next = [value, ...list.filter((v) => v !== value)].slice(0, max);
    window.localStorage.setItem(key, JSON.stringify(next));
    window.dispatchEvent(new Event("finn-storage"));
  };
  const clear = () => {
    window.localStorage.removeItem(key);
    window.dispatchEvent(new Event("finn-storage"));
  };
  return { list, push, clear };
}

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", cb);
      return () => mql.removeEventListener("change", cb);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}
