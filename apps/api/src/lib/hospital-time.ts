import { eq, sql, type SQL } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { tenants } from "../db/schema.js";

// Hospital-local time. Every "today", day boundary and day bucket in PulseOS
// is a calendar day in the tenant's zone (tenants.timezone, carried on the
// session as `timezone`) — never UTC and never the API server's clock zone.

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

// --- Pure calendar arithmetic on YYYY-MM-DD strings (no timezone involved) ---

export function isRealDate(ymd: string): boolean {
  if (!YMD.test(ymd)) return false;
  const d = new Date(`${ymd}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === ymd;
}

export function addDays(ymd: string, n: number): string {
  return new Date(new Date(`${ymd}T00:00:00Z`).getTime() + n * DAY_MS).toISOString().slice(0, 10);
}

/** b - a in whole calendar days. */
export function diffDays(a: string, b: string): number {
  return Math.round((new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime()) / DAY_MS);
}

// --- Timezone SQL ---

/**
 * The tenant timezone as an inlined SQL string literal. It is inlined (not a
 * bind parameter) so `GROUP BY` / `SELECT` expressions containing it are
 * textually identical. The value comes from tenants.timezone — never from a
 * request — and is still whitelisted by shape.
 */
export function tzLiteral(timezone: string): SQL {
  if (!/^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/.test(timezone)) throw new Error(`Invalid timezone: ${timezone}`);
  return sql.raw(`'${timezone}'`);
}

/** Local calendar day (YYYY-MM-DD, in the tenant's zone) of a timestamptz column. */
export function localDay(column: unknown, timezone: string): SQL<string> {
  return sql<string>`to_char(${column} at time zone ${tzLiteral(timezone)}, 'YYYY-MM-DD')`;
}

/** `column` falls on a local day between `from` and `to` inclusive, in the tenant's zone (DST-safe). */
export function inLocalRange(column: unknown, timezone: string, from: string, to: string): SQL {
  const tz = tzLiteral(timezone);
  return sql`${column} >= (${from}::date)::timestamp at time zone ${tz} and ${column} < ((${to}::date + 1))::timestamp at time zone ${tz}`;
}

export async function tenantTimezone(db: Db, tenantId: string): Promise<string> {
  const [row] = await db.select({ timezone: tenants.timezone }).from(tenants).where(eq(tenants.id, tenantId));
  return row?.timezone ?? "Asia/Kolkata";
}

/** The local calendar day `now` falls on in `timezone`. */
export async function localToday(db: Db, timezone: string, now: Date): Promise<string> {
  const rows = await db.execute<{ d: string }>(sql`select to_char(${now.toISOString()}::timestamptz at time zone ${tzLiteral(timezone)}, 'YYYY-MM-DD') as d`);
  return [...rows][0].d;
}



/** [start, end) of the hospital-local day containing `now()`, as SQL instants (DST-safe). */
export function hospitalTodayBounds(timezone: string): { start: SQL; end: SQL } {
  const tz = tzLiteral(timezone);
  return {
    start: sql`((now() at time zone ${tz})::date)::timestamp at time zone ${tz}`,
    end: sql`((now() at time zone ${tz})::date + 1)::timestamp at time zone ${tz}`,
  };
}

/** Local calendar day (YYYY-MM-DD) of an instant in `timezone` — the JS twin of `localDay`. */
export function dayKeyIn(instant: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(instant);
}

// --- Hospital wall clock in JS (seed data, due-time offsets) ---

function zoneOffsetMs(utcMs: number, timezone: string): number {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const p = Object.fromEntries(f.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** The instant a hospital wall time ("2026-10-02" 11:00 in `timezone`) happens at (DST-safe). */
export function zonedWallTime(ymd: string, hour: number, minute: number, timezone: string): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  const guess = Date.UTC(y!, m! - 1, d!, hour, minute);
  let result = guess - zoneOffsetMs(guess, timezone);
  result = guess - zoneOffsetMs(result, timezone);
  return new Date(result);
}

/** Minutes since local midnight of an instant in `timezone`. */
export function minutesOfDayIn(instant: Date, timezone: string): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: timezone, hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).formatToParts(instant).map((x) => [x.type, x.value]),
  );
  return Number(p.hour) * 60 + Number(p.minute);
}

/**
 * An instant from a client. An explicit instant ("…Z" or "+05:30") is kept as is; an offset-less local date-time
 * ("2026-10-02T09:00") is the HOSPITAL's wall time — never the API server's zone. Null when it is not a real date-time.
 */
export function parseInstant(value: unknown, timezone: string): Date | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const v = value.trim();
  const local = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/.exec(v);
  if (local) {
    const [, ymd, hh, mm, ss] = local;
    if (!isRealDate(ymd!) || Number(hh) > 23 || Number(mm) > 59 || Number(ss ?? 0) > 59) return null;
    const at = zonedWallTime(ymd!, Number(hh), Number(mm), timezone);
    // A wall time inside a DST gap does not exist (02:30 on spring-forward day): it must not quietly become another hour.
    const back = dayKeyIn(at, timezone) === ymd && minutesOfDayIn(at, timezone) === Number(hh) * 60 + Number(mm);
    if (!back) return null;
    return new Date(at.getTime() + Number(ss ?? 0) * 1000);
  }
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(v)) return null; // a bare date or anything else ambiguous is refused
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}
