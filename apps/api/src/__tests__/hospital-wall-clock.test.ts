import { describe, expect, it } from "vitest";
import { dayKeyIn, minutesOfDayIn, zonedWallTime } from "../lib/hospital-time.js";
import { demoNow, todaySlot } from "../seed/demo/demo-clock.js";
import { daysFromNow } from "../seed/demo/shared.js";

// The test process runs in UTC (vitest.config.ts). The hospital is in IST. Between 18:30 and 24:00 UTC the two are on
// different calendar days — exactly when a cloud server used to seed "today's" queue onto the wrong hospital day.
const IST = "Asia/Kolkata";

describe("hospital wall clock", () => {
  it("turns a hospital wall time into the right instant", () => {
    expect(zonedWallTime("2026-10-02", 11, 0, IST).toISOString()).toBe("2026-10-02T05:30:00.000Z");
    expect(zonedWallTime("2026-10-02", 0, 15, IST).toISOString()).toBe("2026-10-01T18:45:00.000Z");
    expect(zonedWallTime("2026-03-08", 12, 0, "America/New_York").toISOString()).toBe("2026-03-08T16:00:00.000Z"); // DST day
  });

  it("reads minutes-of-day in the hospital's zone", () => {
    expect(minutesOfDayIn(new Date("2026-10-01T19:00:00Z"), IST)).toBe(30); // 00:30 IST
    expect(dayKeyIn(new Date("2026-10-01T19:00:00Z"), IST)).toBe("2026-10-02");
  });
});

describe("demo clock (seed)", () => {
  it("demo 'now' is on the HOSPITAL's day, clamped into clinic hours — before hospital midnight", () => {
    const now = new Date("2026-10-01T18:00:00Z"); // 23:30 IST on 1 Oct
    const d = demoNow(now);
    expect(dayKeyIn(d, IST)).toBe("2026-10-01");
    expect(minutesOfDayIn(d, IST)).toBe(17 * 60 + 30);
  });

  it("…and after hospital midnight, while UTC is still on the previous day", () => {
    const now = new Date("2026-10-01T19:00:00Z"); // 00:30 IST on 2 Oct
    const d = demoNow(now);
    expect(dayKeyIn(d, IST)).toBe("2026-10-02");
    expect(minutesOfDayIn(d, IST)).toBe(11 * 60);
    for (const status of ["completed", "waiting", "scheduled"] as const) expect(dayKeyIn(todaySlot(status, 0, now), IST)).toBe("2026-10-02");
  });

  it("relative seed days are hospital days at hospital wall times", () => {
    const now = new Date("2026-10-01T19:00:00Z"); // 00:30 IST on 2 Oct
    const d = daysFromNow(1, 10, 0, now);
    expect(d.toISOString()).toBe("2026-10-03T04:30:00.000Z"); // 10:00 IST on 3 Oct
  });
});
