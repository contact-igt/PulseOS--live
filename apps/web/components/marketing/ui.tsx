import type { ReactNode } from "react";
import { Badge, Card } from "@pulseos/ui/src/primitives";

/** One content column for the whole marketing site: ~1240px, 16/24/32px gutters. */
export const CONTAINER = "mx-auto w-full max-w-[1240px] px-4 sm:px-6 lg:px-8";

export const DEMO_HREF = "#demo";
export const HOW_HREF = "#journey";

export function Eyebrow({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <p className={`text-[13px] font-semibold uppercase tracking-[0.12em] text-brand ${className}`}>{children}</p>;
}

export function SectionHead({
  eyebrow,
  title,
  children,
  align = "left",
  className = "",
}: {
  eyebrow: string;
  title: ReactNode;
  children?: ReactNode;
  align?: "left" | "center";
  className?: string;
}) {
  return (
    <div className={`${align === "center" ? "mx-auto text-center" : ""} max-w-3xl ${className}`}>
      <Eyebrow>{eyebrow}</Eyebrow>
      <h2 className="mt-3 text-balance text-[30px] font-semibold leading-[1.12] tracking-tight text-ink sm:text-[38px] lg:text-[44px]">{title}</h2>
      {children && <div className="mt-4 text-pretty text-[17px] leading-relaxed text-ink-2">{children}</div>}
    </div>
  );
}

export function PrimaryCta({ children = "Book a live demo", href = DEMO_HREF, className = "" }: { children?: ReactNode; href?: string; className?: string }) {
  return (
    <a
      href={href}
      className={`inline-flex h-12 items-center justify-center rounded-control bg-brand px-6 text-[15px] font-semibold text-white shadow-panel transition hover:bg-primary-700 ${className}`}
    >
      {children}
    </a>
  );
}

export function SecondaryCta({ children = "See how it works", href = HOW_HREF, className = "" }: { children?: ReactNode; href?: string; className?: string }) {
  return (
    <a
      href={href}
      className={`inline-flex h-12 items-center justify-center rounded-control border border-line-strong bg-white px-6 text-[15px] font-semibold text-ink transition hover:border-primary-300 hover:bg-primary-50 ${className}`}
    >
      {children}
    </a>
  );
}

/** Quiet browser chrome around a product screen. The address strip names the PulseOS screen, never an invented domain. */
export function BrowserFrame({ screen, children, className = "", label }: { screen: string; children: ReactNode; className?: string; label?: string }) {
  return (
    <figure className={`overflow-hidden rounded-panel border border-line bg-white shadow-glass ${className}`} aria-label={label ?? `PulseOS ${screen} screen with synthetic demo data`}>
      <div className="flex h-9 items-center gap-3 border-b border-line bg-surface-muted px-3" aria-hidden="true">
        <span className="flex gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-neutral-300" />
          <span className="h-2.5 w-2.5 rounded-full bg-neutral-300" />
          <span className="h-2.5 w-2.5 rounded-full bg-neutral-300" />
        </span>
        <span className="mx-auto flex h-6 min-w-0 max-w-[260px] flex-1 items-center justify-center truncate rounded-md border border-line bg-white px-3 text-[11px] text-ink-2">PulseOS · {screen}</span>
        <span className="w-10" />
      </div>
      {children}
    </figure>
  );
}

/** A framed, UI-scale card used inside product screens. */
export function UiCard({ title, meta, children, className = "" }: { title?: ReactNode; meta?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <Card className={className}>
      {title && (
        <div className="flex items-baseline justify-between gap-3 border-b border-line px-3.5 py-2.5">
          <div className="text-[13px] font-semibold tracking-tight text-ink">{title}</div>
          {meta && <span className="text-[11px] text-ink-2">{meta}</span>}
        </div>
      )}
      {children}
    </Card>
  );
}

/** The app's own status badge (text carries the meaning, colour only reinforces it). */
export function Pill({ tone = "neutral", children, className = "" }: { tone?: "neutral" | "warning" | "danger" | "primary" | "success"; children: ReactNode; className?: string }) {
  return (
    <Badge tone={tone} className={className}>
      {children}
    </Badge>
  );
}

/** Captions under product screens: always states the data is synthetic where a screen is shown. */
export function Caption({ children }: { children: ReactNode }) {
  return <p className="mt-4 text-sm leading-relaxed text-ink-2">{children}</p>;
}
