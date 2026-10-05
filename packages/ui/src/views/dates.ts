/**
 * Pure, timezone-aware date helpers shared by CalendarView and GanttTimeline.
 *
 * Rules that make these safe for a hospital that runs on IST:
 *  - A "day key" is a plain `yyyy-mm-dd` string that names a calendar day IN
 *    THE GIVEN TIME ZONE. Events are bucketed by that key, never by the UTC
 *    date (2026-09-28T20:00:00Z is 29 Sep in Asia/Kolkata).
 *  - Day-key arithmetic (add days, week/month grids) is done on the key itself
 *    via UTC-noon math, so the runtime's own time zone never leaks in.
 *  - Nothing here reads the system clock: callers pass `now` explicitly.
 */

export type DayKey = string; // yyyy-mm-dd
export type DateInput = string | Date;

const DAY_MS = 86_400_000;
const KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

// ---------------------------------------------------------------------------
// Formatter cache (constructing Intl.DateTimeFormat is comparatively slow)
// ---------------------------------------------------------------------------
const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(timeZone: string, opts: Intl.DateTimeFormatOptions, locale = "en-IN"): Intl.DateTimeFormat {
  const id = `${locale}|${timeZone}|${JSON.stringify(opts)}`;
  let f = fmtCache.get(id);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, { timeZone, ...opts });
    fmtCache.set(id, f);
  }
  return f;
}

export function toDate(input: DateInput): Date {
  return input instanceof Date ? input : new Date(input);
}

export function isDayKey(value: string | null | undefined): value is DayKey {
  if (!value) return false;
  const m = KEY_RE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d, 12));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** UTC-noon Date for a day key (noon avoids any midnight edge in formatting). */
function keyToUtcNoon(key: DayKey): Date {
  const m = KEY_RE.exec(key);
  if (!m) throw new Error(`Invalid day key: ${key}`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12));
}

