// Wall-clock ↔ instant conversion in the HOSPITAL's timezone (tenants.timezone), never the browser's. A front desk
// typing "Friday 11:00" means 11:00 hospital time wherever the laptop happens to be.

function offsetMs(utcMs: number, timeZone: string): number {
  const f = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const p = Object.fromEntries(f.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** "2026-10-02" + "11:00" in `timeZone` → the instant. */
export function wallTimeToInstant(date: string, time: string, timeZone: string): Date | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = /^(\d{2}):(\d{2})$/.exec(time);
  if (!d || !t) return null;
  const guess = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]));
  let result = guess - offsetMs(guess, timeZone);
  result = guess - offsetMs(result, timeZone); // second pass settles a zone whose offset changes near the guess
  const out = new Date(result);
  return Number.isNaN(out.getTime()) ? null : out;
}

/** An instant as the hospital's local date (YYYY-MM-DD) and time (HH:mm). */
export function instantToWallTime(instant: Date, timeZone: string): { date: string; time: string } {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const p = Object.fromEntries(f.formatToParts(instant).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}
