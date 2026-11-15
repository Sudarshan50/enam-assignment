import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/cn";

type Variant = "primary" | "secondary" | "ghost" | "quiet";
type Size = "sm" | "md";

const base =
  "inline-flex items-center justify-center gap-2 rounded-full font-medium tracking-[-0.005em] transition-[background-color,color,border-color,transform] duration-200 ease-[var(--ease-editorial)] active:scale-[0.98] disabled:pointer-events-none disabled:opacity-45 select-none whitespace-nowrap";

const variants: Record<Variant, string> = {
  primary: "bg-ink text-paper hover:bg-white",
  secondary: "border border-rule-strong text-ink hover:border-ink-faint hover:bg-white/[0.03]",
  ghost: "text-ink-muted hover:text-ink hover:bg-white/[0.04]",
  quiet: "text-ink-faint hover:text-ink",
};

const sizes: Record<Size, string> = {
  sm: "min-h-11 px-3.5 text-[13px]",
  md: "min-h-11 px-5 text-sm",
};

interface Common {
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
  children?: ReactNode;
  className?: string;
}

export function Button({ variant = "secondary", size = "md", icon, children, className, ...props }: Common & ComponentProps<"button">) {
  return (
    <button type="button" className={cn(base, variants[variant], sizes[size], className)} {...props}>
      {icon}
      {children}
    </button>
  );
}

export function ButtonLink({
  variant = "secondary",
  size = "md",
  icon,
  children,
  className,
  external,
  ...props
}: Common & ComponentProps<typeof Link> & { external?: boolean }) {
  const cls = cn(base, variants[variant], sizes[size], className);
  if (external) {
    return (
      <a className={cls} target="_blank" rel="noopener noreferrer" href={String(props.href)} aria-label={props["aria-label"]}>
        {icon}
        {children}
      </a>
    );
  }
  return (
    <Link className={cls} {...props}>
      {icon}
      {children}
    </Link>
  );
}

export function IconButton({ label, className, children, ...props }: ComponentProps<"button"> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex size-11 shrink-0 items-center justify-center rounded-full text-ink-muted transition-colors duration-200 hover:bg-white/[0.05] hover:text-ink active:scale-95 disabled:opacity-40",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}
