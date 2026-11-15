import type { Metadata } from "next";
import { HoldingsScreen } from "@/components/holdings/holdings-screen";

export const metadata: Metadata = { title: "Holdings" };

export default function HoldingsPage() {
  return <HoldingsScreen />;
}
