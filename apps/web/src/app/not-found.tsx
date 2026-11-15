import Link from "next/link";

export default function NotFound() {
  return (
    <main className="relative z-10 flex min-h-dvh flex-col items-center justify-center px-8 text-center">
      <p className="kicker text-ink-faint">404</p>
      <h1 className="mt-4 font-display text-[44px] leading-none text-ink">Not on the tape.</h1>
      <p className="mt-4 max-w-sm text-[15px] text-ink-muted">That page doesn&apos;t exist. Symbols must be NSE tickers like CDSL or TCS.</p>
      <Link href="/" className="mt-8 inline-flex min-h-11 items-center rounded-full bg-ink px-5 text-sm font-medium text-paper hover:bg-white">
        Back to Today
      </Link>
    </main>
  );
}