function utcNoonToKey(d: Date): DayKey {
  const y = String(d.getUTCFullYear()).padStart(4, "0");
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ---------------------------------------------------------------------------
// Instants -> local calendar parts
// ---------------------------------------------------------------------------
export interface ZonedParts {
  key: DayKey;
  hour: number;
  minute: number;
}

export function zonedParts(input: DateInput, timeZone: string): ZonedParts {
  const parts = fmt(timeZone, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(toDate(input));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "0";
  const hour = Number(get("hour")) % 24;
  return { key: `${get("year")}-${get("month")}-${get("day")}`, hour, minute: Number(get("minute")) };
}

/** The local calendar day (in `timeZone`) an instant falls on. */
export function localDayKey(input: DateInput, timeZone: string): DayKey {
  return zonedParts(input, timeZone).key;
}

/** Minutes since local midnight (0..1439) in `timeZone`. */
export function localMinutes(input: DateInput, timeZone: string): number {
  const p = zonedParts(input, timeZone);
  return p.hour * 60 + p.minute;
}

/**
 * The absolute instant at which local day `key` starts in `timeZone`
 * (e.g. 2026-09-29 in Asia/Kolkata -> 2026-09-28T18:30:00.000Z). Use for
 * building `from`/`to` API params from a visible range.
 */
export function dayStartInstant(key: DayKey, timeZone: string): Date {
  const [y, mo, d] = key.split("-").map(Number);
  const guess = Date.UTC(y, mo - 1, d, 0, 0, 0);
  // Offset of the zone at (roughly) that moment: local wall time read back as UTC minus the instant.
  const offsetAt = (ms: number) => {
    const p = zonedParts(new Date(ms), timeZone);
    const [py, pm, pd] = p.key.split("-").map(Number);
    return Date.UTC(py, pm - 1, pd, p.hour, p.minute) - ms;
  };
  let ms = guess - offsetAt(guess);
  ms = guess - offsetAt(ms); // re-evaluate once so a DST boundary resolves correctly
  return new Date(ms);
}

// ---------------------------------------------------------------------------
// Day-key arithmetic
// ---------------------------------------------------------------------------
export function addDays(key: DayKey, n: number): DayKey {
  return utcNoonToKey(new Date(keyToUtcNoon(key).getTime() + n * DAY_MS));
}

/** Whole days from `a` to `b` (b - a). */
export function diffDays(a: DayKey, b: DayKey): number {
  return Math.round((keyToUtcNoon(b).getTime() - keyToUtcNoon(a).getTime()) / DAY_MS);
}

/** 0 = Sunday .. 6 = Saturday. */
export function weekdayOf(key: DayKey): number {
  return keyToUtcNoon(key).getUTCDay();
}

export function daysInMonth(key: DayKey): number {
  const d = keyToUtcNoon(key);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
}

export function startOfMonth(key: DayKey): DayKey {
  return `${key.slice(0, 7)}-01`;
}

export type WeekStart = 0 | 1;

export function startOfWeek(key: DayKey, weekStartsOn: WeekStart = 1): DayKey {
  const back = (weekdayOf(key) - weekStartsOn + 7) % 7;
  return addDays(key, -back);
}

export function weekDays(key: DayKey, weekStartsOn: WeekStart = 1): DayKey[] {
  const start = startOfWeek(key, weekStartsOn);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

export interface MonthCell {
  key: DayKey;
  inMonth: boolean;
}

/** Always 6 rows x 7 columns so the grid never changes height between months. */
export function monthGrid(key: DayKey, weekStartsOn: WeekStart = 1): MonthCell[][] {
  const first = startOfMonth(key);
  const gridStart = startOfWeek(first, weekStartsOn);
  const month = key.slice(0, 7);
  return Array.from({ length: 6 }, (_, r) =>
    Array.from({ length: 7 }, (_, c) => {
      const k = addDays(gridStart, r * 7 + c);
      return { key: k, inMonth: k.slice(0, 7) === month };
    }),
  );
}

export type CalendarSpan = "day" | "week" | "month";

/** Move `key` by one `span` (clamps the day-of-month when stepping months: 31 Jan -> 28 Feb). */
export function shiftDate(key: DayKey, span: CalendarSpan, dir: 1 | -1): DayKey {
  if (span === "day") return addDays(key, dir);
  if (span === "week") return addDays(key, dir * 7);
  const d = keyToUtcNoon(key);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + dir, 1, 12));
  const dim = daysInMonth(utcNoonToKey(target));
  target.setUTCDate(Math.min(d.getUTCDate(), dim));
  return utcNoonToKey(target);
}

/**
 * Inclusive day range a calendar shows. `month` returns the full 6-week grid
 * (a superset of the week/day around `key`), so a page can fetch ONE range and
 * serve every mode without refetching when the user switches Day/Week/Month.
 */
export function visibleRange(span: CalendarSpan, key: DayKey, weekStartsOn: WeekStart = 1): { from: DayKey; to: DayKey } {
  if (span === "day") return { from: key, to: key };
  if (span === "week") {
    const from = startOfWeek(key, weekStartsOn);
    return { from, to: addDays(from, 6) };
  }
  const grid = monthGrid(key, weekStartsOn);
  return { from: grid[0][0].key, to: grid[5][6].key };
}

// ---------------------------------------------------------------------------
// Events -> days / segments
// ---------------------------------------------------------------------------
export interface Interval {
  startMs: number;
  /** Equals startMs when the source has no end (a point event). */
  endMs: number;
  hasEnd: boolean;
}

export function toInterval(start: DateInput, end?: DateInput | null): Interval {
  const startMs = toDate(start).getTime();
  const e = end == null ? NaN : toDate(end).getTime();
  const hasEnd = Number.isFinite(e) && e > startMs;
  return { startMs, endMs: hasEnd ? e : startMs, hasEnd };
}

/**
 * Local days an interval touches. An end that lands exactly on local midnight
 * does not spill onto the next day. Capped so a bad end date can't explode the DOM.
 */
export function eventDayKeys(start: DateInput, end: DateInput | null | undefined, timeZone: string, maxDays = 62): DayKey[] {
  const iv = toInterval(start, end);
  const first = localDayKey(new Date(iv.startMs), timeZone);
  if (!iv.hasEnd) return [first];
  let last = localDayKey(new Date(iv.endMs), timeZone);
  if (localMinutes(new Date(iv.endMs), timeZone) === 0 && last !== first) last = addDays(last, -1);
  const span = Math.min(diffDays(first, last), maxDays - 1);
  return Array.from({ length: span + 1 }, (_, i) => addDays(first, i));
}

export interface DaySegment {
  /** Minutes from local midnight of the given day, clipped to [0, 1440]. */
  startMin: number;
  endMin: number;
}

/** Portion of an interval that falls on local day `key`, or null if none. Point events get `pointMinutes` of height. */
export function segmentForDay(start: DateInput, end: DateInput | null | undefined, key: DayKey, timeZone: string, pointMinutes = 30): DaySegment | null {
  const iv = toInterval(start, end);
  const sKey = localDayKey(new Date(iv.startMs), timeZone);
  const startAbs = diffDays(key, sKey) * 1440 + localMinutes(new Date(iv.startMs), timeZone);
  let endAbs: number;
  if (iv.hasEnd) {
    const eKey = localDayKey(new Date(iv.endMs), timeZone);
    endAbs = diffDays(key, eKey) * 1440 + localMinutes(new Date(iv.endMs), timeZone);
  } else {
    endAbs = startAbs + pointMinutes;
  }
  if (endAbs <= 0 || startAbs >= 1440) return null;
  return { startMin: Math.max(0, startAbs), endMin: Math.min(1440, endAbs) };
}

// ---------------------------------------------------------------------------
// Overlap lanes (day/week columns)
// ---------------------------------------------------------------------------
export interface LaneInput {
  id: string;
  startMin: number;
  endMin: number;
}
export interface LanePlacement {
  lane: number;
  /** Number of lanes in this event's overlap cluster (its width divisor). */
  lanes: number;
}

/**
 * Greedy interval colouring per connected overlap cluster: events that overlap
 * (directly or through a chain) get distinct lanes; events in an isolated
 * cluster keep full width. Touching intervals (end == start) do not overlap.
 */
export function assignLanes(items: LaneInput[]): Map<string, LanePlacement> {
  const sorted = [...items].sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin || a.id.localeCompare(b.id));
  const result = new Map<string, LanePlacement>();
  let cluster: { id: string; lane: number }[] = [];
  let laneEnds: number[] = [];
  let clusterEnd = -Infinity;

  const flush = () => {
    for (const c of cluster) result.set(c.id, { lane: c.lane, lanes: laneEnds.length });
    cluster = [];
    laneEnds = [];
    clusterEnd = -Infinity;
  };

  for (const it of sorted) {
    if (it.startMin >= clusterEnd) flush();
    let lane = laneEnds.findIndex((end) => end <= it.startMin);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(it.endMin);
    } else {
      laneEnds[lane] = it.endMin;
    }
    cluster.push({ id: it.id, lane });
    clusterEnd = Math.max(clusterEnd, it.endMin);
  }
  flush();
  return result;
}

