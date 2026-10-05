import { afterEach, describe, expect, it, vi } from "vitest";
import { fmtDate, fmtDateTime, fmtSmartDateTime, fmtTime, getDisplayTimeZone, isSameHospitalDay, setDisplayTimeZone } from "../format";

// Every displayed date/time is in the HOSPITAL's timezone (tenants.timezone), never the browser's: a coordinator on a
// laptop set to UTC (or travelling) must see "11:00 am" for an 11:00 IST follow-up, not "05:30 am".
describe("hospital-timezone display", () => {
  const prevTz = process.env.TZ;
  afterEach(() => {
    vi.useRealTimers();
    setDisplayTimeZone("Asia/Kolkata");
    process.env.TZ = prevTz;
  });

  it("defaults to the India hospital zone and formats in it whatever the browser zone is", () => {
    process.env.TZ = "America/Los_Angeles";
    expect(getDisplayTimeZone()).toBe("Asia/Kolkata");
    // 05:30 UTC = 11:00 IST
    expect(fmtTime("2026-10-03T05:30:00Z")).toMatch(/11:00/i);
    expect(fmtDateTime("2026-10-03T05:30:00Z")).toMatch(/3 Oct.*11:00/);
    // 20:00 UTC on 2 Oct is already 3 Oct in India
    expect(fmtDate("2026-10-02T20:00:00Z")).toBe("3 Oct");
  });

  it("follows the zone the session sets", () => {
    setDisplayTimeZone("Asia/Dubai");
    expect(fmtTime("2026-10-03T05:30:00Z")).toMatch(/09:30/);
  });

  it("ignores an invalid zone instead of breaking every date on the page", () => {
    setDisplayTimeZone("Not/AZone");
    expect(getDisplayTimeZone()).toBe("Asia/Kolkata");
  });

  it("Today / Yesterday are hospital days: 00:30 IST is 'Today' even while UTC is still on the previous day", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T19:15:00Z")); // 00:45 IST on 2 Oct
    expect(fmtSmartDateTime("2026-10-01T19:00:00Z")).toMatch(/^Today, 12:30/i); // 00:30 IST 2 Oct
    expect(fmtSmartDateTime("2026-10-01T18:00:00Z")).toMatch(/^Yesterday, 11:30/i); // 23:30 IST 1 Oct
    expect(isSameHospitalDay("2026-10-01T19:00:00Z", "2026-10-01T18:00:00Z")).toBe(false);
    expect(isSameHospitalDay("2026-10-01T19:00:00Z", "2026-10-02T10:00:00Z")).toBe(true);
  });
});
