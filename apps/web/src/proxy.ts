import { NextResponse, type NextRequest } from "next/server";

const COOKIE = "finn_access";
const THIRTY_DAYS = 60 * 60 * 24 * 30;
const USE_MOCKS = process.env.NEXT_PUBLIC_USE_MOCKS === "1";

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Mock mode accepts any non-empty token. Otherwise the token must match the server-only
 * DEMO_ACCESS_TOKEN; the API re-checks the same cookie on every request.
 */
function acceptable(token: string | undefined | null): token is string {
  if (!token || token.trim().length === 0 || token.length > 256) return false;
  if (USE_MOCKS) return true;
  const expected = process.env.DEMO_ACCESS_TOKEN;
  return Boolean(expected) && safeEqual(token, expected!);
}

export function proxy(request: NextRequest) {
  const url = request.nextUrl;
  const linkToken = url.searchParams.get("k");

  if (linkToken !== null) {
    const clean = url.clone();
    clean.searchParams.delete("k");
    if (acceptable(linkToken)) {
      const response = NextResponse.redirect(clean);
      response.cookies.set(COOKIE, linkToken, {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/",
        maxAge: THIRTY_DAYS,
      });
      return response;
    }
  }

  if (acceptable(request.cookies.get(COOKIE)?.value)) return NextResponse.next();

  if (url.pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "locked", message: "Open the link you were sent." }, { status: 401 });
  }
  return NextResponse.rewrite(new URL("/locked", request.url));
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|locked|favicon.ico|icon.svg|apple-icon|pwa-icon|manifest.webmanifest|sw.js|robots.txt|.*\\.(?:png|svg|jpg|webp|ico|txt|woff2?)$).*)",
  ],
};