// ---------------------------------------------------------------------------
// Gantt geometry
// ---------------------------------------------------------------------------
export interface GanttBar {
  /** Percent (0..100) of the scale width. */
  leftPct: number;
  widthPct: number;
  visible: boolean;
  /** No end date on the source item: the bar runs to the right edge and must be labelled "Ongoing". */
  openEnded: boolean;
  clippedStart: boolean;
  clippedEnd: boolean;
}

/** Local position of an instant on a day-indexed axis: 0 = start of `rangeStart`, 1 = start of the next day. */
function dayPosition(input: DateInput, rangeStart: DayKey, timeZone: string): number {
  const p = zonedParts(input, timeZone);
  return diffDays(rangeStart, p.key) + (p.hour * 60 + p.minute) / 1440;
}

/**
 * Position an item on an inclusive `[rangeStart, rangeEnd]` day range. Open-ended
 * items (no end) run to the right edge - an end date is never invented. Items are
 * clamped to the range; `visible` is false when nothing overlaps it.
 */
export function ganttBar(start: DateInput, end: DateInput | null | undefined, rangeStart: DayKey, rangeEnd: DayKey, timeZone: string): GanttBar {
  const total = diffDays(rangeStart, rangeEnd) + 1;
  const s = dayPosition(start, rangeStart, timeZone);
  const hasEnd = end != null && Number.isFinite(toDate(end).getTime()) && toDate(end).getTime() > toDate(start).getTime();
  const e = hasEnd ? dayPosition(end as DateInput, rangeStart, timeZone) : total;
  const visible = e > 0 && s < total;
  if (!visible) return { leftPct: 0, widthPct: 0, visible: false, openEnded: !hasEnd, clippedStart: s < 0, clippedEnd: e > total };
  const cs = Math.max(0, s);
  const ce = Math.min(total, e);
  return {
    leftPct: (cs / total) * 100,
    widthPct: ((ce - cs) / total) * 100,
    visible: true,
    openEnded: !hasEnd,
    clippedStart: s < 0,
    clippedEnd: e > total,
  };
}

