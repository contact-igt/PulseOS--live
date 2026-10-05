import { describe, expect, it } from "vitest";
import {
  addDays,
  assignLanes,
  dayStartInstant,
  eventDayKeys,
  formatSpanTitle,
  formatTime,
  ganttBar,
  ganttTicks,
  localDayKey,
  monthGrid,
  segmentForDay,
  shiftDate,
  startOfWeek,
  visibleRange,
  weekDays,
} from "../views/dates";

const IST = "Asia/Kolkata";
const UTC = "UTC";

describe("localDayKey (tenant time zone, never UTC)", () => {
  it("2026-09-28T20:00:00Z is 29 Sep in IST but 28 Sep in UTC", () => {
    expect(localDayKey("2026-09-28T20:00:00Z", IST)).toBe("2026-09-29");
    expect(localDayKey("2026-09-28T20:00:00Z", UTC)).toBe("2026-09-28");
  });

  it("the other direction: 2026-09-29T19:00:00Z is 30 Sep IST, but 2026-09-29T18:29:00Z is still 29 Sep IST", () => {
    expect(localDayKey("2026-09-29T19:00:00Z", IST)).toBe("2026-09-30");
    expect(localDayKey("2026-09-29T18:29:00Z", IST)).toBe("2026-09-29");
    expect(localDayKey("2026-09-29T18:30:00Z", IST)).toBe("2026-09-30");
  });

  it("2026-09-29T00:10:00Z is 29 Sep both ways, 2026-09-28T23:59:00Z is 29 Sep in IST only", () => {
    expect(localDayKey("2026-09-29T00:10:00Z", IST)).toBe("2026-09-29");
    expect(localDayKey("2026-09-28T23:59:00Z", IST)).toBe("2026-09-29");
    expect(localDayKey("2026-09-28T23:59:00Z", UTC)).toBe("2026-09-28");
  });

  it("accepts Date objects", () => {
    expect(localDayKey(new Date("2026-12-31T19:00:00Z"), IST)).toBe("2027-01-01");
  });
});

describe("dayStartInstant", () => {
  it("IST midnight is 18:30Z the previous day", () => {
    expect(dayStartInstant("2026-09-29", IST).toISOString()).toBe("2026-09-28T18:30:00.000Z");
    expect(dayStartInstant("2026-09-29", UTC).toISOString()).toBe("2026-09-29T00:00:00.000Z");
  });
});

describe("week and month grids", () => {
  it("weeks start on Monday by default", () => {
    // 2026-09-29 is a Tuesday
    expect(startOfWeek("2026-09-29")).toBe("2026-09-28");
    expect(weekDays("2026-09-27")[0]).toBe("2026-09-21"); // a Sunday belongs to the week that began Monday 21st
    expect(weekDays("2026-09-29")).toHaveLength(7);
    expect(weekDays("2026-09-29")[6]).toBe("2026-10-04");
  });

  it("supports Sunday-start weeks", () => {
    expect(startOfWeek("2026-09-29", 0)).toBe("2026-09-27");
  });

  it("month grid is always 6 x 7 and starts on the week containing the 1st", () => {
    for (const k of ["2026-02-10", "2026-09-29", "2026-05-01", "2027-02-01"]) {
      const g = monthGrid(k);
      expect(g).toHaveLength(6);
      g.forEach((row) => expect(row).toHaveLength(7));
    }
    const sep = monthGrid("2026-09-29");
    expect(sep[0][0].key).toBe("2026-08-31"); // Mon; 1 Sep 2026 is a Tuesday
    expect(sep[0][0].inMonth).toBe(false);
    expect(sep[0][1]).toEqual({ key: "2026-09-01", inMonth: true });
    expect(sep[5][6].key).toBe("2026-10-11");
  });

  it("visibleRange(month) is a superset of the week and day around the date", () => {
    const m = visibleRange("month", "2026-09-29");
    const w = visibleRange("week", "2026-09-29");
    expect(m.from <= w.from && m.to >= w.to).toBe(true);
    expect(visibleRange("day", "2026-09-29")).toEqual({ from: "2026-09-29", to: "2026-09-29" });
  });

  it("shiftDate clamps month-end days and steps day/week", () => {
    expect(shiftDate("2026-01-31", "month", 1)).toBe("2026-02-28");
    expect(shiftDate("2026-03-31", "month", -1)).toBe("2026-02-28");
    expect(shiftDate("2026-12-15", "month", 1)).toBe("2027-01-15");
    expect(shiftDate("2026-09-29", "week", -1)).toBe("2026-09-22");
    expect(shiftDate("2026-09-30", "day", 1)).toBe("2026-10-01");
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
  });

  it("formats span titles", () => {
    expect(formatSpanTitle("month", "2026-09-29")).toBe("September 2026");
    expect(formatSpanTitle("week", "2026-09-29")).toMatch(/28 Sep.*4 Oct 2026/);
  });
});

