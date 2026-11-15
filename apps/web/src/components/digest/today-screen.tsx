"use client";

import type { DigestItem } from "@finn/shared";
import { useEffect, useMemo, useState } from "react";
import { PageColumns } from "@/components/layout/page";
import { ErrorState, ListSkeleton } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import type { DigestWindow } from "@/lib/api";
import { useDigest } from "@/lib/hooks/data";
import { useDismissals } from "@/lib/hooks/use-dismissals";
import { useNow } from "@/lib/hooks/ui";
import { DigestSection, NoiseSection } from "./digest-section";
import { CaughtUp, StaleBanner } from "./digest-states";
import { Masthead } from "./masthead";
import { TodayAside } from "./today-aside";

const WINDOW_LABEL: Record<DigestWindow, string> = { "24h": "the last 24 hours", "3d": "the last 3 days", "7d": "the last 7 days" };

export function TodayScreen() {
  const [window, setWindow] = useState<DigestWindow>("24h");
  const [focusId, setFocusId] = useState<string | null>(null);
  const { data, error, isLoading, isValidating, mutate } = useDigest(window);
  const { dismissed, dismiss, undo } = useDismissals();
  const toast = useToast();
  const now = useNow();

  useEffect(() => {
    const params = new URLSearchParams(globalThis.location.search);
    setFocusId(params.get("focus"));
    const w = params.get("window");
    if (w === "24h" || w === "3d" || w === "7d") setWindow(w);
  }, []);

  const visible = useMemo(() => {
    if (!data) return null;
    const keep = (items: DigestItem[]) => items.filter((i) => !dismissed.has(i.id));
    return { act: keep(data.act), know: keep(data.know), noise: keep(data.noise) };
  }, [data, dismissed]);

  const counts = visible ? { act: visible.act.length, know: visible.know.length, noise: visible.noise.length } : null;
  const stale = data?.sourceHealth.some((s) => s.stale) ?? false;
  const nothingMaterial = visible !== null && visible.act.length === 0 && visible.know.length === 0;

  const onDismiss = (item: DigestItem) => {
    dismiss(item.id);
    toast.show({ message: `Dismissed · ${item.symbol} ${item.headline}`, actionLabel: "Undo", onAction: () => undo(item.id) });
  };

  return (
    <PageColumns aside={<TodayAside />}>
      <Masthead
        digest={data}
        counts={counts}
        window={window}
        onWindowChange={setWindow}
        onRefresh={() => void mutate()}
        refreshing={isValidating}
        now={now}
      />

      {data ? <StaleBanner sources={data.sourceHealth} now={now} /> : null}

      {error && !data ? <ErrorState message={(error as Error).message} onRetry={() => void mutate()} /> : null}
      {isLoading && !data ? <ListSkeleton rows={4} /> : null}

      {visible ? (
        <div className={isValidating && !isLoading ? "opacity-80 transition-opacity" : "transition-opacity"}>
          {nothingMaterial && data?.caughtUp && !stale ? <CaughtUp noiseCount={visible.noise.length} windowLabel={WINDOW_LABEL[window]} /> : null}
          {nothingMaterial && stale ? (
            <p className="mt-10 text-center text-[14.5px] text-ink-muted">Nothing material in what FINN has so far — but the feed is behind, so check back.</p>
          ) : null}
          <DigestSection tier="act" items={visible.act} now={now} onDismiss={onDismiss} focusId={focusId} />
          <DigestSection tier="know" items={visible.know} now={now} onDismiss={onDismiss} focusId={focusId} />
          <NoiseSection items={visible.noise} now={now} onDismiss={onDismiss} focusId={focusId} />
          <p className="mt-12 text-center font-mono text-[11px] leading-relaxed text-ink-faint">
            Ranked by category, size and your past dismissals. Every card shows why it&apos;s here.
          </p>
        </div>
      ) : null}
    </PageColumns>
  );
}
