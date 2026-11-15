"use client";

import { PageColumns, PageTitle } from "@/components/layout/page";
import { AlertsFeed } from "./alerts-feed";
import { PushCard } from "./push-card";
import { RulesList } from "./rules-list";

export function WatchScreen() {
  return (
    <PageColumns>
      <PageTitle kicker="Watch · Push mode" title="Tell me the moment it matters.">
        Thresholds you set on end-of-day prices and filing types. FINN watches; you get one quiet tap when something crosses.
      </PageTitle>
      <PushCard />
      <AlertsFeed />
      <RulesList />
    </PageColumns>
  );
}
