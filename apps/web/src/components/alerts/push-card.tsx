"use client";

import { BellOff, BellRing, Share } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { usePush } from "@/lib/hooks/use-push";

const COPY: Record<string, { title: string; body: string }> = {
  "ios-needs-install": {
    title: "Install FINN to get alerts on iPhone",
    body: "iOS only delivers web notifications to apps on the Home Screen. Tap Share, then “Add to Home Screen”, and open FINN from there. Everything else works without it.",
  },
  unsupported: { title: "This browser can't receive push", body: "Alerts still collect here and on Today; you just won't get a buzz." },
  denied: { title: "Notifications are blocked", body: "You blocked them for this site. Re-enable in your browser's site settings, then come back." },
  off: { title: "Alerts on this device", body: "One notification per rule per session — batched, never a storm." },
  on: { title: "Alerts on this device", body: "On. You'll hear only about the rules below." },
  working: { title: "Alerts on this device", body: "Asking your browser…" },
  checking: { title: "Alerts on this device", body: " " },
};

export function PushCard() {
  const { state, error, enable, disable } = usePush();
  const copy = COPY[state]!;
  const toggleable = state === "on" || state === "off" || state === "working";
  const Icon = state === "denied" || state === "unsupported" ? BellOff : state === "ios-needs-install" ? Share : BellRing;

  return (
    <div className="mt-8 flex items-start gap-3.5 rounded-2xl border border-rule-strong bg-white/[0.02] p-4">
      <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-amber-soft text-amber">
        <Icon className="size-[17px]" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[14.5px] font-medium text-ink">{copy.title}</p>
        <p className="mt-1 text-[13px] leading-relaxed text-ink-muted">{copy.body}</p>
        {error ? <p className="mt-1.5 text-[12.5px] text-neg">{error}</p> : null}
        {state === "off" ? (
          <Button size="sm" variant="primary" className="mt-3" onClick={() => void enable()}>
            Turn on notifications
          </Button>
        ) : null}
      </div>
      {toggleable && state !== "off" ? (
        <Switch checked={state === "on"} disabled={state === "working"} onChange={(v) => void (v ? enable() : disable())} label="Push notifications" />
      ) : null}
    </div>
  );
}
