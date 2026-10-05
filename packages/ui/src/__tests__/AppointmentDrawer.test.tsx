import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { APPOINTMENT_TRANSITIONS, type AppointmentRow, type AppointmentStatus } from "@pulseos/types";
import { AppointmentDrawer } from "../AppointmentDrawer";

const row = (status: AppointmentStatus, over: Partial<AppointmentRow> = {}): AppointmentRow => ({
  id: "a1", patientId: "p1", patientName: "Asha Rao", journeyId: "j1", branchName: "Main", doctorId: "d1", doctorName: "Dr Menon", status,
  scheduledAt: "2026-10-02T05:30:00.000Z", reason: "Cataract consultation", service: "Cataract", ...over,
});

function setup(status: AppointmentStatus, props: Partial<Parameters<typeof AppointmentDrawer>[0]> = {}) {
  const handlers = { onClose: vi.fn(), onAction: vi.fn(), onComplete: vi.fn(), onReschedule: vi.fn() };
  render(<AppointmentDrawer appointment={row(status)} {...handlers} timeZone="Asia/Kolkata" {...props} />);
  return handlers;
}

describe("AppointmentDrawer", () => {
  it("shows who, when, which doctor, which service, where it stands — in the hospital's clock", () => {
    setup("scheduled");
    const details = screen.getByTestId("appointment-drawer-details");
    expect(details.textContent).toContain("Asha Rao");
    expect(details.textContent).toContain("Cataract");
    expect(details.textContent).toContain("Dr Menon");
    expect(details.textContent).toContain("Main");
    expect(details.textContent).toContain("11:00 am"); // 05:30Z = 11:00 IST
    expect(details.textContent).toContain("Booked");
  });

  it("offers ONE obvious next step per status, in plain words", () => {
    const expected: [AppointmentStatus, string | null][] = [
      ["scheduled", "Check in"], ["confirmed", "Check in"], ["checked_in", "Move to waiting"], ["waiting", "Send to doctor"], ["with_doctor", "Consultation done"], ["completed", null], ["no_show", null], ["cancelled", null],
    ];
    for (const [status, label] of expected) {
      const { unmount } = render(<AppointmentDrawer appointment={row(status)} onClose={vi.fn()} onAction={vi.fn()} onComplete={vi.fn()} onReschedule={vi.fn()} />);
      const primaries = ["Check in", "Move to waiting", "Send to doctor", "Consultation done", "Confirm appointment"].filter((l) => screen.queryByRole("button", { name: l }));
      expect(primaries).toEqual(label ? [label] : []);
      unmount();
    }
  });

  it("only offers the quiet steps the shared transition graph allows", () => {
    for (const status of Object.keys(APPOINTMENT_TRANSITIONS) as AppointmentStatus[]) {
      const { unmount } = render(<AppointmentDrawer appointment={row(status)} onClose={vi.fn()} onAction={vi.fn()} onComplete={vi.fn()} onReschedule={vi.fn()} />);
      const allowed = APPOINTMENT_TRANSITIONS[status];
      expect(!!screen.queryByTestId("drawer-action-reschedule")).toBe(allowed.includes("reschedule"));
      expect(!!screen.queryByTestId("drawer-action-no-show")).toBe(allowed.includes("mark_no_show"));
      expect(!!screen.queryByTestId("drawer-action-cancel")).toBe(allowed.includes("cancel"));
      unmount();
    }
  });

  it("the primary button calls the step; Consultation done opens the completion step instead", () => {
    const a = setup("scheduled");
    fireEvent.click(screen.getByRole("button", { name: "Check in" }));
    expect(a.onAction).toHaveBeenCalledWith(expect.objectContaining({ id: "a1" }), "check_in");
    document.body.innerHTML = "";
    const b = setup("with_doctor");
    fireEvent.click(screen.getByRole("button", { name: "Consultation done" }));
    expect(b.onComplete).toHaveBeenCalled();
    expect(b.onAction).not.toHaveBeenCalled();
  });

  it("cancelling needs a reason: nothing is sent until one is chosen, then it is sent with the note", () => {
    const h = setup("confirmed");
    fireEvent.click(screen.getByTestId("drawer-action-cancel"));
    fireEvent.click(screen.getByTestId("drawer-reason-confirm"));
    expect(screen.getByTestId("drawer-reason-error").textContent).toMatch(/why it is being cancelled/i);
    expect(h.onAction).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId("drawer-reason-reason"), { target: { value: "patient_requested" } });
    fireEvent.change(screen.getByTestId("drawer-reason-note"), { target: { value: " Travelling " } });
    fireEvent.click(screen.getByTestId("drawer-reason-confirm"));
    expect(h.onAction).toHaveBeenCalledWith(expect.objectContaining({ id: "a1" }), "cancel", { reasonCode: "patient_requested", note: "Travelling" });
  });

  it("the reason list matches what is being done (no 'Patient did not arrive' for a cancellation)", () => {
    setup("confirmed");
    fireEvent.click(screen.getByTestId("drawer-action-cancel"));
    const labels = Array.from((screen.getByTestId("drawer-reason-reason") as HTMLSelectElement).options).map((o) => o.textContent);
    expect(labels).toContain("Doctor unavailable");
    expect(labels).not.toContain("Patient did not arrive");
  });

  it("a no-show starts on 'Patient did not arrive' and can be confirmed in one click", () => {
    const h = setup("scheduled");
    fireEvent.click(screen.getByTestId("drawer-action-no-show"));
    expect((screen.getByTestId("drawer-reason-reason") as HTMLSelectElement).value).toBe("patient_no_show");
    fireEvent.click(screen.getByTestId("drawer-reason-confirm"));
    expect(h.onAction).toHaveBeenCalledWith(expect.anything(), "mark_no_show", { reasonCode: "patient_no_show" });
  });

  it("rescheduling needs the new date, time and a reason, and sends them as typed (the page converts the hospital clock)", () => {
    const h = setup("scheduled");
    fireEvent.click(screen.getByTestId("drawer-action-reschedule"));
    fireEvent.click(screen.getByTestId("drawer-reason-confirm"));
    expect(screen.getByTestId("drawer-reason-error").textContent).toMatch(/new date and time/i);
    fireEvent.change(screen.getByTestId("drawer-reschedule-date"), { target: { value: "2026-10-05" } });
    fireEvent.change(screen.getByTestId("drawer-reschedule-time"), { target: { value: "10:30" } });
    fireEvent.click(screen.getByTestId("drawer-reason-confirm"));
    expect(screen.getByTestId("drawer-reason-error").textContent).toMatch(/why it is being rescheduled/i);
    fireEvent.change(screen.getByTestId("drawer-reason-reason"), { target: { value: "doctor_unavailable" } });
    fireEvent.click(screen.getByTestId("drawer-reason-confirm"));
    expect(h.onReschedule).toHaveBeenCalledWith(expect.objectContaining({ id: "a1" }), { date: "2026-10-05", time: "10:30", reasonCode: "doctor_unavailable" });
  });

  it("labels every reason field and links the error to it", () => {
    setup("confirmed");
    fireEvent.click(screen.getByTestId("drawer-action-cancel"));
    expect(screen.getByLabelText("Reason")).toBe(screen.getByTestId("drawer-reason-reason"));
    fireEvent.click(screen.getByTestId("drawer-reason-confirm"));
    const select = screen.getByTestId("drawer-reason-reason");
    expect(select.getAttribute("aria-invalid")).toBe("true");
    expect(select.getAttribute("aria-describedby")).toBe(screen.getByTestId("drawer-reason-error").id);
  });

  it("shows the waiting time derived from the check-in time, and the status in words (not colour alone)", () => {
    const checkedInAt = new Date(Date.now() - 14 * 60_000).toISOString();
    render(<AppointmentDrawer appointment={row("waiting", { checkedInAt, waitingStartedAt: checkedInAt })} onClose={vi.fn()} onAction={vi.fn()} onComplete={vi.fn()} onReschedule={vi.fn()} />);
    expect(screen.getByTestId("appointment-drawer-wait").textContent).toBe("Waiting 14 min");
    expect(screen.getAllByText("Waiting").length).toBeGreaterThan(0);
  });

  it("hides every step for a read-only viewer", () => {
    setup("scheduled", { readOnly: true });
    expect(screen.queryByRole("button", { name: "Check in" })).toBeNull();
    expect(screen.queryByTestId("drawer-action-cancel")).toBeNull();
  });

  it("keeps a server error beside the actions", () => {
    setup("scheduled", { error: "Could not update the appointment. Please try again." });
    expect(screen.getByTestId("appointment-drawer-error").textContent).toMatch(/try again/i);
  });
});