describe("event day bucketing and segments", () => {
  it("an event at 01:30 IST on the 29th (20:00Z on the 28th) buckets to the 29th and starts at 90 minutes", () => {
    const seg = segmentForDay("2026-09-28T20:00:00Z", "2026-09-28T20:30:00Z", "2026-09-29", IST);
    expect(seg).toEqual({ startMin: 90, endMin: 120 });
    // Wrong day (the UTC date) must NOT contain it.
    expect(segmentForDay("2026-09-28T20:00:00Z", "2026-09-28T20:30:00Z", "2026-09-28", IST)).toBeNull();
    expect(eventDayKeys("2026-09-28T20:00:00Z", "2026-09-28T20:30:00Z", IST)).toEqual(["2026-09-29"]);
  });

  it("a late-evening IST event (23:30 IST = 18:00Z) stays on its IST day, not the next UTC-based day", () => {
    expect(eventDayKeys("2026-09-29T18:00:00Z", undefined, IST)).toEqual(["2026-09-29"]);
    // ...and 00:30 IST the next day (19:00Z) is the 30th.
    expect(eventDayKeys("2026-09-29T19:00:00Z", undefined, IST)).toEqual(["2026-09-30"]);
  });

  it("an event crossing local midnight is split across both days; an end exactly at midnight does not spill", () => {
    // 23:00 IST 29th -> 01:00 IST 30th
    const start = "2026-09-29T17:30:00Z";
    const end = "2026-09-29T19:30:00Z";
    expect(eventDayKeys(start, end, IST)).toEqual(["2026-09-29", "2026-09-30"]);
    expect(segmentForDay(start, end, "2026-09-29", IST)).toEqual({ startMin: 23 * 60, endMin: 1440 });
    expect(segmentForDay(start, end, "2026-09-30", IST)).toEqual({ startMin: 0, endMin: 60 });
    // ends exactly 00:00 IST on the 30th
    expect(eventDayKeys("2026-09-29T17:30:00Z", "2026-09-29T18:30:00Z", IST)).toEqual(["2026-09-29"]);
  });

  it("point events (no end) get a default block height", () => {
    expect(segmentForDay("2026-09-29T04:30:00Z", undefined, "2026-09-29", IST)).toEqual({ startMin: 600, endMin: 630 });
  });

  it("formats times in the supplied zone", () => {
    expect(formatTime("2026-09-28T20:00:00Z", IST).toLowerCase()).toBe("1:30 am");
    expect(formatTime("2026-09-28T20:00:00Z", UTC).toLowerCase()).toBe("8:00 pm");
  });
});

