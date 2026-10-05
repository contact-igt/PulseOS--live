import { describe, expect, it } from "vitest";
import { instantToWallTime, wallTimeToInstant } from "../hospitalTime";

describe("hospital-timezone wall time", () => {
  it("11:00 on a day in Asia/Kolkata is 05:30 UTC, whatever the browser's zone", () => {
    expect(wallTimeToInstant("2026-10-02", "11:00", "Asia/Kolkata")?.toISOString()).toBe("2026-10-02T05:30:00.000Z");
  });
  it("round-trips through the hospital zone, including across midnight", () => {
    const i = wallTimeToInstant("2026-10-02", "00:30", "Asia/Kolkata")!;
    expect(i.toISOString()).toBe("2026-10-01T19:00:00.000Z");
    expect(instantToWallTime(i, "Asia/Kolkata")).toEqual({ date: "2026-10-02", time: "00:30" });
  });
  it("handles a zone with daylight saving", () => {
    expect(wallTimeToInstant("2026-07-01", "09:00", "America/New_York")?.toISOString()).toBe("2026-07-01T13:00:00.000Z");
    expect(wallTimeToInstant("2026-01-01", "09:00", "America/New_York")?.toISOString()).toBe("2026-01-01T14:00:00.000Z");
  });
  it("rejects malformed input", () => {
    expect(wallTimeToInstant("2026-10-2", "11:00", "Asia/Kolkata")).toBeNull();
    expect(wallTimeToInstant("2026-10-02", "11am", "Asia/Kolkata")).toBeNull();
  });
});
