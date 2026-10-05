import { describe, expect, it } from "vitest";
import type { AppointmentRow, DoctorTodayItem } from "@pulseos/types";
import {
  appointmentQuery,
  fmtTimeInZone,
  groupByDoctor,
  groupDayParts,
  groupTodayFlow,
  matchesSearch,
  toCalendarEvent,
} from "../appointmentViews";

const IST = "Asia/Kolkata";

function row(id: string, scheduledAt: string, extra: Partial<AppointmentRow> = {}): AppointmentRow {
  return {
    id,
    patientId: `p-${id}`,
    patientName: `Patient ${id}`,
    journeyId: `j-${id}`,
    branchName: "Jayanagar Eye Centre",
    doctorId: "d1",
    doctorName: "Dr. Rajiv Menon",
    status: "confirmed",
    scheduledAt,
    reason: "Cataract consultation",
    ...extra,
  };
}

describe("appointmentQuery: every view asks the same endpoint with the same filters", () => {
  const base = { tab: "today" as const, date: "2026-09-30", branchId: "b1", doctorId: "" };

  it("List/Today is the selected local day, identical to the Day and Doctor Schedule views", () => {
    const list = appointmentQuery({ ...base, view: "list" });
    const day = appointmentQuery({ ...base, view: "day" });
    const doctors = appointmentQuery({ ...base, view: "doctors" });
    expect(list).toEqual({ from: "2026-09-30", to: "2026-09-30", branchId: "b1", doctorId: undefined });
    expect(day).toEqual(list);
    expect(doctors).toEqual(list);
  });

  it("Week is the Monday-start week around the date; Month is the full 6-week grid", () => {
    expect(appointmentQuery({ ...base, view: "week" })).toMatchObject({ from: "2026-09-28", to: "2026-10-04" });
    expect(appointmentQuery({ ...base, view: "month" })).toMatchObject({ from: "2026-08-31", to: "2026-10-11" });
  });

  it("no-shows / completed filter by status AND by the chosen period (never the whole history)", () => {
    const period = { from: "2026-09-01", to: "2026-09-30" };
    expect(appointmentQuery({ ...base, view: "list", tab: "no_show", today: "2026-09-30", period })).toEqual({ status: "no_show", ...period, branchId: "b1", doctorId: undefined });
    expect(appointmentQuery({ ...base, view: "list", tab: "completed", today: "2026-09-30", period })).toEqual({ status: "completed", ...period, branchId: "b1", doctorId: undefined });
  });

  it("upcoming starts today and looks ahead one API window, so the server (not the browser clock) bounds it", () => {
    expect(appointmentQuery({ ...base, view: "list", tab: "upcoming", today: "2026-09-30" })).toEqual({ from: "2026-09-30", to: "2026-11-30", branchId: "b1", doctorId: undefined });
  });

  it("without a period or today the legacy status-only / unbounded queries are kept", () => {
    expect(appointmentQuery({ ...base, view: "list", tab: "no_show" })).toEqual({ status: "no_show", branchId: "b1", doctorId: undefined });
    expect(appointmentQuery({ ...base, view: "list", tab: "upcoming" })).toEqual({ branchId: "b1", doctorId: undefined });
  });

  it("calendar views ignore the list-only status tabs", () => {
    expect(appointmentQuery({ ...base, view: "day", tab: "no_show" })).toEqual(appointmentQuery({ ...base, view: "day" }));
  });
});

describe("toCalendarEvent: status is text, never colour only", () => {
  it("carries the patient, doctor, status label and the original row", () => {
    const r = row("a1", "2026-09-30T04:30:00Z");
    const e = toCalendarEvent(r);
    expect(e).toMatchObject({ id: "a1", start: r.scheduledAt, title: "Patient a1", status: "Confirmed", state: "default", data: r });
    expect(e.subtitle).toContain("Dr. Rajiv Menon");
  });

  it("marks completed and cancelled with a state (icon/strike-through) and no-shows with text", () => {
    expect(toCalendarEvent(row("c", "2026-09-30T04:30:00Z", { status: "completed" }))).toMatchObject({ state: "completed", status: "Completed" });
    expect(toCalendarEvent(row("x", "2026-09-30T04:30:00Z", { status: "cancelled" }))).toMatchObject({ state: "cancelled", status: "Cancelled" });
    expect(toCalendarEvent(row("n", "2026-09-30T04:30:00Z", { status: "no_show" }))).toMatchObject({ state: "default", status: "No-show" });
  });
});

