import { describe, expect, it } from "vitest";
import { DATE_PRESETS, REPORT_RANGES, resolveDatePreset } from "@pulseos/types";
import { resolveReportRange } from "../domain/report/report-period.js";

describe("shared date presets (hospital-local days, pure)", () => {
  it("offers exactly Today, Yesterday, Last 7/9/30/90 days, This month, Previous month, Custom — one list for every filter", () => {
    expect(DATE_PRESETS.map((p) => p.key)).toEqual(["today", "yesterday", "7d", "9d", "30d", "90d", "this_month", "prev_month", "custom"]);
    expect(REPORT_RANGES.map((r) => r.key)).toEqual(DATE_PRESETS.map((p) => p.key));
  });

  it("resolves every preset against the hospital's today", () => {
    const today = "2026-10-02";
    expect(resolveDatePreset("today", today)).toEqual({ from: "2026-10-02", to: "2026-10-02" });
    expect(resolveDatePreset("yesterday", today)).toEqual({ from: "2026-10-01", to: "2026-10-01" });
    expect(resolveDatePreset("7d", today)).toEqual({ from: "2026-09-26", to: "2026-10-02" });
    expect(resolveDatePreset("9d", today)).toEqual({ from: "2026-09-24", to: "2026-10-02" });
    expect(resolveDatePreset("30d", today)).toEqual({ from: "2026-09-03", to: "2026-10-02" });
    expect(resolveDatePreset("90d", today)).toEqual({ from: "2026-07-05", to: "2026-10-02" });
    expect(resolveDatePreset("this_month", today)).toEqual({ from: "2026-10-01", to: "2026-10-02" });
    expect(resolveDatePreset("prev_month", today)).toEqual({ from: "2026-09-01", to: "2026-09-30" });
  });

  it("month boundaries: first day of month, leap February, January → December", () => {
    expect(resolveDatePreset("this_month", "2026-10-01")).toEqual({ from: "2026-10-01", to: "2026-10-01" });
    expect(resolveDatePreset("prev_month", "2028-03-10")).toEqual({ from: "2028-02-01", to: "2028-02-29" }); // leap year
    expect(resolveDatePreset("prev_month", "2026-03-15")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(resolveDatePreset("prev_month", "2026-01-05")).toEqual({ from: "2025-12-01", to: "2025-12-31" });
    expect(resolveDatePreset("yesterday", "2026-01-01")).toEqual({ from: "2025-12-31", to: "2025-12-31" });
  });

  it("older links keep working: 14d and last_month still resolve, to the same days as before", () => {
    expect(resolveDatePreset("14d", "2026-10-02")).toEqual({ from: "2026-09-19", to: "2026-10-02" });
    expect(resolveDatePreset("last_month", "2026-10-02")).toEqual(resolveDatePreset("prev_month", "2026-10-02"));
  });

  it("the operations report resolver is the same function (no second set of rules), and custom still validates", () => {
    for (const p of DATE_PRESETS.filter((x) => x.key !== "custom")) expect(resolveReportRange(p.key, "2026-10-02")).toEqual(resolveDatePreset(p.key as never, "2026-10-02"));
    expect(() => resolveReportRange("custom", "2026-10-02", "2026-10-05", "2026-10-02")).toThrow();
    expect(() => resolveReportRange("custom", "2026-10-02", "2026-10-01", "2026-10-09")).toThrow(); // future end
    expect(resolveReportRange("custom", "2026-10-02", "2026-09-01", "2026-09-09")).toEqual({ from: "2026-09-01", to: "2026-09-09" });
  });
});
