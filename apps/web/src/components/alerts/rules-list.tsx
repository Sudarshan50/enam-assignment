"use client";

import type { AlertRule } from "@finn/shared";
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button, IconButton } from "@/components/ui/button";
import { ListSkeleton } from "@/components/ui/states";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { alertsApi } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useAlertRules } from "@/lib/hooks/data";
import { describeScope, describeTrigger } from "./describe";
import { NewRuleSheet } from "./new-rule-sheet";

function RuleRow({ rule, onToggle, onDelete }: { rule: AlertRule; onToggle: (v: boolean) => void; onDelete: () => void }) {
  const t = describeTrigger(rule.definition);
  return (
    <li className="flex items-start gap-2 py-4">
      <div className={cn("min-w-0 flex-1 transition-opacity", !rule.enabled && "opacity-55")}>
        <p className="text-[15px] leading-snug text-ink">{rule.name}</p>
        <p className="mt-1 font-mono text-[11px] leading-relaxed text-ink-faint">
          {describeScope(rule.definition.scope)} · {t.when.toLowerCase()} · {t.threshold}
        </p>
      </div>
      <Switch checked={rule.enabled} onChange={onToggle} label={`${rule.enabled ? "Disable" : "Enable"} rule: ${rule.name}`} />
      <IconButton label={`Delete rule: ${rule.name}`} onClick={onDelete} className="-mr-2">
        <Trash2 className="size-4" />
      </IconButton>
    </li>
  );
}

export function RulesList() {
  const { data, isLoading, mutate } = useAlertRules();
  const [creating, setCreating] = useState(false);
  const toast = useToast();

  const toggle = async (rule: AlertRule, enabled: boolean) => {
    await mutate((prev) => prev?.map((r) => (r.id === rule.id ? { ...r, enabled } : r)), { revalidate: false });
    try {
      await alertsApi.updateRule(rule.id, { enabled });
    } catch {
      toast.show({ message: "Couldn't update the rule" });
      void mutate();
    }
  };

  const remove = async (rule: AlertRule) => {
    await mutate((prev) => prev?.filter((r) => r.id !== rule.id), { revalidate: false });
    try {
      await alertsApi.deleteRule(rule.id);
      toast.show({ message: `Deleted · ${rule.name}` });
    } catch {
      toast.show({ message: "Couldn't delete the rule" });
      void mutate();
    }
  };

  return (
    <section aria-labelledby="rules-title" className="mt-12">
      <div className="flex items-end justify-between border-b border-rule pb-2.5">
        <div>
          <p className="kicker text-ink-faint">You decide what&apos;s unusual</p>
          <h2 id="rules-title" className="mt-1 font-display text-[28px] leading-none text-ink">
            Rules
          </h2>
        </div>
        <Button size="sm" variant="primary" onClick={() => setCreating(true)} icon={<Plus className="size-4" aria-hidden />}>
          New rule
        </Button>
      </div>
      {isLoading ? <ListSkeleton rows={3} /> : null}
      <ul className="divide-y divide-rule">
        {data?.map((r) => (
          <RuleRow key={r.id} rule={r} onToggle={(v) => void toggle(r, v)} onDelete={() => void remove(r)} />
        ))}
      </ul>
      <NewRuleSheet
        open={creating}
        onClose={() => setCreating(false)}
        onSaved={(rule) => {
          void mutate((prev) => [rule, ...(prev ?? [])], { revalidate: false });
          setCreating(false);
          toast.show({ message: `Watching · ${rule.name}` });
        }}
      />
    </section>
  );
}
