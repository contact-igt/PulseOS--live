import { REPORT_RANGES, type ReportFilterOptions, type ReportQuery, type ReportRange } from "@pulseos/types";

// The Operations report's filters live in the URL (shareable, survive refresh/back) under an `r` prefix so they never
// collide with the Command Centre overview's own `branchId` / `journeyType`. Anything malformed falls back to the
// default instead of breaking the page; the server validates again.

export const DEFAULT_REPORT_RANGE: ReportRange = "7d";

export type ReportFilterKey = "range" | "from" | "to" | "branchId" | "service" | "sourceId" | "ownerId" | "doctorId" | "departmentId";
export type ReportUrlKeys = Record<ReportFilterKey, string>;

/** The Command Centre tab's keys (`r` prefix: they must not collide with the overview's own `branchId` / `journeyType`). */
export const REPORT_KEYS: ReportUrlKeys = { range: "rRange", from: "rFrom", to: "rTo", branchId: "rBranch", service: "rService", sourceId: "rSource", ownerId: "rOwner", doctorId: "rDoctor", departmentId: "rDept" };
/** The Analytics workspace's keys (`a` prefix: Marketing analytics on the same page keeps `range`, `branch`, `source`…). */
export const ANALYTICS_KEYS: ReportUrlKeys = { range: "aRange", from: "aFrom", to: "aTo", branchId: "aBranch", service: "aService", sourceId: "aSource", ownerId: "aOwner", doctorId: "aDoctor", departmentId: "aDept" };

export interface ReportFilterConfig {
  keys: ReportUrlKeys;
  defaultRange: ReportRange;
}
export const REPORT_CONFIG: ReportFilterConfig = { keys: REPORT_KEYS, defaultRange: DEFAULT_REPORT_RANGE };
export const ANALYTICS_CONFIG: ReportFilterConfig = { keys: ANALYTICS_KEYS, defaultRange: "30d" };

// The shared presets, plus the two keys older shared links may still carry (the API still resolves them).
const RANGES = new Set<string>([...REPORT_RANGES.map((r) => r.key), "14d", "last_month"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isRealDate(s: string | undefined): s is string {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function addDays(ymd: string, n: number): string {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/** URL → a valid query. A custom range without valid dates becomes the default preset. */
export function readReportFilters(get: (key: string) => string, today: string, config: ReportFilterConfig = REPORT_CONFIG): ReportQuery & { range: ReportRange } {
  const { keys: K, defaultRange } = config;
  const raw = get(K.range);
  let range: ReportRange = RANGES.has(raw) ? (raw as ReportRange) : defaultRange;
  if (range === "last_month") range = "prev_month"; // an older link: same days, the one name
  const from = get(K.from);
  const to = get(K.to);
  // The server refuses a span over a year (400); mirror that here so a hand-made link falls back instead of erroring.
  const withinYear = isRealDate(from) && isRealDate(to) && (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1 <= 366;
  if (range === "custom" && !(isRealDate(from) && isRealDate(to) && from <= to && to <= today && withinYear)) range = defaultRange;
  const id = (k: string) => (UUID.test(get(k)) ? get(k) : undefined);
  const service = get(K.service).slice(0, 120) || undefined;
  return {
    range,
    ...(range === "custom" ? { from, to } : {}),
    ...(id(K.branchId) ? { branchId: id(K.branchId) } : {}),
    ...(id(K.departmentId) ? { departmentId: id(K.departmentId) } : {}),
    ...(service ? { service } : {}),
    ...(id(K.sourceId) ? { sourceId: id(K.sourceId) } : {}),
    ...(id(K.ownerId) ? { ownerId: id(K.ownerId) } : {}),
    ...(id(K.doctorId) ? { doctorId: id(K.doctorId) } : {}),
  };
}

/** A filter change → the URL patch (undefined clears a key). Leaving "custom" drops its dates. */
export function reportFilterPatch(patch: Partial<ReportQuery>, config: ReportFilterConfig = REPORT_CONFIG): Record<string, string | undefined> {
  const { keys: K, defaultRange } = config;
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(patch) as [ReportFilterKey, string | undefined][]) out[K[k]] = v || undefined;
  if (patch.range && patch.range !== "custom") Object.assign(out, { [K.from]: undefined, [K.to]: undefined });
  if (patch.range === defaultRange) out[K.range] = undefined;
  return out;
}

/** Clears every report filter (and only the report's). */
export function resetReportPatch(config: ReportFilterConfig = REPORT_CONFIG): Record<string, undefined> {
  return Object.fromEntries(Object.values(config.keys).map((k) => [k, undefined]));
}

/** A custom range opens on the last 7 hospital days. */
export function customDefaults(today: string): { from: string; to: string } {
  return { from: addDays(today, -6), to: today };
}

export interface ActiveChip {
  key: keyof ReportQuery;
  label: string;
}

/** Human-readable chips for every non-period filter that is set. */
export function activeReportChips(q: ReportQuery, o: ReportFilterOptions | undefined): ActiveChip[] {
  const chips: ActiveChip[] = [];
  const name = <T extends { id: string }>(list: T[] | undefined, id: string, pick: (x: T) => string) => (list?.find((x) => x.id === id) ? pick(list.find((x) => x.id === id)!) : "…");
  if (q.branchId) chips.push({ key: "branchId", label: `Branch: ${name(o?.branches, q.branchId, (b) => b.name)}` });
  if (q.departmentId) chips.push({ key: "departmentId", label: `Department: ${name(o?.departments, q.departmentId, (d) => d.name)}` });
  if (q.service) chips.push({ key: "service", label: `Service: ${q.service}` });
  if (q.sourceId) chips.push({ key: "sourceId", label: `Source: ${name(o?.sources, q.sourceId, (s) => s.label)}` });
  if (q.ownerId) chips.push({ key: "ownerId", label: `Team member: ${name(o?.owners, q.ownerId, (u) => u.name)}` });
  if (q.doctorId) chips.push({ key: "doctorId", label: `Doctor: ${name(o?.doctors, q.doctorId, (d) => d.name)} (visits & surgeries)` });
  return chips;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const short = (ymd: string, year = false) => `${Number(ymd.slice(8, 10))} ${MONTHS[Number(ymd.slice(5, 7)) - 1]}${year ? ` ${ymd.slice(0, 4)}` : ""}`;

/** "1 Oct 2026" / "25 Sep – 1 Oct 2026" / "28 Dec 2025 – 3 Jan 2026" — always the hospital's calendar days. */
export function periodLabel(from: string, to: string): string {
  if (from === to) return short(from, true);
  return from.slice(0, 4) === to.slice(0, 4) ? `${short(from)} – ${short(to, true)}` : `${short(from, true)} – ${short(to, true)}`;
}
