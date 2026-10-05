import { describe, expect, it } from "vitest";
import { buildAlert, buildBreakdown, buildFunnel, buildInsights, furthestStep, type PerfJourneyFact } from "../domain/dashboard/performance.js";

// The owner's performance numbers are counted from journeys, each placed at the FURTHEST step it really reached - so the funnel
// can never go up as it goes right, and a walk-in who was never "contacted" still counts as having reached the clinic.

const fact = (over: Partial<PerfJourneyFact> = {}): PerfJourneyFact => ({
  id: Math.random().toString(36).slice(2), sourceKey: "google", sourceLabel: "Google", journeyType: "Cataract", ownerId: null,
  contacted: false, booked: false, attended: false, consulted: false, noShow: false, advised: false, scheduled: false, done: false, lost: false, ...over,
});

describe("furthestStep", () => {
  it("is the highest step reached, whatever earlier flags say", () => {
    expect(furthestStep(fact())).toBe(0);
    expect(furthestStep(fact({ contacted: true }))).toBe(0); // a phone contact is not a funnel step
    expect(furthestStep(fact({ booked: true }))).toBe(1);
    expect(furthestStep(fact({ attended: true }))).toBe(2); // a walk-in: never phoned, still at the clinic
    expect(furthestStep(fact({ consulted: true }))).toBe(3);
    expect(furthestStep(fact({ advised: true }))).toBe(4);
    expect(furthestStep(fact({ scheduled: true }))).toBe(5);
    expect(furthestStep(fact({ scheduled: true, done: true }))).toBe(6);
    expect(furthestStep(fact({ scheduled: true }))).not.toBe(furthestStep(fact({ scheduled: true, done: true }))); // scheduled is not done
  });
});

describe("buildFunnel", () => {
  const facts = [
    fact(), fact(), fact({ lost: true }),
    fact({ contacted: true }), fact({ contacted: true }),
    fact({ contacted: true, booked: true }), fact({ booked: true, noShow: true }),
    fact({ booked: true, attended: true }),
    fact({ booked: true, attended: true, consulted: true }),
    fact({ booked: true, attended: true, consulted: true, advised: true }),
    fact({ booked: true, attended: true, consulted: true, advised: true, scheduled: true }),
    fact({ booked: true, attended: true, consulted: true, advised: true, scheduled: true, done: true }),
    fact({ attended: true }), // walk-in
  ];

  it("counts journeys that reached AT LEAST each step, so it never grows to the right", () => {
    const f = buildFunnel(facts);
    expect(f.map((s) => [s.key, s.count])).toEqual([
      ["enquiries", 13], ["booked", 8], ["attended", 6], ["consulted", 4], ["advised", 3], ["scheduled", 2], ["done", 1],
    ]);
    for (let i = 1; i < f.length; i++) expect(f[i]!.count).toBeLessThanOrEqual(f[i - 1]!.count);
  });

  it("says how many dropped at each step and the conversion from the step before", () => {
    const f = buildFunnel(facts);
    expect(f[0]).toMatchObject({ droppedBefore: 0, conversionFromPrevious: null });
    expect(f[1]).toMatchObject({ droppedBefore: 5, conversionFromPrevious: 62 });
    expect(f[2]).toMatchObject({ droppedBefore: 2, conversionFromPrevious: 75 });
    expect(f[6]).toMatchObject({ droppedBefore: 1, conversionFromPrevious: 50 });
  });

  it("is all zeros, with no invented percentages, for no data", () => {
    const f = buildFunnel([]);
    expect(f.every((s) => s.count === 0 && s.droppedBefore === 0)).toBe(true);
    expect(f.every((s) => s.conversionFromPrevious === null)).toBe(true);
  });
});

