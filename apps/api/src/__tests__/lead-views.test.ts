import { describe, expect, it } from "vitest";
import { LEAD_VIEWS, type LeadRow } from "@pulseos/types";
import { computeLeadsWorkspace, type LeadFact } from "../domain/lead/lead-views.js";

const TODAY = "2026-10-02";
const NOW = new Date("2026-10-02T09:30:00Z"); // 15:00 IST

function fact(id: string, over: Omit<Partial<LeadFact>, "row"> & { row?: Partial<LeadRow> } = {}): LeadFact {
  const { row, ...rest } = over;
  return {
    row: {
      id, patientId: `p-${id}`, patientName: `Patient ${id}`, phone: "+919999900000", specialtyKey: "CATARACT", specialtyLabel: "Cataract", source: "google", sourceLabel: "Google", campaignName: null,
      stage: "enquiry", leadStatus: "uncontacted", operationalStatus: null, ownerId: null, ownerName: null, priority: "normal", lastInteractionAt: null, nextActionDueAt: null, createdAt: "2026-10-01T05:00:00Z",
      journeyType: "Cataract", outcomeLabel: null, nextAction: null, nextAppointment: null, ...row,
    },
    createdDay: "2026-10-01",
    openTaskDueAts: [],
    openTaskDays: [],
    appointmentDays: [],
    bookedPending: false,
    sourceKey: null,
    ...rest,
  };
}

type Q = Omit<Parameters<typeof computeLeadsWorkspace>[1], "today" | "now" | "range"> & { range?: "7d" | "30d" | "yesterday" | "custom"; from?: string; to?: string };
const RANGE = { "7d": { from: "2026-09-26", to: TODAY }, "30d": { from: "2026-09-03", to: TODAY }, yesterday: { from: "2026-10-01", to: "2026-10-01" } } as const;
const run = (facts: LeadFact[], { range, from, to, ...q }: Q = {}) =>
  computeLeadsWorkspace(facts, { today: TODAY, now: NOW, ...q, range: range === "custom" ? { from: from!, to: to! } : range ? RANGE[range] : undefined });
const ids = (r: ReturnType<typeof run>) => r.rows.map((x) => x.id).sort();

const facts: LeadFact[] = [
  fact("new-today", { createdDay: TODAY, row: { leadStatus: "new", createdAt: "2026-10-02T03:00:00Z" } }),
  fact("old-uncontacted", { createdDay: "2026-09-20", row: { leadStatus: "uncontacted" } }),
  fact("due-today", { createdDay: "2026-09-25", row: { leadStatus: "follow_up_due", stage: "contacted" }, openTaskDays: [TODAY], openTaskDueAts: [Date.parse("2026-10-02T12:00:00Z")] }),
  fact("overdue", { createdDay: "2026-09-25", row: { leadStatus: "follow_up_due", stage: "contacted" }, openTaskDays: [TODAY], openTaskDueAts: [Date.parse("2026-10-02T04:00:00Z")] }),
  fact("overdue-yesterday", { createdDay: "2026-09-25", row: { leadStatus: "follow_up_due", stage: "contacted" }, openTaskDays: ["2026-10-01"], openTaskDueAts: [Date.parse("2026-10-01T10:00:00Z")] }),
  fact("due-tomorrow", { createdDay: "2026-09-25", row: { leadStatus: "follow_up_due", stage: "contacted" }, openTaskDays: ["2026-10-03"], openTaskDueAts: [Date.parse("2026-10-03T05:00:00Z")] }),
  fact("appt-today", { createdDay: "2026-09-28", row: { leadStatus: "appointment_booked", stage: "booked" }, appointmentDays: [TODAY], bookedPending: true }),
  fact("appt-booked-later", { createdDay: "2026-09-28", row: { leadStatus: "appointment_booked", stage: "booked" }, appointmentDays: ["2026-10-09"], bookedPending: true }),
  fact("no-response", { createdDay: "2026-09-10", row: { leadStatus: "no_response", stage: "contacted" } }),
  fact("converted", { createdDay: "2026-09-01", row: { leadStatus: "converted", stage: "completed" } }),
  fact("lost", { createdDay: "2026-09-02", row: { leadStatus: "lost", stage: "lost" }, openTaskDays: [TODAY], openTaskDueAts: [Date.parse("2026-10-02T04:00:00Z")], appointmentDays: [TODAY] }),
  // Closed on day one (e.g. "Not interested" at Add Lead): never an attention item.
  fact("lost-today", { createdDay: TODAY, row: { leadStatus: "lost", stage: "lost", createdAt: "2026-10-02T03:00:00Z" } }),
];

