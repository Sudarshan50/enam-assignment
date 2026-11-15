import { ImageResponse } from "next/og";
import { MonogramImage } from "@/components/layout/monogram-image";

const SIZES = [96, 192, 512] as const;

export function generateStaticParams() {
  return SIZES.map((size) => ({ size: String(size) }));
}

export const dynamicParams = false;

export async function GET(_request: Request, { params }: { params: Promise<{ size: string }> }) {
  const size = Number((await params).size);
  return new ImageResponse(<MonogramImage size={size} />, { width: size, height: size });
}
