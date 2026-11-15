"use client";

import { motion } from "motion/react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { USE_MOCKS } from "@/lib/env";
import { ENGINE, TABS, isActive } from "./nav";
import { Wordmark } from "./wordmark";

function MobileHeader({ pathname }: { pathname: string }) {
  const engineActive = isActive(pathname, ENGINE.href);
  return (
    <header className="pt-safe sticky top-0 z-30 border-b border-rule bg-paper/80 backdrop-blur-md lg:hidden">
      <div className="flex h-[52px] items-center justify-between px-5">
        <Link href="/" aria-label="FINN — Today" className="-ml-1 rounded-md px-1 py-2">
          <Wordmark className="text-[26px]" />
        </Link>
        <div className="flex items-center gap-1">
          {USE_MOCKS ? <span className="kicker rounded-full border border-rule px-2 py-0.5 text-[9.5px] text-ink-faint">Mock data</span> : null}
          <Link
            href={ENGINE.href}
            aria-label="Engine: how FINN works"
            aria-current={engineActive ? "page" : undefined}
            className={cn(
              "-mr-2 inline-flex size-11 items-center justify-center rounded-full transition-colors hover:bg-white/[0.05]",
              engineActive ? "text-amber" : "text-ink-muted",
            )}
          >
            <ENGINE.icon className="size-5" strokeWidth={1.6} />
          </Link>
        </div>
      </div>
    </header>
  );
}

function TabBar({ pathname }: { pathname: string }) {
  return (
    <nav aria-label="Primary" className="pb-safe fixed inset-x-0 bottom-0 z-40 border-t border-rule bg-paper/88 backdrop-blur-md lg:hidden">
      <ul className="mx-auto grid h-[64px] max-w-md grid-cols-4">
        {TABS.map((tab) => {
          const active = isActive(pathname, tab.href);
          return (
            <li key={tab.href} className="relative">
              <Link
                href={tab.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex h-full flex-col items-center justify-center gap-1 text-[10.5px] font-medium tracking-[0.02em] transition-colors",
                  active ? "text-ink" : "text-ink-faint hover:text-ink-muted",
                )}
              >
                {active ? (
                  <motion.span
                    layoutId="tab-indicator"
                    className="absolute top-0 h-[2px] w-8 rounded-full bg-act"
                    transition={{ type: "spring", stiffness: 500, damping: 40 }}
                  />
                ) : null}
                <tab.icon className="size-[21px]" strokeWidth={active ? 1.9 : 1.5} aria-hidden />
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function LeftRail({ pathname }: { pathname: string }) {
  const items = [...TABS, ENGINE];
  return (
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-[248px] flex-col border-r border-rule px-6 py-9 lg:flex">
      <Link href="/" aria-label="FINN — Today" className="rounded-md">
        <Wordmark className="text-[46px]" />
      </Link>
      <p className="mt-2 text-[13px] leading-snug text-ink-faint">The few filings that matter, for an investor with 18 holdings.</p>
      <nav aria-label="Primary" className="mt-10">
        <ul className="space-y-0.5">
          {items.map((item, i) => {
            const active = isActive(pathname, item.href);
            return (
              <li key={item.href} className={i === TABS.length ? "mt-6 border-t border-rule pt-6" : undefined}>
                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "group relative flex min-h-11 items-center gap-3 rounded-lg px-3 text-[14.5px] transition-colors",
                    active ? "bg-white/[0.04] text-ink" : "text-ink-muted hover:bg-white/[0.025] hover:text-ink",
                  )}
                >
                  {active ? <motion.span layoutId="rail-indicator" className="absolute top-2.5 bottom-2.5 -left-px w-[2px] rounded-full bg-act" /> : null}
                  <item.icon className="size-[18px]" strokeWidth={active ? 1.9 : 1.5} aria-hidden />
                  <span>{item.label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="mt-auto space-y-3 text-[11.5px] leading-relaxed text-ink-faint">
        {USE_MOCKS ? <p className="kicker text-amber/80">Mock data mode</p> : null}
        <p>Push: NSE filings and end-of-day prices. Pull: annual reports and earnings-call transcripts only.</p>
        <p className="font-mono text-[10.5px]">No news. No broker notes.</p>
      </div>
    </aside>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  return (
    <div className="relative z-10 min-h-dvh">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[80] focus:rounded-full focus:bg-ink focus:px-4 focus:py-2 focus:text-paper"
      >
        Skip to content
      </a>
      <MobileHeader pathname={pathname} />
      <LeftRail pathname={pathname} />
      <main id="main" className="pb-[calc(96px+env(safe-area-inset-bottom))] lg:pb-20 lg:pl-[248px]">
        {children}
      </main>
      <TabBar pathname={pathname} />
    </div>
  );
}
