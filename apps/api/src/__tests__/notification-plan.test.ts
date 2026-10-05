import { describe, expect, it } from "vitest";
import { DEFAULT_RULES, notificationKey, offsetMs, planNotifications, type PlanRule } from "../domain/notification/notification-plan.js";
import { renderTemplate, templateParameters, validateTemplateBody } from "../domain/notification/message-template.js";

const H = 3_600_000;
const now = new Date("2026-10-02T06:00:00Z");
const at = (ms: number) => new Date(now.getTime() + ms);
const rule = (id: string, kind: PlanRule["kind"], offsetValue: number, offsetUnit: PlanRule["offsetUnit"], over: Partial<PlanRule> = {}): PlanRule => ({ id, kind, enabled: true, offsetValue, offsetUnit, minGapMinutes: 60, ...over });
const appt = [rule("c", "CONFIRMATION", 0, "minutes"), rule("d1", "REMINDER", 1, "days"), rule("h1", "REMINDER", 1, "hours")];
const ids = (xs: { ruleId: string }[]) => xs.map((x) => x.ruleId);

describe("planNotifications (pure suppression logic)", () => {
  it("a visit three days away gets the confirmation now plus the 1 day and 1 hour reminders", () => {
    const p = planNotifications({ start: at(72 * H), now, rules: appt });
    expect(ids(p.planned)).toEqual(["c", "d1", "h1"]);
    expect(p.planned.find((x) => x.ruleId === "d1")!.triggerAt).toEqual(at(48 * H));
    expect(p.suppressed).toEqual([]);
  });

  it("TRIGGER_ALREADY_PASSED: a visit booked 3 hours ahead gets no 1-day reminder, never a late one", () => {
    const p = planNotifications({ start: at(3 * H), now, rules: appt });
    expect(ids(p.planned)).toEqual(["c", "h1"]);
    expect(p.suppressed).toEqual([{ ruleId: "d1", reason: "TRIGGER_ALREADY_PASSED" }]);
  });

  it("TOO_CLOSE_TO_PREVIOUS_NOTIFICATION: a visit 90 minutes away drops the 1-hour reminder (30 min after the confirmation)", () => {
    const p = planNotifications({ start: at(1.5 * H), now, rules: appt });
    expect(ids(p.planned)).toEqual(["c"]);
    expect(p.suppressed).toEqual(expect.arrayContaining([{ ruleId: "d1", reason: "TRIGGER_ALREADY_PASSED" }, { ruleId: "h1", reason: "TOO_CLOSE_TO_PREVIOUS_NOTIFICATION" }]));
  });

  it("a gap exactly equal to the minimum is allowed", () => {
    const p = planNotifications({ start: at(2 * H), now, rules: appt }); // 1-hour reminder is exactly 60 min after the confirmation
    expect(ids(p.planned)).toEqual(["c", "h1"]);
  });

  it("a visit in 30 minutes: only the confirmation", () => {
    const p = planNotifications({ start: at(0.5 * H), now, rules: appt });
    expect(ids(p.planned)).toEqual(["c"]);
  });

  it("surgery 1 day / 2 hours / 1 hour: each 60+ minutes apart, all kept when the surgery is days away", () => {
    const surgery = [rule("s1", "REMINDER", 1, "days"), rule("s2", "REMINDER", 2, "hours"), rule("s3", "REMINDER", 1, "hours")];
    expect(ids(planNotifications({ start: at(72 * H), now, rules: surgery }).planned)).toEqual(["s1", "s2", "s3"]);
    // Booked 90 minutes ahead: the 2-hour and 1-day triggers are gone, the 1-hour reminder remains.
    const near = planNotifications({ start: at(1.5 * H), now, rules: surgery });
    expect(ids(near.planned)).toEqual(["s3"]);
    expect(near.suppressed.map((s) => s.reason)).toEqual(["TRIGGER_ALREADY_PASSED", "TRIGGER_ALREADY_PASSED"]);
  });

  it("RULE_DISABLED and APPOINTMENT_CANCELLED produce nothing, with the reason", () => {
    const off = planNotifications({ start: at(72 * H), now, rules: [rule("d1", "REMINDER", 1, "days", { enabled: false })] });
    expect(off).toEqual({ planned: [], suppressed: [{ ruleId: "d1", reason: "RULE_DISABLED" }] });
    const cancelled = planNotifications({ start: at(72 * H), now, rules: appt, cancelled: true });
    expect(cancelled.planned).toEqual([]);
    expect(cancelled.suppressed.map((s) => s.reason)).toEqual(["APPOINTMENT_CANCELLED", "APPOINTMENT_CANCELLED", "APPOINTMENT_CANCELLED"]);
  });

  it("existing notifications count toward the gap (a replan never doubles up)", () => {
    const p = planNotifications({ start: at(72 * H), now, rules: [rule("d1", "REMINDER", 1, "days")], alreadyScheduled: [at(48 * H + 10 * 60_000)] });
    expect(p.planned).toEqual([]);
    expect(p.suppressed).toEqual([{ ruleId: "d1", reason: "TOO_CLOSE_TO_PREVIOUS_NOTIFICATION" }]);
  });

  it("rules are configurable: units, offsets and minimum gap", () => {
    expect(offsetMs({ offsetValue: 90, offsetUnit: "minutes" })).toBe(90 * 60_000);
    const p = planNotifications({ start: at(10 * H), now, rules: [rule("a", "REMINDER", 3, "hours", { minGapMinutes: 0 }), rule("b", "REMINDER", 170, "minutes", { minGapMinutes: 0 })] });
    expect(ids(p.planned)).toEqual(["a", "b"]); // time order; gap 0 allows near-identical times
  });

  it("the default rule set matches the product defaults", () => {
    expect(DEFAULT_RULES.filter((r) => r.subject === "APPOINTMENT").map((r) => `${r.kind}:${r.offsetValue}${r.offsetUnit}`)).toEqual(["CONFIRMATION:0minutes", "REMINDER:1days", "REMINDER:1hours"]);
    expect(DEFAULT_RULES.filter((r) => r.subject === "SURGERY").map((r) => `${r.offsetValue}${r.offsetUnit}`)).toEqual(["1days", "2hours", "1hours"]);
  });

  it("the idempotency key changes with the visit time (a reschedule never collides) and is stable otherwise", () => {
    const a = notificationKey("r", "appt", new Date("2026-10-05T10:00:00Z"));
    expect(notificationKey("r", "appt", new Date("2026-10-05T10:00:00Z"))).toBe(a);
    expect(notificationKey("r", "appt", new Date("2026-10-05T11:00:00Z"))).not.toBe(a);
  });
});

describe("message templates", () => {
  it("only declared variables may be used", () => {
    expect(validateTemplateBody("APPOINTMENT_REMINDER", "Hi {{patient_name}} at {{time}}").ok).toBe(true);
    expect(validateTemplateBody("APPOINTMENT_REMINDER", "Hi {{patient_name}} {{diagnosis}}")).toEqual({ ok: false, unknown: ["diagnosis"] });
    expect(validateTemplateBody("FOLLOW_UP_MESSAGE", "Hi {{doctor_name}}")).toEqual({ ok: false, unknown: ["doctor_name"] });
  });

  it("renders values, reports missing ones and never sends a hole silently", () => {
    expect(renderTemplate("Hi {{patient_name}} on {{date}}", { patient_name: "Asha", date: "5 Oct" })).toEqual({ text: "Hi Asha on 5 Oct", missing: [] });
    expect(renderTemplate("Hi {{patient_name}} with {{doctor_name}}", { patient_name: "Asha" })).toEqual({ text: "Hi Asha with {{doctor_name}}", missing: ["doctor_name"] });
    expect(templateParameters("{{b}} then {{a}} then {{b}}", { a: "A", b: "B" })).toEqual(["B", "A"]);
  });
});
