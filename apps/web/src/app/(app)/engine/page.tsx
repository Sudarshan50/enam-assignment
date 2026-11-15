import type { Metadata } from "next";
import { EngineScreen } from "@/components/engine/engine-screen";

export const metadata: Metadata = { title: "Engine" };

export default function EnginePage() {
  return <EngineScreen />;
}
