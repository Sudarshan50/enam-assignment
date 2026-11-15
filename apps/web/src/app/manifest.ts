import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "FINN — the few filings that matter",
    short_name: "FINN",
    description: "A calm daily brief of NSE filings for your portfolio, and research grounded in primary documents.",
    id: "/",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#0d0d0b",
    theme_color: "#0d0d0b",
    categories: ["finance", "news", "productivity"],
    icons: [
      { src: "/pwa-icon/192", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/pwa-icon/512", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/pwa-icon/512", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "Today", url: "/", description: "The prioritised brief" },
      { name: "Ask", url: "/ask", description: "Research a company" },
      { name: "Watch", url: "/watch", description: "Alerts and rules" },
    ],
  };
}