describe("groupByDoctor", () => {
  it("one time-ordered column per doctor, doctors alphabetical", () => {
    const rows = [
      row("late", "2026-09-30T10:00:00Z"),
      row("other", "2026-09-30T05:00:00Z", { doctorId: "d0", doctorName: "Dr. Anita Rao" }),
      row("early", "2026-09-30T03:00:00Z"),
    ];
    const groups = groupByDoctor(rows);
    expect(groups.map((g) => g.doctorName)).toEqual(["Dr. Anita Rao", "Dr. Rajiv Menon"]);
    expect(groups[1].rows.map((r) => r.id)).toEqual(["early", "late"]);
    expect(groups.reduce((n, g) => n + g.rows.length, 0)).toBe(rows.length);
  });
});

describe("groupTodayFlow: today's appointments by arrival state, time-ordered", () => {
  it("puts every row in exactly one group, in operational order", () => {
    const rows = [
      row("exp2", "2026-09-30T09:00:00Z", { status: "scheduled" }),
      row("wait", "2026-09-30T04:00:00Z", { status: "waiting" }),
      row("exp1", "2026-09-30T05:00:00Z", { status: "confirmed" }),
      row("in", "2026-09-30T03:30:00Z", { status: "checked_in" }),
      row("doc", "2026-09-30T03:00:00Z", { status: "with_doctor" }),
      row("done", "2026-09-30T02:00:00Z", { status: "completed" }),
      row("ns", "2026-09-30T02:30:00Z", { status: "no_show" }),
      row("cx", "2026-09-30T06:00:00Z", { status: "cancelled" }),
      row("req", "2026-09-30T07:00:00Z", { status: "requested" }),
    ];
    const groups = groupTodayFlow(rows);
    expect(groups.map((g) => g.key)).toEqual(["arrived", "with_doctor", "expected", "seen", "not_arrived"]);
    const ids = Object.fromEntries(groups.map((g) => [g.key, g.rows.map((r) => r.id)]));
    expect(ids).toEqual({
      arrived: ["in", "wait"],
      with_doctor: ["doc"],
      expected: ["exp1", "req", "exp2"],
      seen: ["done"],
      not_arrived: ["ns", "cx"],
    });
    expect(groups.reduce((n, g) => n + g.rows.length, 0)).toBe(rows.length);
  });
});

describe("groupDayParts: the doctor's day as Morning / Afternoon / Evening in hospital time", () => {
  const item = (id: string, time: string): DoctorTodayItem => ({ appointmentId: id, patientName: id, time, status: "confirmed" });

  it("buckets by the hospital's local hour, not UTC", () => {
    // 06:15Z = 11:45 IST (morning); 06:45Z = 12:15 IST (afternoon); 12:00Z = 17:30 IST (evening); 18:45Z = 00:15 IST (morning).
    const parts = groupDayParts([item("b", "2026-09-30T06:45:00Z"), item("a", "2026-09-30T06:15:00Z"), item("c", "2026-09-30T12:00:00Z"), item("m", "2026-09-29T18:45:00Z")], IST);
    expect(parts.map((p) => [p.key, p.items.map((i) => i.appointmentId)])).toEqual([
      ["morning", ["m", "a"]],
      ["afternoon", ["b"]],
      ["evening", ["c"]],
    ]);
  });

  it("omits empty parts", () => {
    expect(groupDayParts([item("a", "2026-09-30T06:15:00Z")], IST).map((p) => p.key)).toEqual(["morning"]);
  });
});

describe("helpers", () => {
  it("formats times in the hospital zone", () => {
    expect(fmtTimeInZone("2026-09-29T18:45:00Z", IST)).toBe("12:15 am");
    expect(fmtTimeInZone("2026-09-30T08:30:00Z", IST)).toBe("2:00 pm");
  });

  it("search matches the patient name case-insensitively; empty matches all", () => {
    const r = row("a", "2026-09-30T04:30:00Z", { patientName: "Savitha Murthy" });
    expect(matchesSearch(r, "savi")).toBe(true);
    expect(matchesSearch(r, "  ")).toBe(true);
    expect(matchesSearch(r, "ishaan")).toBe(false);
  });
});
