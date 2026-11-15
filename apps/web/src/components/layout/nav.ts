import { BellRing, BriefcaseBusiness, Gauge, MessageSquareQuote, Newspaper, type LucideIcon } from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  description: string;
}

export const TABS: NavItem[] = [
  { href: "/", label: "Today", icon: Newspaper, description: "The prioritised brief" },
  { href: "/ask", label: "Ask", icon: MessageSquareQuote, description: "Research any NSE company" },
  { href: "/watch", label: "Watch", icon: BellRing, description: "Alerts and rules" },
  { href: "/holdings", label: "Holdings", icon: BriefcaseBusiness, description: "Your 18 positions" },
];

export const ENGINE: NavItem = { href: "/engine", label: "Engine", icon: Gauge, description: "How it works, what it costs" };

export function isActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}