export type GanttUnit = "day" | "week" | "month";
export interface GanttTick {
  key: DayKey;
  leftPct: number;
  unit: GanttUnit;
}

/** Tick unit by span: <= 21 days -> days, <= 120 -> Monday weeks, else month starts. */
export function ganttUnit(totalDays: number): GanttUnit {
  return totalDays <= 21 ? "day" : totalDays <= 120 ? "week" : "month";
}

export function ganttTicks(rangeStart: DayKey, rangeEnd: DayKey): { unit: GanttUnit; ticks: GanttTick[]; totalDays: number } {
  const totalDays = diffDays(rangeStart, rangeEnd) + 1;
  const unit = ganttUnit(totalDays);
  const ticks: GanttTick[] = [];
  for (let i = 0; i < totalDays; i++) {
    const key = addDays(rangeStart, i);
    const isTick = unit === "day" || (unit === "week" ? weekdayOf(key) === 1 : key.endsWith("-01"));
    if (isTick) ticks.push({ key, leftPct: (i / totalDays) * 100, unit });
  }
  return { unit, ticks, totalDays };
}

/** Pixels per day for the scrollable scale, by span (keeps bars readable without a huge canvas). */
export function ganttPxPerDay(totalDays: number): number {
  return totalDays <= 21 ? 44 : totalDays <= 120 ? 16 : 5;
}

// ---------------------------------------------------------------------------
// Display formatting (always in the supplied time zone)
// ---------------------------------------------------------------------------
export function formatTime(input: DateInput, timeZone: string): string {
  return fmt(timeZone, { hour: "numeric", minute: "2-digit", hour12: true }).format(toDate(input)).replace(/\s/g, " ");
}

export function formatKey(key: DayKey, opts: Intl.DateTimeFormatOptions): string {
  return fmt("UTC", opts).format(keyToUtcNoon(key));
}

export function formatDayLong(key: DayKey): string {
  return formatKey(key, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

export function formatDayShort(key: DayKey): string {
  return formatKey(key, { weekday: "short", day: "numeric", month: "short" });
}

/** Header title for a span: "Tuesday, 29 September 2026" / "28 Sep - 4 Oct 2026" / "September 2026". */
export function formatSpanTitle(span: CalendarSpan, key: DayKey, weekStartsOn: WeekStart = 1): string {
  if (span === "day") return formatDayLong(key);
  if (span === "month") return formatKey(key, { month: "long", year: "numeric" });
  const days = weekDays(key, weekStartsOn);
  const a = days[0];
  const b = days[6];
  const sameYear = a.slice(0, 4) === b.slice(0, 4);
  const left = formatKey(a, sameYear ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" });
  const right = formatKey(b, { day: "numeric", month: "short", year: "numeric" });
  return `${left} – ${right}`;
}

/** Current local time as minutes-from-midnight plus its day key, for the "now" line. */
export function nowInZone(now: Date, timeZone: string): { key: DayKey; minutes: number } {
  const p = zonedParts(now, timeZone);
  return { key: p.key, minutes: p.hour * 60 + p.minute };
}
