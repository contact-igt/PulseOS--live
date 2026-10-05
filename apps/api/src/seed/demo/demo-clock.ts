// A stable "demo clock" for same-day seed data.
//
// Today's clinic queue (waiting / checked in / with doctor / completed /
// upcoming) must look plausible whenever the demo is seeded — 7 am or 9 pm —
// so appointment times are placed relative to a clinic-hours "demo now": the
// real time of day, clamped into 11:00–17:30. Seeded at 6 am the queue still
// reads as a busy mid-morning; at 11 pm it reads as the end of the clinic day,
// never a "waiting" patient scheduled hours in the future or an "upcoming"
// one already in the past.

import { dayKeyIn, minutesOfDayIn, zonedWallTime } from "../../lib/hospital-time.js";

/** Every demo tenant runs on India time; the seed reasons in hospital days, never the server's clock zone. */
export const DEMO_TIMEZONE = "Asia/Kolkata";

export const DEMO_NOW_EARLIEST_MINUTES = 11 * 60;
export const DEMO_NOW_LATEST_MINUTES = 17 * 60 + 30;
const CLINIC_OPENS_MINUTES = 8 * 60;

/** `now` with its hospital time of day clamped into clinic hours (same hospital calendar day). */
export function demoNow(now: Date = new Date()): Date {
  const minutes = minutesOfDayIn(now, DEMO_TIMEZONE);
  const clamped = Math.floor(Math.min(Math.max(minutes, DEMO_NOW_EARLIEST_MINUTES), DEMO_NOW_LATEST_MINUTES) / 15) * 15;
  return zonedWallTime(dayKeyIn(now, DEMO_TIMEZONE), Math.floor(clamped / 60), clamped % 60, DEMO_TIMEZONE);
}

type TodayStatus = "scheduled" | "confirmed" | "checked_in" | "waiting" | "with_doctor" | "completed" | "no_show" | "cancelled";

// Minutes relative to demo-now. Negative = already happened / arrived.
const MINUTES_BY_STATUS: Record<TodayStatus, { base: number; step: number }> = {
  completed: { base: -120, step: -30 }, // earlier ones finished earlier still
  with_doctor: { base: -30, step: -15 },
  waiting: { base: -45, step: -10 },
  checked_in: { base: -20, step: -10 },
  scheduled: { base: 120, step: 30 },
  confirmed: { base: 120, step: 30 },
  no_show: { base: -180, step: -30 },
  cancelled: { base: -180, step: -30 },
};

/**
 * Scheduled time for a same-day appointment given its status. `ordinal` is how
 * many earlier same-status appointments exist today, so several completed
 * visits are staggered instead of stacked on one minute.
 */
export function todaySlot(status: TodayStatus, ordinal: number, now: Date = new Date()): Date {
  const { base, step } = MINUTES_BY_STATUS[status];
  const slot = demoNow(now);
  const candidate = minutesOfDayIn(slot, DEMO_TIMEZONE) + base + step * ordinal;
  // Past slots may not precede opening; upcoming slots may not run past 19:00.
  const bounded = Math.round(Math.min(Math.max(candidate, CLINIC_OPENS_MINUTES), 19 * 60) / 15) * 15;
  return zonedWallTime(dayKeyIn(slot, DEMO_TIMEZONE), Math.floor(bounded / 60), bounded % 60, DEMO_TIMEZONE);
}
