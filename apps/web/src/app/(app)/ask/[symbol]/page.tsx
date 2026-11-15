import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ResearchScreen } from "@/components/research/research-screen";

type Params = Promise<{ symbol: string }>;

function normalise(raw: string): string | null {
  const s = decodeURIComponent(raw).trim().toUpperCase();
  return /^[A-Z0-9&-]{1,20}$/.test(s) ? s : null;
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { symbol } = await params;
  return { title: normalise(symbol) ?? "Research" };
}

export default async function ResearchPage({ params }: { params: Params }) {
  const symbol = normalise((await params).symbol);
  if (!symbol) notFound();
  return <ResearchScreen key={symbol} symbol={symbol} />;
}