describe("buildBreakdown", () => {
  it("groups by the chosen key and counts each step reached", () => {
    const rows = buildBreakdown(
      [fact({ sourceKey: "google", sourceLabel: "Google", contacted: true, booked: true }), fact({ sourceKey: "google", sourceLabel: "Google" }), fact({ sourceKey: "instagram", sourceLabel: "Instagram", booked: true, attended: true, consulted: true })],
      (f) => ({ key: f.sourceKey ?? "unknown", label: f.sourceLabel }),
    );
    expect(rows).toEqual([
      { key: "google", label: "Google", enquiries: 2, booked: 1, attended: 0, consulted: 0, advised: 0, scheduled: 0, done: 0 },
      { key: "instagram", label: "Instagram", enquiries: 1, booked: 1, attended: 1, consulted: 1, advised: 0, scheduled: 0, done: 0 },
    ]);
  });

  it("orders by volume, then name, and is stable", () => {
    const rows = buildBreakdown([fact({ journeyType: "B" }), fact({ journeyType: "A" }), fact({ journeyType: "A" }), fact({ journeyType: "C" })], (f) => ({ key: f.journeyType, label: f.journeyType }));
    expect(rows.map((r) => r.label)).toEqual(["A", "B", "C"]);
  });
});

describe("buildInsights", () => {
  const base = { uncontacted: 0, overdueFollowUps: 0, noShows: 0, noOutcome: 0, undecided: 0, lost: 0 };

  it("says nothing when there is nothing to say", () => {
    expect(buildInsights(base)).toEqual([]);
  });

  it("states each finding as a plain sentence with its count and the view that fixes it", () => {
    const out = buildInsights({ ...base, uncontacted: 14, overdueFollowUps: 1, noShows: 3, noOutcome: 2, undecided: 5, lost: 1 });
    expect(out.map((i) => i.message)).toEqual([
      "14 enquiries have not yet been contacted",
      "1 follow-up is overdue",
      "3 booked patients did not come",
      "2 completed consultations have no outcome recorded",
      "5 advised procedures are still undecided after 7 days",
      "1 enquiry was closed as lost",
    ]);
    expect(out[0]).toMatchObject({ key: "uncontacted", count: 14, severity: "attention", href: "/leads?view=uncontacted" });
    expect(out[1]!.href).toBe("/leads?view=follow_up_due&due=overdue");
  });

  it("uses singular and plural correctly", () => {
    expect(buildInsights({ ...base, uncontacted: 1 })[0]!.message).toBe("1 enquiry has not yet been contacted");
  });
});

describe("buildAlert", () => {
  const cur = { enquiries: 20, contacted: 18, booked: 12, noShows: 1 };
  const prev = { enquiries: 20, contacted: 18, booked: 12, noShows: 1 };

  it("is quiet when nothing crosses a threshold", () => {
    expect(buildAlert(cur, prev, 14)).toBeNull();
  });

  it("flags a fall in enquiries of a quarter or more against the previous period of the same length", () => {
    const a = buildAlert({ ...cur, enquiries: 12 }, { ...prev, enquiries: 20 }, 14);
    expect(a).toMatchObject({ kind: "enquiries_down", label: "Rule-based alert" });
    expect(a!.message).toBe("Enquiries are down 40% on the previous 14 days");
    expect(a!.detail).toBe("12 now, 20 before");
  });

  it("does not cry wolf on tiny numbers", () => {
    expect(buildAlert({ ...cur, enquiries: 2 }, { ...prev, enquiries: 4 }, 7)).toBeNull();
  });

  it("flags a low contact rate", () => {
    const a = buildAlert({ enquiries: 20, contacted: 10, booked: 6, noShows: 0 }, prev, 14);
    expect(a).toMatchObject({ kind: "contact_rate_low" });
    expect(a!.message).toBe("Only 50% of this period's enquiries have been contacted");
  });

  it("flags a high no-show rate among booked visits", () => {
    const a = buildAlert({ enquiries: 20, contacted: 19, booked: 12, noShows: 4 }, prev, 14);
    expect(a).toMatchObject({ kind: "no_show_rate_high" });
    expect(a!.message).toBe("33% of booked patients did not come");
  });

  it("reports the most serious rule first when several apply", () => {
    const a = buildAlert({ enquiries: 12, contacted: 4, booked: 12, noShows: 6 }, { ...prev, enquiries: 20 }, 14);
    expect(a!.kind).toBe("enquiries_down");
  });
});
