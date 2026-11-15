import type { Metadata } from "next";
import { WatchScreen } from "@/components/alerts/watch-screen";

export const metadata: Metadata = { title: "Watch" };

export default function WatchPage() {
  return <WatchScreen />;
}
