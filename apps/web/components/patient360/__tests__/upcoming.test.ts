import { describe, expect, it } from "vitest";
import type { PatientUpcomingItem } from "@pulseos/types";
import { groupUpcoming } from "../upcoming";

const IST = "Asia/Kolkata";
const item = (id: string, at: string, extra: Partial<PatientUpcomingItem> = {}): PatientUpcomingItem => ({
  kind: "task", id, at, label: "CALLBACK", status: "pending", overdue: false, journeyId: "j1", journeyType: "Cataract", personName: null, ...extra,
});

describe("groupUpcoming", () => {
  it("puts overdue tasks first, then groups by hospital-local day in time order", () => {
    const groups = groupUpcoming(
      [
        item("late", "2026-09-30T18:45:00Z"), // 1 Oct 00:15 IST
        item("early", "2026-09-30T05:00:00Z"), // 30 Sep 10:30 IST
        item("over", "2026-09-28T05:00:00Z", { overdue: true }),
      ],
      IST,
    );
    expect(groups.map((g) => g.key)).toEqual(["overdue", "2026-09-30", "2026-10-01"]);
    expect(groups.map((g) => g.items.map((i) => i.id))).toEqual([["over"], ["early"], ["late"]]);
  });

  it("filters to one journey when a journey is selected", () => {
    const groups = groupUpcoming([item("a", "2026-09-30T05:00:00Z"), item("b", "2026-09-30T06:00:00Z", { journeyId: "j2" })], IST, "j2");
    expect(groups.flatMap((g) => g.items.map((i) => i.id))).toEqual(["b"]);
  });
});
