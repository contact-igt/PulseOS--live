import { describe, expect, it } from "vitest";
import type { ClinicHours } from "@pulseos/types";
import { formToHours, hoursToForm } from "../clinicHoursForm";

const day: [string, string] = ["09:00", "16:00"];
const HOURS: ClinicHours = { mon: day, tue: day, wed: day, thu: day, fri: day, sat: day, sun: null };

describe("clinic hours form", () => {
  it("round-trips the hospital's hours, a closed day staying closed", () => {
    const form = hoursToForm(HOURS);
    expect(form.sun.open).toBe(false);
    expect(form.sat).toEqual({ open: true, from: "09:00", to: "16:00" });
    expect(formToHours(form)).toEqual({ hours: HOURS });
  });

  it("a hospital with no hours yet starts as Monday–Saturday, Sunday closed", () => {
    const form = hoursToForm(null);
    expect(form.mon.open).toBe(true);
    expect(form.sun.open).toBe(false);
  });

  it("changing one day changes only that day", () => {
    const form = hoursToForm(HOURS);
    form.sat = { open: true, from: "09:00", to: "13:00" };
    expect(formToHours(form)).toEqual({ hours: { ...HOURS, sat: ["09:00", "13:00"] } });
  });

  it("refuses a close that is not after the open, and a week with every day closed", () => {
    const form = hoursToForm(HOURS);
    form.tue = { open: true, from: "16:00", to: "09:00" };
    expect(formToHours(form)).toEqual({ error: "Tuesday: closing time must be after opening time." });
    const closed = hoursToForm(HOURS);
    for (const k of Object.keys(closed) as (keyof typeof closed)[]) closed[k] = { ...closed[k], open: false };
    expect(formToHours(closed)).toEqual({ error: "Keep at least one day open." });
  });
});
