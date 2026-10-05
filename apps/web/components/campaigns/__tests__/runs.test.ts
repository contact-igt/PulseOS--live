import { describe, expect, it } from "vitest";
import type { CampaignViewRow } from "@pulseos/types";
import { periodOf } from "../CampaignCalendar";
import { campaignCalendarEvents, campaignGanttItems, readCampaignFilters, runLabel, runningDuring, timelineWindow } from "../runs";

const TZ = "Asia/Kolkata";

function row(id: string, startDate: string, endDate: string | null, campaignStatus: CampaignViewRow["campaignStatus"] = endDate ? "ended" : "active"): CampaignViewRow {
  return {
    campaignId: id,
    campaignName: `Campaign ${id}`,
    source: "meta",
    specialtyKey: null,
    specialtyLabel: null,
    spend: 1000,
    leads: 0,
    appointments: 0,
    consultations: 0,
    treatmentAdvised: 0,
    treatmentCompleted: 0,
    revenue: 0,
    cpl: null,
    costPerAppointment: null,
    costPerTreatment: null,
    roas: null,
    connectorMode: null,
    startDate,
    endDate,
    campaignStatus,
  };
}

describe("campaign run window", () => {
  it("labels an ongoing campaign 'Ongoing' and never invents an end date", () => {
    const ongoing = row("o", "2026-08-30T04:30:00.000Z", null);
    expect(runLabel(ongoing, TZ)).toBe("30 Aug 2026 – Ongoing");
    const [event] = campaignCalendarEvents([ongoing], TZ);
    expect(event.end ?? null).toBeNull();
    expect(event.status).toBe("Ongoing");
    expect(event.ariaLabel).toContain("Ongoing");
    const [item] = campaignGanttItems([ongoing]);
    expect(item.end ?? null).toBeNull();
    expect(item.status).toBe("Ongoing");
  });

  it("an ended campaign keeps its real span", () => {
    const ended = row("e", "2026-07-01T04:30:00.000Z", "2026-07-31T12:30:00.000Z");
    expect(runLabel(ended, TZ)).toBe("1 Jul 2026 – 31 Jul 2026");
    const [event] = campaignCalendarEvents([ended], TZ);
    expect(event).toMatchObject({ start: ended.startDate, end: ended.endDate, status: "Ended" });
    expect(campaignGanttItems([ended])[0]).toMatchObject({ start: ended.startDate, end: ended.endDate, status: "Ended" });
  });

  it("buckets by the hospital day, not UTC: 30 Sep 19:00 UTC is 1 Oct in Asia/Kolkata", () => {
    const lateNight = row("tz", "2026-09-30T19:00:00.000Z", null);
    expect(runLabel(lateNight, TZ)).toBe("1 Oct 2026 – Ongoing");
    expect(runningDuring([lateNight], "2026-09-01", "2026-09-30", TZ)).toEqual([]);
    expect(runningDuring([lateNight], "2026-10-01", "2026-10-31", TZ).map((r) => r.campaignId)).toEqual(["tz"]);
  });

  it("'running during' includes ongoing campaigns started earlier and excludes ones that ended before the period", () => {
    const rows = [
      row("ongoing-old", "2026-01-10T04:30:00.000Z", null),
      row("ended-before", "2026-07-01T04:30:00.000Z", "2026-07-31T12:30:00.000Z"),
      row("starts-after", "2026-11-02T04:30:00.000Z", null),
      row("overlaps", "2026-08-20T04:30:00.000Z", "2026-09-03T12:30:00.000Z"),
    ];
    expect(runningDuring(rows, "2026-09-01", "2026-09-30", TZ).map((r) => r.campaignId)).toEqual(["ongoing-old", "overlaps"]);
  });

  it("the timeline window is the selected month plus one month either side", () => {
    expect(timelineWindow("2026-09-17")).toEqual({ rangeStart: "2026-08-01", rangeEnd: "2026-10-31" });
    expect(timelineWindow("2026-01-05")).toEqual({ rangeStart: "2025-12-01", rangeEnd: "2026-02-28" });
  });

  it("reads campaign filters from the URL (branch, specialty, source, from, to)", () => {
    expect(readCampaignFilters(new URLSearchParams("branch=b1&specialty=CATARACT&source=meta&from=2026-09-01&to=2026-09-30&view=timeline"))).toEqual({
      branchId: "b1",
      specialtyKey: "CATARACT",
      source: "meta",
      dateFrom: "2026-09-01",
      dateTo: "2026-09-30",
    });
    expect(readCampaignFilters(new URLSearchParams("source=bogus&from=nope"))).toEqual({});
  });

  it("labels a week by its real dates, never 'this week' (the user may be looking at any week)", () => {
    const p = periodOf("week", "2026-01-14");
    expect(p).toMatchObject({ from: "2026-01-12", to: "2026-01-18" });
    expect(p.label).toBe("12 Jan – 18 Jan");
  });
});
