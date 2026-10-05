import type { CSSProperties } from "react";

/**
 * PulseOS product mark: a "P" drawn as one continuous journey line, with two
 * connected nodes (where a patient journey starts, and the loop that carries
 * it on). Flat fills only, no gradients, no medical cross or heart.
 *
 * tone="onWhite": blue tile, white P (light / glass surfaces)
 * tone="onBlue":  white tile, deep-blue P (strong blue surfaces)
 */
export type BrandTone = "onWhite" | "onBlue";

const MARK_COLORS: Record<BrandTone, { tile: string; stroke: string; node: string; word: string; betaInk: string; betaBorder: string; betaBg: string }> = {
  onWhite: { tile: "#0873dd", stroke: "#ffffff", node: "#9dd0ff", word: "#102a43", betaInk: "#075fbc", betaBorder: "rgb(8 115 221 / 0.35)", betaBg: "rgb(229 243 255 / 0.8)" },
  onBlue: { tile: "#ffffff", stroke: "#075fbc", node: "#1685f8", word: "#ffffff", betaInk: "#e5f3ff", betaBorder: "rgb(255 255 255 / 0.4)", betaBg: "transparent" },
};

export function PulseMark({ size = 24, tone = "onWhite", className = "" }: { size?: number; tone?: BrandTone; className?: string }) {
  const c = MARK_COLORS[tone];
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" className={`shrink-0 ${className}`} aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="8" style={{ fill: c.tile }} />
      <g transform="translate(-1.4 -0.6)">
        <path d="M10.5 24V8h7.5a5.25 5.25 0 0 1 0 10.5h-7.5" style={{ stroke: c.stroke }} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="10.5" cy="24" r="2.5" style={{ fill: c.node }} />
        <circle cx="23.25" cy="13.25" r="2.5" style={{ fill: c.node }} />
      </g>
    </svg>
  );
}

/** Small, quiet pre-release marker: tiny letter-spaced outline pill, never a loud badge. */
export function BetaBadge({ tone = "onWhite", className = "", label = "Beta" }: { tone?: BrandTone; className?: string; label?: string }) {
  const c = MARK_COLORS[tone];
  const style = { color: c.betaInk, borderColor: c.betaBorder, backgroundColor: c.betaBg } as CSSProperties;
  return (
    <span className={`inline-flex items-center rounded-full border px-1.5 py-px text-[9px] font-semibold uppercase leading-none tracking-[0.14em] ${className}`} style={style}>
      {label}
    </span>
  );
}

/** `[mark] PulseOS  BETA`. `size` is the mark size in px; the wordmark scales with it. */
export function PulseLockup({
  tone = "onWhite",
  size = 28,
  showBeta = true,
  betaLabel = "Beta",
  className = "",
}: {
  tone?: BrandTone;
  size?: number;
  showBeta?: boolean;
  /** e.g. "Beta V1" / "Beta V2": the tenant's edition, shown quietly beside the product name. */
  betaLabel?: string;
  className?: string;
}) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`} data-testid="brand-lockup">
      <PulseMark size={size} tone={tone} />
      <span className="font-semibold tracking-tight" style={{ fontSize: Math.round(size * 0.62), color: MARK_COLORS[tone].word }}>
        PulseOS
      </span>
      {showBeta && <BetaBadge tone={tone} label={betaLabel} />}
    </span>
  );
}
