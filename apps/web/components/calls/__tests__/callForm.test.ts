import { describe, expect, it } from "vitest";
import type { ClinicHours, CrmOutcomeVm } from "@pulseos/types";
import { buildFeedbackInput, buildLogCallInput, initialCallForm } from "../callForm";

const TZ = "Asia/Kolkata";
const NOW = new Date("2026-10-01T12:00:00.000Z"); // 17:30 IST
const needsCallback = { id: "o1", key: "needs_callback", label: "Needs callback", stage: "contacted", requiresFollowUp: true, allowsAppointment: false, asksReason: false, followUpType: "CALLBACK", sortOrder: 1, archived: false } as CrmOutcomeVm;
const interested = { ...needsCallback, id: "o2", key: "interested", label: "Interested", requiresFollowUp: false } as CrmOutcomeVm;

describe("Log Call form", () => {
  it("starts as an incoming connected call happening now, in the hospital clock, with a tomorrow 11:00 callback ready", () => {
    expect(initialCallForm(NOW, TZ)).toMatchObject({ direction: "inbound", connected: true, date: "2026-10-01", time: "17:30", callbackDate: "2026-10-02", callbackTime: "11:00" });
  });

  it("builds the request: occurred time and callback are hospital wall time converted to instants; minutes and seconds become seconds", () => {
    const s = { ...initialCallForm(NOW, TZ), minutes: "4", seconds: "38", feedback: "  Will confirm after family.  ", outcomeKey: "needs_callback" };
    const built = buildLogCallInput(s, needsCallback, TZ, NOW, "key-12345678");
    expect(built).toEqual({ input: { direction: "inbound", connected: true, occurredAt: "2026-10-01T12:00:00.000Z", durationSeconds: 278, staffFeedback: "Will confirm after family.", outcomeKey: "needs_callback", callback: { dueAt: "2026-10-02T05:30:00.000Z", note: undefined }, idempotencyKey: "key-12345678" } });
  });

  it("an outcome that needs a follow-up always asks for one; an optional outcome only if the person turns it on", () => {
    const base = initialCallForm(NOW, TZ);
    expect("input" in buildLogCallInput(base, interested, TZ, NOW, "k-12345678") && (buildLogCallInput(base, interested, TZ, NOW, "k-12345678") as { input: { callback?: unknown } }).input.callback).toBeUndefined();
    const withCallback = buildLogCallInput({ ...base, nextAction: "callback" as const }, interested, TZ, NOW, "k-12345678");
    expect("input" in withCallback && withCallback.input.callback).toBeTruthy();
    const required = buildLogCallInput({ ...base, callbackDate: "2026-10-01", callbackTime: "09:00" }, needsCallback, TZ, NOW, "k-12345678");
    expect(required).toEqual({ error: "Pick a callback time in the future." });
  });

  it("refuses a call time that has not happened yet, and bad durations; duration is ignored when nobody connected", () => {
    const base = initialCallForm(NOW, TZ);
    expect(buildLogCallInput({ ...base, time: "23:00" }, null, TZ, NOW, "k-12345678")).toHaveProperty("error");
    expect(buildLogCallInput({ ...base, minutes: "1", seconds: "75" }, null, TZ, NOW, "k-12345678")).toHaveProperty("error");
    const missed = buildLogCallInput({ ...base, connected: false, minutes: "9" }, null, TZ, NOW, "k-12345678") as { input: { durationSeconds?: number } };
    expect(missed.input.durationSeconds).toBeUndefined();
  });

  it("feedback on an existing call needs something to say", () => {
    const base = initialCallForm(NOW, TZ);
    expect(buildFeedbackInput(base, null, TZ, NOW)).toHaveProperty("error");
    expect(buildFeedbackInput({ ...base, feedback: "Spoke to her." }, null, TZ, NOW)).toEqual({ input: { staffFeedback: "Spoke to her.", outcomeKey: undefined, callback: undefined } });
  });
});

describe("Log Call: book the appointment in the same save", () => {
  const HOURS: ClinicHours = { mon: ["09:00", "16:00"], tue: ["09:00", "16:00"], wed: ["09:00", "16:00"], thu: ["09:00", "16:00"], fri: ["09:00", "16:00"], sat: ["09:00", "16:00"], sun: null };
  const booking = { ...initialCallForm(NOW, TZ), nextAction: "appointment" as const, apptDate: "2026-10-07", apptTime: "10:30" }; // a Wednesday

  it("sends the visit as an instant in the hospital's clock, confirmed by default, with no callback", () => {
    const built = buildLogCallInput(booking, interested, TZ, NOW, "k-12345678", HOURS);
    expect(built).toMatchObject({ input: { appointment: { scheduledAt: "2026-10-07T05:00:00.000Z", confirmed: true }, callback: undefined } });
  });

  it("'not confirmed' books only; a chosen doctor and branch are passed, a blank one is left for the server (the hospital's only one)", () => {
    const built = buildLogCallInput({ ...booking, apptConfirmed: false, apptDoctorId: "d1" }, interested, TZ, NOW, "k-12345678", HOURS) as unknown as { input: { appointment: Record<string, unknown> } };
    expect(built.input.appointment).toEqual({ scheduledAt: "2026-10-07T05:00:00.000Z", confirmed: false, doctorId: "d1" });
  });

  it("asks for the date and time, and refuses a closed day, outside hours and the past before anything is sent", () => {
    expect(buildLogCallInput({ ...booking, apptTime: "" }, null, TZ, NOW, "k-12345678", HOURS)).toEqual({ error: "Choose the appointment date and time." });
    expect(buildLogCallInput({ ...booking, apptDate: "2026-10-04" }, null, TZ, NOW, "k-12345678", HOURS)).toHaveProperty("error", expect.stringContaining("closed on Sundays"));
    expect(buildLogCallInput({ ...booking, apptTime: "17:00" }, null, TZ, NOW, "k-12345678", HOURS)).toHaveProperty("error", expect.stringContaining("09:00 and 16:00"));
    expect(buildLogCallInput({ ...booking, apptDate: "2026-10-01", apptTime: "10:00" }, null, TZ, NOW, "k-12345678", undefined)).toEqual({ error: "That time has already passed. Choose a later time." });
  });

  it("an outcome that needs a follow-up is satisfied by a booked visit; on 'None' it still means a callback", () => {
    const viaVisit = buildLogCallInput({ ...booking, outcomeKey: "needs_callback" }, needsCallback, TZ, NOW, "k-12345678", HOURS) as { input: { callback?: unknown; appointment?: unknown } };
    expect(viaVisit.input.appointment).toBeTruthy();
    expect(viaVisit.input.callback).toBeUndefined();
    const none = buildLogCallInput({ ...initialCallForm(NOW, TZ), outcomeKey: "needs_callback" }, needsCallback, TZ, NOW, "k-12345678") as { input: { callback?: unknown; appointment?: unknown } };
    expect(none.input.callback).toBeTruthy();
    expect(none.input.appointment).toBeUndefined();
  });
});
