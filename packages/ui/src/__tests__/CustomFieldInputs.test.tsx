import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { CustomFieldDefinitionVm } from "@pulseos/types";
import { CustomFieldInputs, defaultsFor, normalizeFieldValues } from "../CustomFieldInputs";

const base = { specialtyKey: "CATARACT", options: null, required: false, sortOrder: 0, archived: false } as const;
const f = (over: Partial<CustomFieldDefinitionVm> & Pick<CustomFieldDefinitionVm, "id" | "key" | "label" | "fieldType">): CustomFieldDefinitionVm => ({ ...base, ...over });

describe("CustomFieldInputs", () => {
  it("renders the right control for every field type", () => {
    const fields = [
      f({ id: "1", key: "t", label: "Text", fieldType: "TEXT" }),
      f({ id: "2", key: "l", label: "Long", fieldType: "LONG_TEXT" }),
      f({ id: "3", key: "n", label: "Number", fieldType: "NUMBER" }),
      f({ id: "4", key: "p", label: "Phone", fieldType: "PHONE" }),
      f({ id: "5", key: "e", label: "Email", fieldType: "EMAIL" }),
      f({ id: "6", key: "d", label: "Date", fieldType: "DATE" }),
      f({ id: "7", key: "dt", label: "When", fieldType: "DATETIME" }),
      f({ id: "8", key: "b", label: "Flag", fieldType: "BOOLEAN" }),
      f({ id: "9", key: "s", label: "Pick", fieldType: "SELECT", options: ["A", "B"] }),
      f({ id: "10", key: "m", label: "Many", fieldType: "MULTI_SELECT", options: ["X", "Y"] }),
    ];
    render(<CustomFieldInputs fields={fields} values={{}} onChange={() => {}} idPrefix="t" />);
    expect((screen.getByLabelText("Long") as HTMLElement).tagName).toBe("TEXTAREA");
    expect((screen.getByLabelText("Number") as HTMLInputElement).type).toBe("number");
    expect((screen.getByLabelText("Phone") as HTMLInputElement).type).toBe("tel");
    expect((screen.getByLabelText("Email") as HTMLInputElement).type).toBe("email");
    expect((screen.getByLabelText("Date") as HTMLInputElement).type).toBe("date");
    expect((screen.getByLabelText("When") as HTMLInputElement).type).toBe("datetime-local");
    expect((screen.getByLabelText("Pick") as HTMLSelectElement).tagName).toBe("SELECT");
    expect(screen.getByRole("group", { name: "Many" })).toBeTruthy();
    expect(screen.getAllByRole("checkbox")).toHaveLength(3); // boolean + two options
  });

  it("reports edits by key: text, boolean and multi-select (as an array)", () => {
    const onChange = vi.fn();
    const fields = [
      f({ id: "1", key: "t", label: "Text", fieldType: "TEXT" }),
      f({ id: "2", key: "m", label: "Many", fieldType: "MULTI_SELECT", options: ["X", "Y"] }),
    ];
    const { rerender } = render(<CustomFieldInputs fields={fields} values={{}} onChange={onChange} idPrefix="t" />);
    fireEvent.change(screen.getByLabelText("Text"), { target: { value: "hi" } });
    expect(onChange).toHaveBeenCalledWith("t", "hi");
    fireEvent.click(screen.getByLabelText("X"));
    expect(onChange).toHaveBeenCalledWith("m", ["X"]);
    rerender(<CustomFieldInputs fields={fields} values={{ m: ["X"] }} onChange={onChange} idPrefix="t" />);
    fireEvent.click(screen.getByLabelText("Y"));
    expect(onChange).toHaveBeenLastCalledWith("m", ["X", "Y"]);
    fireEvent.click(screen.getByLabelText("X"));
    expect(onChange).toHaveBeenLastCalledWith("m", []);
  });

  it("marks required fields and groups them under headings only when there is more than one group", () => {
    const grouped = [
      f({ id: "1", key: "a", label: "Alpha", fieldType: "TEXT", required: true, groupKey: "qualification" }),
      f({ id: "2", key: "b", label: "Beta", fieldType: "TEXT", groupKey: "service_details" }),
    ];
    const { rerender } = render(<CustomFieldInputs fields={grouped} values={{}} onChange={() => {}} idPrefix="t" />);
    expect(screen.getByText("Qualification")).toBeTruthy();
    expect(screen.getByText("Service Details")).toBeTruthy();
    expect((screen.getByLabelText(/Alpha/) as HTMLInputElement).required).toBe(true);
    rerender(<CustomFieldInputs fields={[grouped[0]!]} values={{}} onChange={() => {}} idPrefix="t" />);
    expect(screen.queryByText("Qualification")).toBeNull();
  });
});

describe("defaultsFor / normalizeFieldValues", () => {
  const fields = [
    f({ id: "1", key: "pref", label: "Pref", fieldType: "SELECT", options: ["A"], defaultValue: "A" }),
    f({ id: "2", key: "n", label: "N", fieldType: "NUMBER" }),
    f({ id: "3", key: "when", label: "When", fieldType: "DATETIME" }),
    f({ id: "4", key: "m", label: "M", fieldType: "MULTI_SELECT", options: ["X"], defaultValue: ["X"] }),
  ];
  it("pre-fills configured defaults", () => {
    expect(defaultsFor(fields)).toEqual({ pref: "A", m: ["X"] });
  });
  it("drops empty values and turns a date-time into an instant", () => {
    const out = normalizeFieldValues(fields, { pref: "", n: "12", when: "2026-10-02T10:30", m: [] });
    expect(out).toEqual({ n: "12", when: new Date("2026-10-02T10:30").toISOString() });
    expect(normalizeFieldValues(fields, {})).toBeUndefined();
  });
});
