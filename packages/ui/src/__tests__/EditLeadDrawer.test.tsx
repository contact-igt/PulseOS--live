import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { LeadEditModel, LeadSourceVm, Lookups, SpecialtyTemplateVm } from "@pulseos/types";
import { EditLeadDrawer } from "../EditLeadDrawer";

const model = (over: Partial<LeadEditModel> = {}): LeadEditModel => ({
  journeyId: "j1",
  patientId: "p1",
  versions: { patient: "2026-10-17T05:00:00.000Z", journey: "2026-10-17T05:00:01.000Z" },
  patient: { name: "Asha Rao", dateOfBirth: null, age: 40, phone: "9876543210", email: null, preferredLanguage: "English", branchId: "b1", marketingConsent: true },
  journey: { journeyType: "Cataract", specialtyKey: "CATARACT", sourceKey: "phone", sourceLabel: "Phone", priority: "normal", notes: null, ownerId: null, stage: "enquiry", campaign: null },
  fields: [],
  fieldValues: {},
  can: { editPatient: true, editJourney: true, changeOwner: true, changeSource: true },
  ...over,
});

const lookups = { branches: [{ id: "b1", name: "Main" }], owners: [{ id: "u1", name: "Priya" }] } as unknown as Pick<Lookups, "branches" | "owners">;
const specialties = [{ key: "CATARACT", displayName: "Cataract" }] as SpecialtyTemplateVm[];
const sources = [
  { id: "s1", key: "phone", label: "Phone" },
  { id: "s2", key: "google", label: "Google" },
] as LeadSourceVm[];

function setup(m = model(), onSubmit = vi.fn().mockResolvedValue({ changes: [], versions: m.versions })) {
  const onClose = vi.fn();
  render(<EditLeadDrawer model={m} lookups={lookups} specialties={specialties} leadSources={sources} insights={<p>insight body</p>} onClose={onClose} onSubmit={onSubmit} />);
  return { onSubmit, onClose };
}

describe("EditLeadDrawer", () => {
  it("opens with the lead's current values and Save disabled until something changes", () => {
    setup();
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Asha Rao");
    expect((screen.getByLabelText("Phone") as HTMLInputElement).value).toBe("9876543210");
    expect((screen.getByTestId("edit-lead-save") as HTMLButtonElement).disabled).toBe(true);
  });

  it("saves only what changed", async () => {
    const { onSubmit, onClose } = setup();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Asha R. Rao" } });
    fireEvent.click(screen.getByTestId("edit-lead-save"));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith({ versions: model().versions, patient: { name: "Asha R. Rao" } });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("keeps the form open and says what happened when the server refuses", async () => {
    const refusal = Object.assign(new Error("phone_in_use"), { body: { patient: { name: "Meera Iyer" } } });
    const { onClose } = setup(model(), vi.fn().mockRejectedValue(refusal));
    fireEvent.change(screen.getByLabelText("Phone"), { target: { value: "9000000000" } });
    fireEvent.click(screen.getByTestId("edit-lead-save"));
    expect((await screen.findByTestId("edit-lead-error")).textContent).toContain("Meera Iyer");
    expect(onClose).not.toHaveBeenCalled();
    expect((screen.getByLabelText("Phone") as HTMLInputElement).value).toBe("9000000000");
  });

  it("asks for a reason when the source is changed, and won't save without it", () => {
    const { onSubmit } = setup();
    fireEvent.change(screen.getByLabelText("Original source"), { target: { value: "google" } });
    expect(screen.getByLabelText("Why is the source being changed?")).toBeTruthy();
    fireEvent.click(screen.getByTestId("edit-lead-save"));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByTestId("edit-lead-error").textContent).toContain("why the original source");
  });

  it("locks what this role may not change", () => {
    setup(model({ can: { editPatient: true, editJourney: true, changeOwner: false, changeSource: false } }));
    expect((screen.getByLabelText("Team member") as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByLabelText("Original source") as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByLabelText("Name") as HTMLInputElement).disabled).toBe(false);
  });

  it("asks before discarding unsaved changes", () => {
    const { onClose } = setup();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Changed" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("shows the insights on their own tab", () => {
    setup();
    fireEvent.click(screen.getByTestId("edit-lead-tab-insights"));
    expect(screen.getByText("insight body")).toBeTruthy();
  });
});
