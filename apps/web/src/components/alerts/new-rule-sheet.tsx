"use client";

import type { AlertRule } from "@finn/shared";
import { AnimatePresence, motion } from "motion/react";
import { Sparkles } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { Notice } from "@/components/ui/states";
import { alertsApi, type Backtest, type RulePreview } from "@/lib/api";
import { cn } from "@/lib/cn";
import { istDateShort } from "@/lib/format";
import { describeScope, describeTrigger } from "./describe";

const EXAMPLES = ["Tell me if any bank falls more than 3%", "Volume above 2.5× on DIXON or POLYCAB", "Any management change or M&A"];

/** 30 sessions as ticks; sessions where the rule would have fired are lit. */
function BacktestStrip({ backtest }: { backtest: Backtest }) {
  const today = Date.now();
  const lit = new Set(
    backtest.hits.map((h) => {
      const days = (today - new Date(h.date).getTime()) / 86_400_000;
      return Math.max(0, Math.min(backtest.sessions - 1, backtest.sessions - 1 - Math.round((days * 5) / 7)));
    }),
  );
  return (
    <div className="flex h-8 items-end gap-[3px]" role="img" aria-label={`Fired ${backtest.fires} times in the last ${backtest.sessions} sessions`}>
      {Array.from({ length: backtest.sessions }, (_, i) => (
        <motion.span
          key={i}
          initial={{ scaleY: 0 }}
          animate={{ scaleY: 1 }}
          transition={{ delay: i * 0.012 }}
          className={cn("w-full origin-bottom rounded-[1px]", lit.has(i) ? "h-8 bg-amber" : "h-3 bg-white/10")}
        />
      ))}
    </div>
  );
}

function PreviewView({ preview }: { preview: RulePreview }) {
  if (!preview.definition) {
    return (
      <Notice tone="amber" title="Couldn't turn that into a rule" className="mt-5">
        {preview.explanation}
      </Notice>
    );
  }
  const t = describeTrigger(preview.definition);
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="mt-6 space-y-5">
      <dl className="divide-y divide-rule rounded-2xl border border-rule-strong">
        {[
          ["Watch", describeScope(preview.definition.scope)],
          ["When it", t.when],
          ["Threshold", t.threshold],
        ].map(([k, v]) => (
          <div key={k} className="flex items-baseline gap-4 px-4 py-3">
            <dt className="kicker w-24 shrink-0 text-ink-faint">{k}</dt>
            <dd className="min-w-0 text-[14.5px] text-ink">{v}</dd>
          </div>
        ))}
      </dl>
      {preview.resolvedSymbols.length > 0 && preview.resolvedSymbols.length < 18 ? (
        <p className="font-mono text-[11px] text-ink-faint">Resolves to: {preview.resolvedSymbols.join(", ")}</p>
      ) : null}
      <p className="text-[13.5px] leading-relaxed text-ink-muted">{preview.explanation}</p>
      {preview.backtest ? (
        <div className="rounded-2xl bg-white/[0.025] p-4">
          <p className="text-[14px] text-ink">
            Would have fired <span className="font-mono text-amber">{preview.backtest.fires}</span> {preview.backtest.fires === 1 ? "time" : "times"} in the last{" "}
            {preview.backtest.sessions} sessions.
          </p>
          <div className="mt-3">
            <BacktestStrip backtest={preview.backtest} />
          </div>
          {preview.backtest.hits.length ? (
            <ul className="mt-3 space-y-1">
              {preview.backtest.hits.map((h) => (
                <li key={`${h.date}-${h.symbol}`} className="flex justify-between gap-3 font-mono text-[11.5px] text-ink-muted">
                  <span>
                    {istDateShort(h.date)} · {h.symbol}
                  </span>
                  <span>{h.detail}</span>
                </li>
              ))}
            </ul>
          ) : preview.backtest.fires === 0 ? (
            <p className="mt-2 text-[12.5px] text-ink-faint">Quiet over this period — a sign the threshold is meaningful, or too strict.</p>
          ) : null}
          {preview.backtest.note ? <p className="mt-2 text-[12.5px] text-ink-faint">{preview.backtest.note}</p> : null}
        </div>
      ) : null}
    </motion.div>
  );
}

export function NewRuleSheet({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: (rule: AlertRule) => void }) {
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<RulePreview | null>(null);
  const [busy, setBusy] = useState<"preview" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setText("");
      setPreview(null);
      setError(null);
    }
  }, [open]);

  const runPreview = async (value = text) => {
    if (value.trim().length < 3) return;
    setBusy("preview");
    setError(null);
    try {
      setPreview(await alertsApi.previewRule(value.trim()));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    if (!preview?.definition) return;
    setBusy("save");
    try {
      const name = (preview.name ?? text.trim()).slice(0, 80);
      onSaved(await alertsApi.createRule({ name, definition: preview.definition }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void runPreview();
  };

  return (
    <Sheet open={open} onClose={onClose} kicker="New rule" title="Describe what's unusual">
      <form onSubmit={onSubmit}>
        <label htmlFor="rule-text" className="sr-only">
          Describe the rule in plain words
        </label>
        <textarea
          id="rule-text"
          rows={3}
          value={text}
          maxLength={300}
          onChange={(e) => {
            setText(e.target.value);
            setPreview(null);
          }}
          placeholder="e.g. Tell me if TCS falls more than 3% in a day"
          className="w-full resize-none rounded-2xl border border-rule-strong bg-paper px-4 py-3.5 font-display text-[20px] leading-snug text-ink placeholder:text-ink-faint focus:border-ink-faint focus:outline-none"
        />
        <div className="mt-3 flex flex-wrap gap-2">
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              type="button"
              onClick={() => {
                setText(ex);
                void runPreview(ex);
              }}
              className="min-h-9 rounded-full border border-rule px-3 text-[12.5px] text-ink-muted hover:border-rule-strong hover:text-ink"
            >
              {ex}
            </button>
          ))}
        </div>
        {error ? <p className="mt-3 text-[13px] text-neg">{error}</p> : null}
        <AnimatePresence>{preview ? <PreviewView key="preview" preview={preview} /> : null}</AnimatePresence>
        <div className="mt-6 flex gap-2">
          {preview?.definition ? (
            <>
              <Button variant="primary" className="flex-1" onClick={() => void save()} disabled={busy !== null}>
                {busy === "save" ? "Saving…" : "Save rule"}
              </Button>
              <Button type="submit" disabled={busy !== null}>
                Re-read
              </Button>
            </>
          ) : (
            <Button type="submit" variant="primary" className="flex-1" disabled={busy !== null || text.trim().length < 3} icon={<Sparkles className="size-4" aria-hidden />}>
              {busy === "preview" ? "Reading…" : "Preview rule"}
            </Button>
          )}
        </div>
        <p className="mt-3 text-center font-mono text-[10.5px] text-ink-faint">Nothing is saved until you confirm.</p>
      </form>
    </Sheet>
  );
}