describe("assignLanes", () => {
  it("overlapping events get distinct lanes and share the cluster width", () => {
    const p = assignLanes([
      { id: "a", startMin: 600, endMin: 660 },
      { id: "b", startMin: 630, endMin: 690 },
      { id: "c", startMin: 640, endMin: 700 },
    ]);
    expect(new Set([p.get("a")!.lane, p.get("b")!.lane, p.get("c")!.lane]).size).toBe(3);
    expect(p.get("a")!.lanes).toBe(3);
  });

  it("non-overlapping and touching events stay full width; lanes are reused after a gap", () => {
    const p = assignLanes([
      { id: "a", startMin: 600, endMin: 660 },
      { id: "b", startMin: 660, endMin: 720 },
      { id: "c", startMin: 900, endMin: 960 },
    ]);
    for (const id of ["a", "b", "c"]) expect(p.get(id)).toEqual({ lane: 0, lanes: 1 });
  });

  it("chains form one cluster and reuse a freed lane", () => {
    const p = assignLanes([
      { id: "a", startMin: 600, endMin: 660 },
      { id: "b", startMin: 630, endMin: 720 },
      { id: "c", startMin: 665, endMin: 700 }, // overlaps b only; can reuse a's lane
    ]);
    expect(p.get("c")!.lane).toBe(p.get("a")!.lane);
    expect(p.get("a")!.lanes).toBe(2);
  });
});

describe("gantt geometry", () => {
  const rs = "2026-09-01";
  const re = "2026-09-30"; // 30 days

  it("positions a bar by local start/end within the range", () => {
    const b = ganttBar("2026-09-10T00:00:00+05:30", "2026-09-20T00:00:00+05:30", rs, re, IST);
    expect(b.visible).toBe(true);
    expect(b.leftPct).toBeCloseTo((9 / 30) * 100, 5);
    expect(b.widthPct).toBeCloseTo((10 / 30) * 100, 5);
    expect(b.openEnded).toBe(false);
  });

  it("uses the local day, not the UTC day, for the start edge", () => {
    // 2026-09-09T20:00Z is 10 Sep 01:30 IST -> day index 9 + 90/1440
    const ist = ganttBar("2026-09-09T20:00:00Z", "2026-09-12T00:00:00Z", rs, re, IST);
    const utc = ganttBar("2026-09-09T20:00:00Z", "2026-09-12T00:00:00Z", rs, re, UTC);
    expect(ist.leftPct).toBeGreaterThan(((9) / 30) * 100);
    expect(utc.leftPct).toBeLessThan(((9 + 1) / 30) * 100);
    expect(ist.leftPct).toBeGreaterThan(utc.leftPct);
  });

  it("open-ended items run to the right edge and never invent an end", () => {
    const b = ganttBar("2026-09-20T00:00:00+05:30", null, rs, re, IST);
    expect(b.openEnded).toBe(true);
    expect(b.leftPct + b.widthPct).toBeCloseTo(100, 5);
    expect(ganttBar("2026-09-20T00:00:00+05:30", undefined, rs, re, IST).openEnded).toBe(true);
  });

  it("clamps to the range and flags clipped edges", () => {
    const b = ganttBar("2026-08-20T00:00:00+05:30", "2026-10-15T00:00:00+05:30", rs, re, IST);
    expect(b.leftPct).toBe(0);
    expect(b.widthPct).toBeCloseTo(100, 5);
    expect(b.clippedStart).toBe(true);
    expect(b.clippedEnd).toBe(true);
  });

  it("items entirely outside the range are not visible", () => {
    expect(ganttBar("2026-07-01T00:00:00Z", "2026-07-15T00:00:00Z", rs, re, IST).visible).toBe(false);
    expect(ganttBar("2026-11-01T00:00:00Z", "2026-11-15T00:00:00Z", rs, re, IST).visible).toBe(false);
    // ended before the range started
    expect(ganttBar("2026-08-01T00:00:00+05:30", "2026-09-01T00:00:00+05:30", rs, re, IST).visible).toBe(false);
  });

  it("chooses tick units by span", () => {
    expect(ganttTicks("2026-09-01", "2026-09-14").unit).toBe("day");
    const weeks = ganttTicks("2026-09-01", "2026-11-30");
    expect(weeks.unit).toBe("week");
    expect(weeks.ticks.every((t) => t.unit === "week")).toBe(true);
    const months = ganttTicks("2026-01-01", "2026-12-31");
    expect(months.unit).toBe("month");
    expect(months.ticks).toHaveLength(12);
  });
});
