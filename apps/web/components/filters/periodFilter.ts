import { resolveDatePreset } from "@pulseos/types";

/**
 * A list's period, kept in the URL under its own key prefix (the Appointments calendar already owns `range`).
 * Pure: the caller passes the hospital's local `today`, so presets resolve in the hospital's calendar and the same
 * preset set the rest of PulseOS uses (@pulseos/types DATE_PRESETS) is the only vocabulary.
 */
export interface PeriodOptions {
  /** Key prefix: "p" reads/writes `prange` / `pfrom` / `pto`. */
  prefix: string;
  defaultRange: string;
  /** The presets this list offers (it may drop ones its API cannot serve). */
  presets: readonly { key: string; label: string }[];
  today: string;
}

export interface ResolvedPeriod {
  range: string;
  from: string;
  to: string;
}

const isRealDate = (s: string | null): s is string => {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

const resolvePreset = (range: string, today: string) => resolveDatePreset(range as Parameters<typeof resolveDatePreset>[0], today);

export function readPeriod(params: URLSearchParams, o: PeriodOptions): ResolvedPeriod {
  const offered = (k: string | null): k is string => !!k && o.presets.some((p) => p.key === k);
  const raw = params.get(`${o.prefix}range`);
  if (raw === "custom" && offered("custom")) {
    const from = params.get(`${o.prefix}from`);
    const to = params.get(`${o.prefix}to`);
    if (isRealDate(from) && isRealDate(to) && from <= to) return { range: "custom", from, to };
  } else if (offered(raw) && raw !== "custom") {
    return { range: raw, ...resolvePreset(raw, o.today) };
  }
  return { range: o.defaultRange, ...resolvePreset(o.defaultRange, o.today) };
}

/** The URL patch for a chosen period; the default (and any unused custom ends) are removed so links stay short. */
export function periodPatch(next: { range: string | undefined; from: string | undefined; to: string | undefined }, o: Pick<PeriodOptions, "prefix" | "defaultRange">): Record<string, string | undefined> {
  const custom = next.range === "custom";
  return {
    [`${o.prefix}range`]: next.range && next.range !== o.defaultRange ? next.range : undefined,
    [`${o.prefix}from`]: custom ? next.from : undefined,
    [`${o.prefix}to`]: custom ? next.to : undefined,
  };
}

/**
 * The same URL vocabulary for lists that default to "Any date": the chosen preset (left unresolved - the panel turns it
 * into hospital days) or a valid custom range, otherwise nothing.
 */
export function readPeriodChoice(params: URLSearchParams, o: Pick<PeriodOptions, "prefix" | "presets">): { range: string | undefined; from: string | undefined; to: string | undefined } {
  const none = { range: undefined, from: undefined, to: undefined };
  const raw = params.get(`${o.prefix}range`);
  if (!raw || !o.presets.some((p) => p.key === raw)) return none;
  if (raw !== "custom") return { range: raw, from: undefined, to: undefined };
  const from = params.get(`${o.prefix}from`);
  const to = params.get(`${o.prefix}to`);
  return isRealDate(from) && isRealDate(to) && from <= to ? { range: "custom", from, to } : none;
}