describe("computeLeadsWorkspace — quick views are filters, not stored statuses", () => {
  it("All returns everything", () => expect(run(facts).rows).toHaveLength(facts.length));

  it("New Today: created on the hospital's today, and never a lead already lost", () => expect(ids(run(facts, { view: "new_today" }))).toEqual(["new-today"]));

  it("Uncontacted: never reached, not lost", () => expect(ids(run(facts, { view: "uncontacted" }))).toEqual(["new-today", "old-uncontacted"]));

  it("Follow-up Due: an open follow-up due today or already past; not tomorrow's; never a lost lead", () => {
    expect(ids(run(facts, { view: "follow_up_due" }))).toEqual(["due-today", "overdue", "overdue-yesterday"]);
  });

  it("Overdue only: due time already passed (same clock as the Command Centre: dueAt < now)", () => {
    expect(ids(run(facts, { view: "follow_up_due", due: "overdue" }))).toEqual(["overdue", "overdue-yesterday"]);
  });

  it("Appointments Today: a visit scheduled today, never a lost lead", () => expect(ids(run(facts, { view: "appointments_today" }))).toEqual(["appt-today"]));

  it("Appointment Booked: a visit still to come, whatever day", () => expect(ids(run(facts, { view: "appointment_booked" }))).toEqual(["appt-booked-later", "appt-today"]));

  it("Today: new today + follow-ups due/overdue + appointments today, without duplicates or lost leads", () => {
    expect(ids(run(facts, { view: "today" }))).toEqual(["appt-today", "due-today", "new-today", "overdue", "overdue-yesterday"]);
  });

  it("No Response / Converted / Lost use the derived status and stage", () => {
    expect(ids(run(facts, { view: "no_response" }))).toEqual(["no-response"]);
    expect(ids(run(facts, { view: "converted" }))).toEqual(["converted"]);
    expect(ids(run(facts, { view: "lost" }))).toEqual(["lost", "lost-today"]);
  });
});

describe("date range", () => {
  it("defaults to the journey created date", () => {
    const r = run(facts, { view: "all", range: "7d" });
    // 7d = 2026-09-26..2026-10-02 by created day
    expect(ids(r)).toEqual(["appt-booked-later", "appt-today", "lost-today", "new-today"]);
    expect(r.dateContext).toMatchObject({ kind: "created" });
  });

  it("yesterday / custom use hospital calendar days inclusively", () => {
    expect(ids(run(facts, { view: "all", range: "yesterday" }))).toEqual([]);
    expect(ids(run(facts, { view: "all", range: "custom", from: "2026-09-20", to: "2026-09-25" }))).toEqual(["due-today", "old-uncontacted", "overdue", "overdue-yesterday", "due-tomorrow"].sort());
  });

  it("Follow-up Due measures the follow-up's own due date and says so", () => {
    const r = run(facts, { view: "follow_up_due", range: "custom", from: "2026-10-03", to: "2026-10-03" });
    expect(ids(r)).toEqual(["due-tomorrow"]);
    expect(r.dateContext).toMatchObject({ kind: "follow_up_due" });
  });

  it("Today-bound views ignore a range and say their date is today (no silent mixing)", () => {
    for (const view of ["today", "new_today", "appointments_today"] as const) {
      const a = run(facts, { view, range: "30d" });
      const b = run(facts, { view });
      expect(ids(a)).toEqual(ids(b));
      expect(a.dateContext.kind).toBe("today");
    }
  });
});

