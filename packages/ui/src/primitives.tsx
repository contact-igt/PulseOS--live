import { ChevronDown } from "lucide-react";
import type { OperationalStatusKey } from "@pulseos/types";
import { OPERATIONAL_STATUS_LABEL, OPERATIONAL_STATUS_TONE } from "./status";
import type { ButtonHTMLAttributes, ComponentPropsWithoutRef, HTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";

/**
 * Card hierarchy (four distinct surfaces, not four looks of the same thing):
 *  - "white"    (default) B: solid white data panel for tables, analytics, forms.
 *  - "info"     C: light-blue information panel for secondary context.
 *  - "emphasis" D: blue emphasis panel. RARE: one primary KPI or key state per view.
 *  - "glass"    A: translucent structural surface (floating toolbars, popover-like
 *               groups). Never behind dense tables or text-heavy forms.
 */
export type CardTone = "white" | "info" | "emphasis" | "glass";

const CARD_TONE: Record<CardTone, string> = {
  white: "rounded-card border border-line surface-content shadow-panel",
  info: "rounded-card border border-line bg-surface-info",
  emphasis: "rounded-card border border-primary-700 bg-primary-700 text-white shadow-panel",
  glass: "glass rounded-panel",
};

export function Card({ children, className = "", tone = "white", ...rest }: { children: ReactNode; className?: string; tone?: CardTone } & ComponentPropsWithoutRef<"div">) {
  return (
    <div className={`${CARD_TONE[tone]} ${className}`} {...rest}>
      {children}
    </div>
  );
}

/** The one glass material as a component: rounded structural surface. `strong` = higher opacity for text-bearing chrome. */
export function Glass({ children, className = "", strong = false, ...rest }: { children: ReactNode; className?: string; strong?: boolean } & ComponentPropsWithoutRef<"div">) {
  return (
    <div className={`${strong ? "glass-strong" : "glass"} rounded-panel ${className}`} {...rest}>
      {children}
    </div>
  );
}

export function SectionHeading({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <div className="mb-3 flex items-start justify-between gap-3">
      {/* min-w-0 lets this flex child actually shrink below its content's
          natural width (the flex default is min-width:auto, i.e. never
          smaller than max-content) — without it `truncate` below has no
          room to take effect and the title just bleeds past the card
          instead. flex-wrap so a long subtitle drops to its own line under
          a tight panel (e.g. Command Centre's 1.5fr/1fr row at 1024px)
          rather than squeezing the title. */}
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        {/* truncate (not just whitespace-nowrap) — the longest real title
            in this app ("Top Campaigns by Revenue") has as little as 9px of
            headroom in its narrowest real panel; ellipsizing on overflow is
            a much safer failure mode than the Card's overflow-hidden
            silently clipping the title with no visual cue at all. */}
        <h2 className="min-w-0 truncate text-sm font-semibold tracking-tight text-ink">{title}</h2>
        {subtitle && <span className="shrink-0 text-xs text-ink-2">{subtitle}</span>}
      </div>
      {action}
    </div>
  );
}

/**
 * Card with an optional header row (title / subtitle / action) and consistent
 * body padding. `padded={false}` for tables and lists that own their gutters.
 */
export function Panel({
  title,
  subtitle,
  action,
  padded = true,
  tone = "white",
  className = "",
  children,
  ...rest
}: {
  title?: string;
  subtitle?: string;
  action?: ReactNode;
  padded?: boolean;
  tone?: CardTone;
  className?: string;
  children: ReactNode;
} & Omit<ComponentPropsWithoutRef<"div">, "title">) {
  return (
    <Card tone={tone} className={`overflow-hidden ${className}`} {...rest}>
      {(title || action) && (
        <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
            {title && <h2 className="min-w-0 truncate text-sm font-semibold tracking-tight text-ink">{title}</h2>}
            {subtitle && <span className="text-xs text-ink-2">{subtitle}</span>}
          </div>
          {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
        </div>
      )}
      <div className={padded ? "p-4" : ""}>{children}</div>
    </Card>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-primary-100/70 motion-reduce:animate-none ${className}`} />;
}

/** `message` alone keeps every existing call site working; `hint` and `action` are optional extras. */
export function EmptyState({ message, hint, action }: { message: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex min-h-24 flex-col items-center justify-center gap-1 px-4 py-6 text-center">
      <span className="mb-1 h-1 w-8 rounded-full bg-primary-200" aria-hidden="true" />
      <p className="text-sm font-medium text-ink-2">{message}</p>
      {hint && <p className="max-w-sm text-xs text-neutral-500">{hint}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function ErrorState({ message }: { message: string }) {
  return (
    <div role="alert" className="flex min-h-24 items-center justify-center px-4 py-6 text-center text-sm text-danger-700">
      {message}
    </div>
  );
}

/** Status / category pill. Never wraps: a long label widens its table cell instead of breaking onto two lines. */
/** The derived operational status as a badge; renders nothing before any visit or treatment. */
export function OperationalStatusBadge({ status, className = "", "data-testid": testId }: { status: OperationalStatusKey | null | undefined; className?: string; "data-testid"?: string }) {
  if (!status) return null;
  return (
    <span data-testid={testId} data-operational-status={status}>
      <Badge tone={OPERATIONAL_STATUS_TONE[status]} className={className}>{OPERATIONAL_STATUS_LABEL[status]}</Badge>
    </span>
  );
}

export function Badge({ tone = "neutral", children, className = "" }: { tone?: "neutral" | "warning" | "danger" | "primary" | "success"; children: ReactNode; className?: string }) {
  const tones: Record<string, string> = {
    neutral: "bg-neutral-100 text-neutral-700 ring-neutral-200",
    warning: "bg-warning-100 text-warning-700 ring-warning-500/25",
    danger: "bg-danger-100 text-danger-700 ring-danger-500/25",
    primary: "bg-primary-100 text-primary-700 ring-primary-200",
    // Distinct from "primary" (active/in-progress blue) — reserved for a
    // genuinely completed/healthy state (CLAUDE.md: success=teal/green).
    success: "bg-accent-100 text-accent-700 ring-accent-500/25",
  };
  return (
    <span
      className={`inline-flex w-fit shrink-0 items-center whitespace-nowrap rounded-chip px-2 py-0.5 text-[11px] font-medium leading-4 ring-1 ring-inset ${tones[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md";

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-primary-600 text-white hover:bg-primary-700 disabled:opacity-40",
  // Quieter than primary — an outlined neutral treatment, never blue, so a
  // row of actions reads as one clear CTA plus muted secondaries rather
  // than several competing "buttons".
  secondary: "border border-line-strong bg-white/85 text-neutral-700 shadow-panel hover:bg-white disabled:opacity-40",
  ghost: "text-neutral-500 hover:bg-neutral-100 hover:text-slate-900 disabled:opacity-40",
  danger: "border border-danger-100 text-danger-700 hover:bg-danger-100 disabled:opacity-40",
};

const BUTTON_SIZE: Record<ButtonSize, string> = {
  // On phones every button is a 44px target (a minimum, not a maximum).
  sm: "rounded-chip px-2 py-1 text-xs font-medium max-md:min-h-11 max-md:px-3",
  md: "rounded-control px-3.5 py-2 text-sm font-medium max-md:min-h-11",
};

/** The one shared button treatment — variant carries the action-hierarchy signal (primary/secondary/ghost/danger) so pages stop hand-rolling the same className strings with small, accidental drifts. */
export function Button({
  variant = "secondary",
  size = "md",
  className = "",
  children,
  ...rest
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  children: ReactNode;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className={`inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap transition ${BUTTON_SIZE[size]} ${BUTTON_VARIANT[variant]} ${className}`} {...rest}>
      {children}
    </button>
  );
}

/**
 * In-page header for pages that want a heading of their own below the shell's
 * TopBar (e.g. a detail page): optional Back control above, title/subtitle on
 * the left, an `actions` slot on the right (`action` kept as an alias). Wraps on
 * narrow screens instead of truncating; never renders a lone-button row.
 * `back` takes a rendered element (e.g. BackLink) since Back is app-routing-aware
 * and this package stays router-free.
 */
export function PageHeader({
  title,
  subtitle,
  action,
  actions,
  back,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  actions?: ReactNode;
  back?: ReactNode;
}) {
  const right = actions ?? action;
  return (
    <div className="space-y-1" data-testid="page-header">
      {back}
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1 basis-56">
          <h1 className="text-xl font-semibold tracking-tight text-ink">{title}</h1>
          {subtitle && <p className="mt-0.5 text-sm text-ink-2">{subtitle}</p>}
        </div>
        {right && <div className="flex shrink-0 flex-wrap items-center gap-2">{right}</div>}
      </div>
    </div>
  );
}

/**
 * One row for "left: tabs / filters, right: page actions". Replaces a lone
 * primary button on its own row above the content: put the button in
 * `actions` and the tabs / FilterBar in `children`.
 */
export function Toolbar({ children, actions, className = "", ...rest }: { children?: ReactNode; actions?: ReactNode; className?: string } & HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={`flex flex-wrap items-center gap-x-3 gap-y-2 ${className}`} {...rest}>
      {children && <div className="min-w-0 flex-1 basis-full sm:basis-auto">{children}</div>}
      {actions && <div className="ml-auto flex max-w-full shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Compact inline filter row (no full-width white panel). Wraps on mobile; pair with FilterSelect. */
export function FilterBar({ children, className = "", ...rest }: { children: ReactNode; className?: string } & HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={`flex flex-wrap items-center gap-2 ${className}`} {...rest}>
      {children}
    </div>
  );
}

/** Styled native <select> sized for FilterBar (32px high, custom chevron). Forwards every select prop. */
export function FilterSelect({ className = "", children, ...rest }: { className?: string; children: ReactNode } & SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className={`relative inline-flex min-w-0 flex-1 sm:flex-none ${className}`}>
      <select
        className="glass-control h-8 w-full min-w-0 appearance-none rounded-control py-0 pl-2.5 pr-7 text-xs font-medium text-neutral-700 outline-none transition hover:border-primary-300 focus-visible:border-primary-500"
        {...rest}
      >
        {children}
      </select>
      <ChevronDown size={13} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-neutral-500" aria-hidden="true" />
    </span>
  );
}

export { Tabs, type TabItem } from "./Tabs";
