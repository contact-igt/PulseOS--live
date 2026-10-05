import { describe, expect, it } from "vitest";
import { DATE_NOT_RECORDED, DOCTOR_NOT_RECORDED, treatmentDateLine, treatmentDoctorLabel } from "../treatmentDates";

const fmt = (iso: string) => iso.slice(0, 10);

describe("treatment date lines", () => {
  it("scheduled shows 'Scheduled for', completed shows 'Completed on' — different fields, different words", () => {
    expect(treatmentDateLine({ status: "SCHEDULED", plannedDate: "2026-10-10T05:30:00Z", completedAt: null }, fmt)).toEqual({ label: "Scheduled for", text: "2026-10-10", recorded: true });
    expect(treatmentDateLine({ status: "COMPLETED", plannedDate: "2026-10-01T05:30:00Z", completedAt: "2026-10-03T05:30:00Z" }, fmt)).toEqual({ label: "Completed on", text: "2026-10-03", recorded: true });
  });

  it("a completed row never borrows another date: no completion time reads 'Date not recorded' even with a planned date", () => {
    expect(treatmentDateLine({ status: "COMPLETED", plannedDate: "2026-10-01T05:30:00Z", completedAt: null }, fmt)).toEqual({ label: "Completed on", text: DATE_NOT_RECORDED, recorded: false });
    expect(treatmentDateLine({ status: "SCHEDULED", plannedDate: null, completedAt: null }, fmt)).toEqual({ label: "Scheduled for", text: DATE_NOT_RECORDED, recorded: false });
  });

  it("statuses without a date line show none", () => {
    for (const status of ["ADVISED", "DECISION_PENDING", "ACCEPTED", "DECLINED", "CANCELLED", "LOST"] as const) expect(treatmentDateLine({ status, plannedDate: null, completedAt: null }, fmt)).toBeNull();
  });

  it("doctor: the scheduled resource first, the journey's doctor next, 'Doctor not recorded' only where one is expected", () => {
    expect(treatmentDoctorLabel({ status: "SCHEDULED", resourceName: "Dr A", doctorName: "Dr B" })).toBe("Dr A");
    expect(treatmentDoctorLabel({ status: "SCHEDULED", resourceName: null, doctorName: "Dr B" })).toBe("Dr B");
    expect(treatmentDoctorLabel({ status: "SCHEDULED", resourceName: null, doctorName: null })).toBe(DOCTOR_NOT_RECORDED);
    expect(treatmentDoctorLabel({ status: "ADVISED", resourceName: null, doctorName: null })).toBe("—");
  });
});
