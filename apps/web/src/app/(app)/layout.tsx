import type { ReactNode } from "react";
import { AppShell } from "@/components/layout/app-shell";
import { Providers } from "@/components/layout/providers";

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <Providers>
      <AppShell>{children}</AppShell>
    </Providers>
  );
}
