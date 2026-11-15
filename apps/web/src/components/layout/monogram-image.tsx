import { BRAND, MONOGRAM_DOT, MONOGRAM_F_PATH } from "@/lib/brand";

/** JSX for next/og ImageResponse (Satori): full-bleed so it also works as a maskable icon. */
export function MonogramImage({ size }: { size: number }) {
  return (
    <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: BRAND.paper }}>
      <svg width={size} height={size} viewBox="0 0 512 512">
        <path d={MONOGRAM_F_PATH} fill={BRAND.ink} />
        <circle cx={MONOGRAM_DOT.cx} cy={MONOGRAM_DOT.cy} r={MONOGRAM_DOT.r} fill={BRAND.act} />
      </svg>
    </div>
  );
}
