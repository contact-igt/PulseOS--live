import { describe, expect, it } from "vitest";
import { DEMO_TIMEZONE, demoNow, todaySlot } from "../demo-clock.js";
import { dayKeyIn, minutesOfDayIn, zonedWallTime } from "../../../lib/hospital-time.js";

// Hospital wall time (IST), whatever zone the test process runs in (UTC, see vitest.config.ts).
const at = (h: number, m = 0) => zonedWallTime("2026-09-29", h, m, DEMO_TIMEZONE);
const mins = (d: Date) => minutesOfDayIn(d, DEMO_TIMEZONE);

describe("demoNow", () => {
  it("clamps early-morning and late-evening seeding into clinic hours, on the same day", () => {
    expect(mins(demoNow(at(6, 5)))).toBe(11 * 60);
    expect(mins(demoNow(at(23, 40)))).toBe(17 * 60 + 30);
    expect(dayKeyIn(demoNow(at(23, 40)), DEMO_TIMEZONE)).toBe("2026-09-29");
    expect(mins(demoNow(at(14, 22)))).toBe(14 * 60 + 15);
  });
});

describe.each([[6, 0], [9, 0], [12, 30], [16, 45], [21, 15]])("todaySlot when seeded at %i:%i", (h, m) => {
  const now = at(h, m);
  const dn = demoNow(now).getTime();
  it("keeps in-clinic patients in the past and upcoming visits in the future of the demo clock", () => {
    for (const status of ["completed", "with_doctor", "waiting", "checked_in"] as const) {
      expect(todaySlot(status, 0, now).getTime(), status).toBeLessThanOrEqual(dn);
    }
    for (const status of ["confirmed", "scheduled"] as const) expect(todaySlot(status, 0, now).getTime(), status).toBeGreaterThan(dn);
  });
  it("staggers several completed visits and never places one before clinic opens", () => {
    const times = [0, 1, 2].map((i) => todaySlot("completed", i, now));
    expect(new Set(times.map((t) => t.getTime())).size).toBeGreaterThan(1);
    for (const t of times) expect(mins(t)).toBeGreaterThanOrEqual(8 * 60);
  });
  it("is deterministic for a given moment", () => {
    expect(todaySlot("waiting", 1, now).getTime()).toBe(todaySlot("waiting", 1, now).getTime());
  });
});
