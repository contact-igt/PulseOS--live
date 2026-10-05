import { describe, expect, it } from "vitest";
import { clickRangeDay, dayDisabled, monthGrid, monthOf, shiftMonth } from "../calendarGrid";

describe("monthGrid", () => {
  it("is six Sunday-first weeks that contain the whole month", () => {
    const g = monthGrid("2026-10");
    expect(g).toHaveLength(42);
    expect(g[0]).toBe("2026-09-27"); // 1 Oct 2026 is a Thursday
    expect(g[4]).toBe("2026-10-01");
    expect(g[41]).toBe("2026-11-07");
    expect(g.filter((d) => d.startsWith("2026-10"))).toHaveLength(31);
  });

  it("starts on the 1st when the month begins on a Sunday", () => {
    expect(monthGrid("2026-02")[0]).toBe("2026-02-01"); // Sunday
    expect(monthGrid("2026-02").filter((d) => d.startsWith("2026-02"))).toHaveLength(28);
  });

  it("handles a leap February and year boundaries", () => {
    expect(monthGrid("2028-02").filter((d) => d.startsWith("2028-02"))).toHaveLength(29);
    expect(monthGrid("2026-12")[41].startsWith("2027-01")).toBe(true);
  });
});

describe("month helpers", () => {
  it("names the month of a day and steps across years", () => {
    expect(monthOf("2026-10-03")).toBe("2026-10");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-03", -13)).toBe("2025-02");
  });
});

describe("dayDisabled", () => {
  const base = { today: "2026-10-03", allowFuture: false };
  it("disables the future unless it is allowed", () => {
    expect(dayDisabled("2026-10-04", base)).toBe(true);
    expect(dayDisabled("2026-10-03", base)).toBe(false);
    expect(dayDisabled("2026-10-04", { ...base, allowFuture: true })).toBe(false);
  });

  it("limits a half-picked range to the longest span the API accepts", () => {
    const o = { ...base, pendingFrom: "2026-09-20", maxSpanDays: 7 };
    expect(dayDisabled("2026-09-26", o)).toBe(false); // 7th day
    expect(dayDisabled("2026-09-27", o)).toBe(true); // 8th day
    expect(dayDisabled("2026-09-14", o)).toBe(false); // 6 days earlier is also the 7th day
    expect(dayDisabled("2026-09-13", o)).toBe(true); // 7 days earlier would be the 8th
  });
});

describe("clickRangeDay", () => {
  it("first click starts a range, second completes it, in order", () => {
    const a = clickRangeDay({ from: undefined, to: undefined }, "2026-09-10");
    expect(a).toEqual({ from: "2026-09-10", to: undefined });
    expect(clickRangeDay(a, "2026-09-14")).toEqual({ from: "2026-09-10", to: "2026-09-14" });
  });

  it("a second click before the start swaps the ends", () => {
    expect(clickRangeDay({ from: "2026-09-10", to: undefined }, "2026-09-02")).toEqual({ from: "2026-09-02", to: "2026-09-10" });
  });

  it("a click on a finished range starts a new one", () => {
    expect(clickRangeDay({ from: "2026-09-02", to: "2026-09-10" }, "2026-09-20")).toEqual({ from: "2026-09-20", to: undefined });
  });

  it("clicking the start again makes a one-day range", () => {
    expect(clickRangeDay({ from: "2026-09-10", to: undefined }, "2026-09-10")).toEqual({ from: "2026-09-10", to: "2026-09-10" });
  });
});
