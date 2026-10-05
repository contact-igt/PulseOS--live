import { describe, expect, it, vi, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AppointmentRow, JourneyCardVm, PatientListRow } from "@pulseos/types";
import { NewAppointmentDrawer } from "../NewAppointmentDrawer";
import { hospitalLocalInput, setDisplayTimeZone } from "../format";

const patient = { id: "p1", name: "Asha Rao", phone: "9000000001" } as PatientListRow;
const journey = { id: "j1", journeyType: "Cataract", stage: "enquiry" } as unknown as JourneyCardVm;

function setup(over: Partial<Parameters<typeof NewAppointmentDrawer>[0]> = {}) {
  const onSubmit = vi.fn().mockResolvedValue({ id: "a1" } as AppointmentRow);
  render(
    <NewAppointmentDrawer
      open
      onClose={vi.fn()}
      branches={[{ id: "b1", name: "Main" }]}
      doctors={[{ id: "d1", name: "Dr Menon" }, { id: "d2", name: "Dr Rao" }]}
      initialPatient={patient}
      onSearchPatients={vi.fn().mockResolvedValue([])}
      onLoadPatientJourneys={vi.fn().mockResolvedValue([journey])}
      onSubmit={onSubmit}
      {...over}
    />,
  );
  return { onSubmit };
}

async function fillRequired() {
  await waitFor(() => expect((screen.getByLabelText(/Journey/) as HTMLSelectElement).value).toBe("j1"));
  // A sole branch/doctor is auto-selected and not shown (see the "one branch, one doctor" tests).
  const branch = screen.queryByLabelText(/Branch/);
  if (branch) fireEvent.change(branch, { target: { value: "b1" } });
  const doctor = screen.queryByLabelText(/Doctor/);
  if (doctor) fireEvent.change(doctor, { target: { value: "d1" } });
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  setDisplayTimeZone("Asia/Kolkata");
});

describe("NewAppointmentDrawer — time and doctor rules", () => {
  it("defaults to tomorrow on the hour and bounds the picker at 'now' — as the HOSPITAL reads the clock, not the browser", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-02T04:00:00Z")); // 09:30 IST on 2 Oct = 21:00 PDT on 1 Oct
    setDisplayTimeZone("America/Los_Angeles");
    setup();
    const input = screen.getByTestId("appt-time") as HTMLInputElement;
    expect(input.min).toBe("2026-10-01T21:00");
    expect(input.value).toBe("2026-10-02T21:00"); // tomorrow on the hour in that hospital's zone
    cleanup();
    setDisplayTimeZone("Asia/Kolkata");
    setup();
    const ist = screen.getByTestId("appt-time") as HTMLInputElement;
    expect(ist.min).toBe("2026-10-02T09:30");
    expect(ist.value).toBe("2026-10-03T09:00");
  });

  it("a time that has already passed is refused in the form, in plain words, and nothing is sent", async () => {
    const { onSubmit } = setup();
    await fillRequired();
    fireEvent.change(screen.getByTestId("appt-time"), { target: { value: "2020-01-01T10:00" } });
    expect(screen.getByTestId("appt-time-past").textContent).toBe("Choose a future appointment time.");
    expect((screen.getByTestId("new-appointment-submit") as HTMLButtonElement).disabled).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("a server 'doctor busy' refusal keeps everything typed and says what to do next", async () => {
    const { onSubmit } = setup();
    onSubmit.mockRejectedValueOnce(new Error("resource_unavailable"));
    await fillRequired();
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: "Review" } });
    fireEvent.click(screen.getByTestId("new-appointment-submit"));
    const msg = await screen.findByTestId("new-appointment-error");
    expect(msg.textContent).toBe("This doctor already has another appointment at this time. Choose a different time or doctor.");
    expect((screen.getByLabelText(/Reason/) as HTMLInputElement).value).toBe("Review");
    expect((screen.getByLabelText(/Doctor/) as HTMLSelectElement).value).toBe("d1");
    expect(screen.queryByText(/409|resource_unavailable/)).toBeNull(); // never a status code or an internal code
  });

  it("a server 'in the past' refusal (e.g. the clock moved on) shows the same short copy", async () => {
    const { onSubmit } = setup();
    onSubmit.mockRejectedValueOnce(new Error("appointment_time_in_past"));
    await fillRequired();
    fireEvent.click(screen.getByTestId("new-appointment-submit"));
    expect((await screen.findByTestId("new-appointment-error")).textContent).toBe("Choose a future appointment time.");
  });

  it("asks the server whether the doctor is free once doctor and time are picked, and warns if not — without naming anyone", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onCheckSlot = vi.fn().mockResolvedValue({ available: false, inPast: false });
    setup({ onCheckSlot });
    await fillRequired();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(onCheckSlot).toHaveBeenCalledTimes(1);
    expect(onCheckSlot.mock.calls[0]![0]).toBe("d1");
    expect((await screen.findByTestId("new-appointment-error")).textContent).toContain("This doctor already has another appointment");
    // Switching doctor drops the old warning AT ONCE (before the new answer arrives)…
    let release: (v: { available: boolean; inPast: boolean }) => void = () => undefined;
    onCheckSlot.mockImplementation(() => new Promise((r) => (release = r)));
    fireEvent.change(screen.getByLabelText(/Doctor/), { target: { value: "d2" } });
    expect(screen.queryByTestId("new-appointment-error")).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    // …and a free doctor shows nothing.
    await act(async () => release({ available: true, inPast: false }));
    expect(screen.queryByTestId("new-appointment-error")).toBeNull();
  });

  it("the server's own 'outside clinic hours' answer (same rule as booking) is shown as such - not as 'doctor busy' - and blocks saving", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onCheckSlot = vi.fn().mockResolvedValue({ available: false, inPast: false, outsideHours: true });
    const { onSubmit } = setup({ onCheckSlot }); // no clinicHours prop: only the server knows
    await fillRequired();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect((await screen.findByTestId("appt-time-clinic-hours")).textContent).toBe("That time is outside the clinic's hours. Choose a time inside them.");
    expect(screen.queryByText(/already has another appointment/)).toBeNull();
    expect((screen.getByTestId("new-appointment-submit") as HTMLButtonElement).disabled).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("if the availability check itself fails, no stale warning is left behind (the booking will still check)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onCheckSlot = vi.fn().mockResolvedValueOnce({ available: false, inPast: false }).mockRejectedValue(new Error("offline"));
    setup({ onCheckSlot });
    await fillRequired();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect((await screen.findByTestId("new-appointment-error")).textContent).toContain("already has another appointment");
    fireEvent.change(screen.getByLabelText(/Doctor/), { target: { value: "d2" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(screen.queryByTestId("new-appointment-error")).toBeNull();
  });
});

describe("NewAppointmentDrawer — one branch, one doctor", () => {
  it("shows no Branch or Doctor field and books against the only ones", async () => {
    const { onSubmit } = setup({ doctors: [{ id: "d1", name: "Dr Menon" }] });
    await waitFor(() => expect((screen.getByLabelText(/Journey/) as HTMLSelectElement).value).toBe("j1"));
    expect(screen.queryByLabelText(/Branch/)).toBeNull();
    expect(screen.queryByLabelText(/Doctor/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /book|save|create/i }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({ branchId: "b1", doctorId: "d1" });
  });

  it("still asks for the doctor when there are several", async () => {
    setup();
    expect(screen.queryByLabelText(/Branch/)).toBeNull();
    expect(screen.getByLabelText(/Doctor/)).toBeTruthy();
  });
});
