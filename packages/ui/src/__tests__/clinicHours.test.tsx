import { describe, expect, it, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AppointmentRow, ClinicHours, JourneyCardVm, PatientListRow } from "@pulseos/types";
import { clinicHoursError, clinicHoursHint, clinicHoursOn, clinicTimeBounds } from "../clinicHours";
import { NewAppointmentDrawer } from "../NewAppointmentDrawer";

const day: [string, string] = ["09:00", "16:00"];
const HOURS: ClinicHours = { mon: day, tue: day, wed: day, thu: day, fri: day, sat: day, sun: null };
const SUN = "2027-01-03";
const MON = "2027-01-04";

describe("clinic hours helpers", () => {
  it("describes the week from the data", () => {
    expect(clinicHoursHint(HOURS)).toBe("Clinic hours: Mon–Sat 09:00–16:00, Sunday closed");
    expect(clinicHoursHint({ ...HOURS, sat: ["09:00", "13:00"] })).toBe("Clinic hours: Mon–Fri 09:00–16:00, Sat 09:00–13:00, Sunday closed");
  });
  it("rejects a closed day, 08:59 and 16:00; accepts 09:00 and 15:59", () => {
    expect(clinicHoursError(HOURS, SUN, "10:00")).toMatch(/closed on Sundays/);
    expect(clinicHoursError(HOURS, MON, "08:59")).toMatch(/09:00 and 16:00/);
    expect(clinicHoursError(HOURS, MON, "16:00")).toMatch(/09:00 and 16:00/);
    expect(clinicHoursError(HOURS, MON, "09:00")).toBeNull();
    expect(clinicHoursError(HOURS, MON, "15:59")).toBeNull();
  });
  it("sets time bounds to open and the last minute before close", () => {
    expect(clinicTimeBounds(HOURS, MON)).toEqual({ min: "09:00", max: "15:59" });
    expect(clinicTimeBounds(HOURS, SUN)).toBeNull();
  });
  it("no hours means no hint and no restriction", () => {
    for (const none of [null, undefined]) {
      expect(clinicHoursHint(none)).toBeNull();
      expect(clinicHoursError(none, SUN, "03:00")).toBeNull();
      expect(clinicTimeBounds(none, MON)).toBeNull();
    }
  });
});

const patient = { id: "p1", name: "Asha Rao", phone: "9000000001" } as PatientListRow;
const journey = { id: "j1", journeyType: "Cataract", stage: "enquiry" } as unknown as JourneyCardVm;

async function setup(clinicHours: ClinicHours | null) {
  const onSubmit = vi.fn().mockResolvedValue({ id: "a1" } as AppointmentRow);
  render(
    <NewAppointmentDrawer
      open
      onClose={vi.fn()}
      branches={[{ id: "b1", name: "Main" }]}
      doctors={[{ id: "d1", name: "Dr Menon" }]}
      initialPatient={patient}
      clinicHours={clinicHours}
      onSearchPatients={vi.fn().mockResolvedValue([])}
      onLoadPatientJourneys={vi.fn().mockResolvedValue([journey])}
      onSubmit={onSubmit}
    />,
  );
  await waitFor(() => expect((screen.getByLabelText(/Journey/) as HTMLSelectElement).value).toBe("j1"));
  return { onSubmit };
}

const pick = (value: string) => fireEvent.change(screen.getByTestId("appt-time"), { target: { value } });
afterEach(cleanup);

describe("NewAppointmentDrawer — clinic hours", () => {
  it("shows the hint, refuses a Sunday and out-of-hours time inline, and blocks submit", async () => {
    const { onSubmit } = await setup(HOURS);
    expect(screen.getByTestId("appt-clinic-hours").textContent).toBe("Clinic hours: Mon–Sat 09:00–16:00, Sunday closed");
    const input = screen.getByTestId("appt-time");
    pick(`${SUN}T10:00`);
    expect(screen.getByTestId("appt-time-clinic-hours")).toBeTruthy();
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toContain("appt-time-error");
    fireEvent.submit(input.closest("form")!);
    pick(`${MON}T16:00`);
    expect(screen.getByTestId("appt-time-clinic-hours")).toBeTruthy();
    fireEvent.submit(input.closest("form")!);
    expect(onSubmit).not.toHaveBeenCalled();
    pick(`${MON}T15:59`);
    expect(screen.queryByTestId("appt-time-clinic-hours")).toBeNull();
    pick(`${MON}T09:00`);
    expect(screen.queryByTestId("appt-time-clinic-hours")).toBeNull();
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
  });

  it("without clinic hours there is no hint and a Sunday is fine", async () => {
    await setup(null);
    expect(screen.queryByTestId("appt-clinic-hours")).toBeNull();
    pick(`${SUN}T03:00`);
    expect(screen.queryByTestId("appt-time-clinic-hours")).toBeNull();
  });
});

describe("clinicHoursOn", () => {
  const H: ClinicHours = { mon: ["09:00", "16:00"], tue: ["09:00", "16:00"], wed: ["09:00", "16:00"], thu: ["09:00", "16:00"], fri: ["09:00", "16:00"], sat: ["09:00", "13:00"], sun: null } ;
  it("gives the hours of that date's weekday, 'closed' on a closed day, and null when no hours are set", () => {
    expect(clinicHoursOn(H, "2026-10-05")).toEqual(["09:00", "16:00"]); // Monday
    expect(clinicHoursOn(H, "2026-10-10")).toEqual(["09:00", "13:00"]); // Saturday changed by the admin
    expect(clinicHoursOn(H, "2026-10-04")).toBe("closed"); // Sunday
    expect(clinicHoursOn(null, "2026-10-05")).toBeNull();
    expect(clinicHoursOn(H, "nonsense")).toBeNull();
  });
});
