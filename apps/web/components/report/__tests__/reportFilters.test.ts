import { describe, expect, it } from "vitest";
import { ANALYTICS_CONFIG, activeReportChips, customDefaults, periodLabel, readReportFilters, reportFilterPatch, resetReportPatch } from "../reportFilters";

const UUID = "0b482130-f32a-41d3-8e4d-e4794ebab621";
const from = (params: Record<string, string>) => (k: string) => params[k] ?? "";

describe("report filters in the URL", () => {
  it("defaults to the last 7 days and ignores junk", () => {
    expect(readReportFilters(from({}), "2026-10-02")).toEqual({ range: "7d" });
    expect(readReportFilters(from({ rRange: "forever", rBranch: "x", rSource: "1" }), "2026-10-02")).toEqual({ range: "7d" });
  });

  it("keeps a valid custom range and drops an invalid or future one", () => {
    expect(readReportFilters(from({ rRange: "custom", rFrom: "2026-09-01", rTo: "2026-09-30" }), "2026-10-02")).toEqual({ range: "custom", from: "2026-09-01", to: "2026-09-30" });
    expect(readReportFilters(from({ rRange: "custom", rFrom: "2026-09-30", rTo: "2026-09-01" }), "2026-10-02").range).toBe("7d");
    expect(readReportFilters(from({ rRange: "custom", rFrom: "2026-10-01", rTo: "2026-10-05" }), "2026-10-02").range).toBe("7d");
    expect(readReportFilters(from({ rRange: "custom", rFrom: "2026-02-30", rTo: "2026-03-01" }), "2026-10-02").range).toBe("7d");
  });

  it("reads every filter", () => {
    expect(readReportFilters(from({ rRange: "this_month", rBranch: UUID, rService: "Cataract", rSource: UUID, rOwner: UUID, rDoctor: UUID }), "2026-10-02")).toEqual({
      range: "this_month", branchId: UUID, service: "Cataract", sourceId: UUID, ownerId: UUID, doctorId: UUID,
    });
  });

  it("writes patches: leaving custom clears its dates; the default range is not written", () => {
    expect(reportFilterPatch({ range: "30d" })).toEqual({ rRange: "30d", rFrom: undefined, rTo: undefined });
    expect(reportFilterPatch({ range: "7d" })).toEqual({ rRange: undefined, rFrom: undefined, rTo: undefined });
    expect(reportFilterPatch({ range: "custom", from: "2026-09-01", to: "2026-09-02" })).toEqual({ rRange: "custom", rFrom: "2026-09-01", rTo: "2026-09-02" });
    expect(reportFilterPatch({ sourceId: "" })).toEqual({ rSource: undefined });
    expect(Object.values(resetReportPatch()).every((v) => v === undefined)).toBe(true);
    expect(Object.keys(resetReportPatch())).toContain("rDoctor");
  });

  it("labels periods and chips in plain words", () => {
    expect(periodLabel("2026-10-02", "2026-10-02")).toBe("2 Oct 2026");
    expect(periodLabel("2026-09-26", "2026-10-02")).toBe("26 Sep – 2 Oct 2026");
    expect(periodLabel("2025-12-28", "2026-01-03")).toBe("28 Dec 2025 – 3 Jan 2026");
    expect(customDefaults("2026-10-02")).toEqual({ from: "2026-09-26", to: "2026-10-02" });
    const chips = activeReportChips({ branchId: UUID, service: "Cataract", doctorId: "missing" }, { branches: [{ id: UUID, name: "Andheri" }], departments: [], services: [], sources: [], owners: [], doctors: [] });
    expect(chips.map((c) => c.label)).toEqual(["Branch: Andheri", "Service: Cataract", "Doctor: … (visits & surgeries)"]);
  });

  it("the Analytics workspace has its own keys and a 30-day default, so it never collides with Marketing analytics' range / branch / source", () => {
    expect(readReportFilters(from({}), "2026-10-02", ANALYTICS_CONFIG)).toEqual({ range: "30d" });
    expect(readReportFilters(from({ range: "7d", branch: UUID }), "2026-10-02", ANALYTICS_CONFIG)).toEqual({ range: "30d" }); // Marketing's keys are not ours
    expect(readReportFilters(from({ aRange: "last_month", aDept: UUID, aSource: UUID, aDoctor: UUID }), "2026-10-02", ANALYTICS_CONFIG)).toEqual({ range: "prev_month", departmentId: UUID, sourceId: UUID, doctorId: UUID });
    expect(reportFilterPatch({ range: "30d" }, ANALYTICS_CONFIG)).toEqual({ aRange: undefined, aFrom: undefined, aTo: undefined });
    expect(reportFilterPatch({ range: "custom", from: "2026-09-01", to: "2026-09-02", departmentId: UUID }, ANALYTICS_CONFIG)).toEqual({ aRange: "custom", aFrom: "2026-09-01", aTo: "2026-09-02", aDept: UUID });
    expect(Object.keys(resetReportPatch(ANALYTICS_CONFIG)).every((k) => k.startsWith("a"))).toBe(true);
  });

  it("a Department chip names the department", () => {
    expect(activeReportChips({ departmentId: UUID }, { branches: [], departments: [{ id: UUID, name: "Eye Care" }], services: [], sources: [], owners: [], doctors: [] }).map((c) => c.label)).toEqual(["Department: Eye Care"]);
  });

  it("a custom span over a year falls back to the default (the server would refuse it)", () => {
    expect(readReportFilters(from({ rRange: "custom", rFrom: "2025-01-01", rTo: "2026-10-01" }), "2026-10-02").range).toBe("7d");
    expect(readReportFilters(from({ rRange: "custom", rFrom: "2025-10-02", rTo: "2026-10-01" }), "2026-10-02").range).toBe("custom"); // exactly 365 days
  });
});
