import type { ClinicHours, ClinicHoursDay } from "@pulseos/types";

// The date and time pickers already hold the hospital's wall time (see hospitalLocalInput / toInstant), so the weekday of
// "YYYY-MM-DD" and a plain "HH:MM" comparison are exact: no timezone arithmetic is involved.
const KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const LONG = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/** Index into mon..sun for a "YYYY-MM-DD" date, or -1. */
function weekdayIndex(date: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return -1;
  return (new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay() + 6) % 7;
}

const same = (a: ClinicHoursDay, b: ClinicHoursDay) => (a === null || b === null ? a === b : a[0] === b[0] && a[1] === b[1]);

/** "Clinic hours: Mon–Sat 09:00–16:00, Sunday closed", built from the data. Null when the hospital set no hours. */
export function clinicHoursHint(hours: ClinicHours | null | undefined): string | null {
  if (!hours) return null;
  const days = KEYS.map((k) => hours[k] ?? null);
  const parts: string[] = [];
  for (let i = 0; i < 7; ) {
    let j = i;
    while (j + 1 < 7 && same(days[j + 1]!, days[i]!)) j++;
    const d = days[i]!;
    const name = i === j ? (d ? SHORT[i]! : LONG[i]!) : `${SHORT[i]}–${SHORT[j]}`;
    parts.push(d ? `${name} ${d[0]}–${d[1]}` : `${name} closed`);
    i = j + 1;
  }
  return `Clinic hours: ${parts.join(", ")}`;
}

/** Why this hospital wall date/time cannot be booked, or null when it is fine (or no hours are set / the value is incomplete). */
export function clinicHoursError(hours: ClinicHours | null | undefined, date: string, time: string): string | null {
  if (!hours || !date) return null;
  const i = weekdayIndex(date);
  if (i < 0) return null;
  const day = hours[KEYS[i]!] ?? null;
  if (!day) return `The clinic is closed on ${LONG[i]}s. Choose another day.`;
  if (!time) return null;
  if (time < day[0] || time >= day[1]) return `Choose a time between ${day[0]} and ${day[1]} (clinic hours).`;
  return null;
}

/** min / max for a time input on `date`: open, and the last minute before close. Null when unrestricted or closed. */
export function clinicTimeBounds(hours: ClinicHours | null | undefined, date: string): { min: string; max: string } | null {
  const i = weekdayIndex(date);
  const day = hours && i >= 0 ? hours[KEYS[i]!] ?? null : null;
  if (!day) return null;
  const [h, m] = day[1].split(":").map(Number) as [number, number];
  const last = h * 60 + m - 1;
  return { min: day[0], max: `${String(Math.floor(last / 60)).padStart(2, "0")}:${String(last % 60).padStart(2, "0")}` };
}

/** The clinic's hours on one hospital date: `null` = no hours set (no restriction), "closed", or [open, close]. */
export function clinicHoursOn(hours: ClinicHours | null | undefined, date: string): ClinicHoursDay | "closed" | null {
  if (!hours) return null;
  const i = weekdayIndex(date);
  if (i < 0) return null;
  return hours[KEYS[i]!] ?? "closed";
}
