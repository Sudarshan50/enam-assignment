import type { Metadata } from "next";
import { AskIndex } from "@/components/research/ask-index";

export const metadata: Metadata = { title: "Ask" };

export default function AskPage() {
  return <AskIndex />;
}
