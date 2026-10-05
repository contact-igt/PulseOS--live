import type { AnalyticsBucket, SourceChannel } from "@pulseos/types";

/**
 * Categorical series palette for analytics — a tonal blue / cyan family, in a
 * fixed slot order (never re-ordered, never cycled). Validated with the
 * dataviz palette validator (light surface #fcfcfb): worst adjacent pair
 * OKLab ΔE 17.2 for normal vision and 16.8 (protan) / 15.0 (tritan) under
 * simulated colour-vision deficiency; lightness band and chroma floor pass. Three light slots sit below 3:1 against
 * white, so identity is never colour-only: every chart ships a legend, a
 * tooltip and a table twin.
 */
export const SERIES_PALETTE = ["#2584b2", "#72b5f2", "#4170cb", "#35afc9", "#067396", "#2bb8ab", "#2158a7", "#4c8edf"] as const;

/** One slot per source. "organic" and "other" share the last slot (folded into "Other"). */
const SOURCE_SLOT: Record<SourceChannel, number> = { meta: 0, google: 1, website: 2, whatsapp: 3, phone: 4, walk_in: 5, referral: 6, organic: 7, other: 7 };

export const SOURCE_LABELS: Record<SourceChannel, string> = {
  meta: "Meta",
  google: "Google",
  website: "Website",
  whatsapp: "WhatsApp",
  phone: "Phone",
  walk_in: "Walk-in",
  referral: "Referral",
  organic: "Organic",
  other: "Other",
};

/** Colour follows the entity, never its rank: filtering never repaints the survivors. */
export const sourceColor = (source: SourceChannel) => SERIES_PALETTE[SOURCE_SLOT[source]];

/** Chart series key — organic folds into "other" so the palette never needs a 9th hue. */
export const chartSourceKey = (source: SourceChannel): SourceChannel => (source === "organic" ? "other" : source);

/** Neutral chart chrome (recessive: hairline grid, no axis rules). */
export const CHART_INK = {
  primary: "#102a43",
  secondary: "#5c728a",
  muted: "#7b8fa5",
  grid: "#e6eef7",
  baseline: "#c3d3e4",
  surface: "#ffffff",
  /** Single-series emphasis and the "current period" line. */
  accent: "#2584b2",
  /** Comparison / previous-period context. */
  context: "#a9c4de",
  /** Non-events: "not progressed" flows, empty tracks. */
  track: "#e5eef8",
} as const;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const parts = (ymd: string) => ({ d: Number(ymd.slice(8, 10)), m: MONTHS[Number(ymd.slice(5, 7)) - 1] });

/** "7 Sep" from a YYYY-MM-DD local day (no timezone conversion: the day is already local). */
export function fmtDayShort(ymd: string): string {
  const { d, m } = parts(ymd);
  return `${d} ${m}`;
}

/** "7–13 Sep", "28 Aug – 3 Sep", "28–29 Sep (2 days)" for a partial bucket, "7 Sep" for a single day. */
export function fmtBucketLabel(b: Pick<AnalyticsBucket, "key" | "to" | "days" | "partial">): string {
  if (b.key === b.to) return fmtDayShort(b.key);
  const a = parts(b.key);
  const z = parts(b.to);
  const span = a.m === z.m ? `${a.d}–${z.d} ${z.m}` : `${a.d} ${a.m} – ${z.d} ${z.m}`;
  return b.partial ? `${span} (${b.days} days)` : span;
}

export const fmtCountNum = (n: number) => n.toLocaleString("en-IN");
export const fmtPct = (rate: number | null) => (rate === null ? "—" : `${Math.round(rate * 100)}%`);
export const fmtRoasX = (roas: number | null) => (roas === null ? "—" : `${roas.toFixed(1)}×`);
/** Axis money: ₹0, ₹50K, ₹1L, ₹1.5L — no trailing zeros. */
export function fmtInrAxis(n: number): string {
  if (n === 0) return "₹0";
  const trim = (x: number) => String(Number(x.toFixed(1)));
  if (Math.abs(n) >= 100_000) return `₹${trim(n / 100_000)}L`;
  if (Math.abs(n) >= 1_000) return `₹${trim(n / 1_000)}K`;
  return `₹${Math.round(n)}`;
}

/** Relative change, or null when there is no baseline to compare against. */
export function pctChange(current: number, previous: number): number | null {
  return previous > 0 ? (current - previous) / previous : null;
}

const STEPS = [1, 2, 2.5, 5, 10];

/** Smallest tidy step (1, 2, 2.5, 5 x 10^k) such that `maxValue` fits in at most `maxIntervals` gridline intervals. */
function tidyStep(maxValue: number, maxIntervals: number, whole: boolean): number {
  for (let mag = 1e-3; mag < 1e12; mag *= 10) {
    for (const base of STEPS) {
      const step = base * mag;
      if (whole && (step < 1 || !Number.isInteger(step))) continue;
      if (Math.ceil(maxValue / step) <= maxIntervals) return step;
    }
  }
  return maxValue;
}

function axisFor(maxValue: number, floor: number, whole: boolean, maxIntervals: number): { max: number; ticks: number[] } {
  const step = tidyStep(Math.max(maxValue, floor), maxIntervals, whole);
  const top = step * Math.max(Math.ceil(Math.max(maxValue, floor) / step), 1);
  const ticks: number[] = [];
  for (let v = 0; v <= top + step / 1e6; v += step) ticks.push(Math.round(v * 100) / 100);
  return { max: top, ticks };
}

/** Whole-number y-axis for counts (enquiries per day): integer gridlines, tidy step, never fewer than 0-3. */
export const niceCountAxis = (maxValue: number) => axisFor(maxValue, 3, true, 4);

/** Rupee y-axis: gridlines on ₹10K / ₹50K / ₹1L style values. */
export const niceMoneyAxis = (maxValue: number) => axisFor(maxValue, 1000, false, 5);