describe("counts reconcile with rows", () => {
  it("every view's count equals the rows that view returns under the same filters", () => {
    for (const range of [undefined, "7d", "30d"] as const) {
      const base = run(facts, { range });
      for (const [view, n] of Object.entries(base.counts)) expect(run(facts, { range, view: view as never }).rows.length, `${view}/${range}`).toBe(n);
    }
  });

  it("counts honour owner / source / service filters", () => {
    const own = [fact("a", { row: { ownerId: "u1", ownerName: "Asha" } }), fact("b", { row: { ownerId: "u2", ownerName: "Ravi" } }), fact("c", { row: { ownerId: null } })];
    expect(run(own, { owner: { kind: "user", userId: "u1" } }).counts.all).toBe(1);
    expect(run(own, { owner: { kind: "unassigned" } }).counts.all).toBe(1);
    const svc = [fact("a", { row: { journeyType: "Cataract" } }), fact("b", { row: { journeyType: "LASIK", specialtyKey: "LASIK" } })];
    expect(run(svc, { service: "LASIK" }).rows.map((r) => r.id)).toEqual(["b"]);
    expect(run([fact("a", { sourceKey: "google", row: { source: "google" } }), fact("b", { sourceKey: "walk_in", row: { source: "walk_in" } })], { source: "walk_in" }).counts.all).toBe(1);
    // Two catalogue sources can share one coarse bucket; the filter is the precise source.
    const social = [fact("a", { sourceKey: "instagram", row: { source: "meta" } }), fact("b", { sourceKey: "facebook", row: { source: "meta" } })];
    expect(run(social, { source: "instagram" }).rows.map((r) => r.id)).toEqual(["a"]);
  });

  it("owner counts ignore the owner filter itself", () => {
    const own = [fact("a", { row: { ownerId: "u1", ownerName: "Asha" } }), fact("b", { row: { ownerId: "u1", ownerName: "Asha" } }), fact("c", { row: { ownerId: "u2", ownerName: "Ravi" } }), fact("d")];
    const r = run(own, { owner: { kind: "user", userId: "u1" } });
    expect(r.ownerCounts).toEqual({ all: 4, unassigned: 1, byOwner: [{ userId: "u1", name: "Asha", count: 2 }, { userId: "u2", name: "Ravi", count: 1 }] });
  });

  it("the today summary reconciles with the views it opens", () => {
    const r = run(facts);
    expect(r.today.appointmentsToday).toBe(run(facts, { view: "appointments_today" }).rows.length);
    expect(r.today.followUpsDue).toBe(run(facts, { view: "follow_up_due" }).rows.length);
    expect(r.today.overdue).toBe(run(facts, { view: "follow_up_due", due: "overdue" }).rows.length);
    expect(r.today.newToday).toBe(run(facts, { view: "new_today" }).rows.length);
  });

describe("row order — who needs attention first", () => {
  const order = (r: ReturnType<typeof run>) => r.rows.map((x) => x.id);
  const t = (iso: string) => Date.parse(iso);

  it("Follow-up Due lists the earliest due follow-up first (overdue before today's)", () => {
    const fs = [
      fact("later", { openTaskDays: [TODAY], openTaskDueAts: [t("2026-10-02T12:00:00Z")], row: { leadStatus: "follow_up_due", stage: "contacted" } }),
      fact("oldest", { openTaskDays: ["2026-09-28"], openTaskDueAts: [t("2026-09-28T04:00:00Z")], row: { leadStatus: "follow_up_due", stage: "contacted" } }),
      fact("overdue", { openTaskDays: [TODAY], openTaskDueAts: [t("2026-10-02T04:00:00Z")], row: { leadStatus: "follow_up_due", stage: "contacted" } }),
    ];
    expect(order(run(fs, { view: "follow_up_due" }))).toEqual(["oldest", "overdue", "later"]);
  });

  it("Appointments Today lists visits by time of day", () => {
    const fs = [
      fact("afternoon", { appointmentDays: [TODAY], row: { nextAppointment: { id: "a2", at: "2026-10-02T10:00:00Z", status: "scheduled" } } }),
      fact("morning", { appointmentDays: [TODAY], row: { nextAppointment: { id: "a1", at: "2026-10-02T04:30:00Z", status: "scheduled" } } }),
    ];
    expect(order(run(fs, { view: "appointments_today" }))).toEqual(["morning", "afternoon"]);
  });

  it("Today puts overdue follow-ups first, then today's visits by time, then the newest enquiries", () => {
    const fs = [
      fact("new-a", { createdDay: TODAY, row: { createdAt: "2026-10-02T02:00:00Z", leadStatus: "new" } }),
      fact("new-b", { createdDay: TODAY, row: { createdAt: "2026-10-02T08:00:00Z", leadStatus: "new" } }),
      fact("visit", { appointmentDays: [TODAY], row: { nextAppointment: { id: "a", at: "2026-10-02T06:00:00Z", status: "scheduled" } } }),
      fact("overdue", { openTaskDays: [TODAY], openTaskDueAts: [t("2026-10-02T03:00:00Z")], row: { leadStatus: "follow_up_due", stage: "contacted" } }),
    ];
    expect(order(run(fs, { view: "today" }))).toEqual(["overdue", "visit", "new-b", "new-a"]);
  });

  it("every other view is newest enquiry first, with the id as a stable tie-break", () => {
    const fs = [
      fact("b", { row: { createdAt: "2026-09-30T05:00:00Z" } }),
      fact("a", { row: { createdAt: "2026-09-30T05:00:00Z" } }),
      fact("newest", { row: { createdAt: "2026-10-01T05:00:00Z" } }),
      fact("oldest", { row: { createdAt: "2026-09-01T05:00:00Z" } }),
    ];
    expect(order(run(fs, { view: "all" }))).toEqual(["newest", "a", "b", "oldest"]);
    expect(order(run([...fs].reverse(), { view: "all" }))).toEqual(["newest", "a", "b", "oldest"]);
  });
});

describe("Overdue and a date range apply to the SAME follow-up", () => {
  it("a lead whose in-range follow-up is not yet due, but has another overdue one out of range, is not 'overdue in range'", () => {
    const f = fact("two-tasks", {
      row: { leadStatus: "follow_up_due", stage: "contacted" },
      openTaskDays: ["2026-09-20", TODAY],
      openTaskDueAts: [Date.parse("2026-09-20T05:00:00Z"), Date.parse("2026-10-02T12:00:00Z")], // second is due 17:30 IST today, after NOW
    });
    expect(run([f], { view: "follow_up_due", due: "overdue", range: "custom", from: TODAY, to: TODAY }).rows).toHaveLength(0);
    expect(run([f], { view: "follow_up_due", range: "custom", from: TODAY, to: TODAY }).rows).toHaveLength(1);
    expect(run([f], { view: "follow_up_due", due: "overdue" }).rows).toHaveLength(1); // no range: the Sept task is overdue
  });
});
});

describe("Missed Visit: a derived view, not a stored status", () => {
  const missed = [
    fact("noshow", { row: { operationalStatus: "no_show", stage: "booked", leadStatus: "uncontacted" } }),
    fact("cancelled", { row: { operationalStatus: "cancelled", stage: "booked", leadStatus: "uncontacted" } }),
    fact("rebooked", { row: { operationalStatus: "appointment_booked", stage: "booked", leadStatus: "appointment_booked" }, bookedPending: true }),
    fact("seen", { row: { operationalStatus: "consultation_completed", stage: "consulted", leadStatus: "uncontacted" } }),
    fact("fresh", { row: { operationalStatus: null } }),
    fact("lost-noshow", { row: { operationalStatus: "closed", stage: "lost", leadStatus: "lost" } }),
  ];

  it("lists a no-show or cancelled visit that has not been rebooked, and nothing else", () => {
    expect(ids(run(missed, { view: "missed_visit" }))).toEqual(["cancelled", "noshow"]);
  });

  it("its count equals its rows, and it is offered as a view", () => {
    expect(run(missed).counts.missed_visit).toBe(2);
    expect(LEAD_VIEWS.map((v) => v.key)).toContain("missed_visit");
  });
});
