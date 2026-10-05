import { describe, expect, it } from "vitest";
import { dayLabel } from "../DayNavigator";

describe("dayLabel", () => {
  const today = "2026-10-03"; // a Saturday

  it("names today, yesterday and tomorrow - always with the date", () => {
    expect(dayLabel("2026-10-03", today)).toBe("Today · Sat, 3 Oct");
    expect(dayLabel("2026-10-02", today)).toBe("Yesterday · Fri, 2 Oct");
    expect(dayLabel("2026-10-04", today)).toBe("Tomorrow · Sun, 4 Oct");
  });

  it("shows just the weekday and date for any other day", () => {
    expect(dayLabel("2026-10-10", today)).toBe("Sat, 10 Oct");
    expect(dayLabel("2026-09-28", today)).toBe("Mon, 28 Sept");
  });

  it("works across a month and year boundary", () => {
    expect(dayLabel("2027-01-01", "2026-12-31")).toBe("Tomorrow · Fri, 1 Jan");
    expect(dayLabel("2026-12-31", "2027-01-01")).toBe("Yesterday · Thu, 31 Dec");
  });
});
