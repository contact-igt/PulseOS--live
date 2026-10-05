import { describe, expect, it } from "vitest";
import type { LeadRow } from "@pulseos/types";
import { DEFAULT_COLUMNS, DEFAULT_PAGE_SIZE, paginate, parseColumnPref, readPageSize, searchLeads } from "../leadList";
import { activeLeadChips, isDefaultLeadFilters, leadFilterPatch, readLeadFilters, toWorkspaceQuery } from "../leadFilters";

const row = (id: string, patientName: string, phone: string) => ({ id, patientName, phone }) as LeadRow;
const rows = [row("1", "Asha Rao", "+91 98765 43210"), row("2", "Vikram Shah", "+91 99887 76655"), row("3", "Asha Menon", "09123456789")];

describe("Leads search", () => {
  it("matches the name (any part, any case) and the phone by digits (spaces and dashes ignored)", () => {
    expect(searchLeads(rows, "asha").map((r) => r.id)).toEqual(["1", "3"]);
    expect(searchLeads(rows, "VIKRAM SH").map((r) => r.id)).toEqual(["2"]);
    expect(searchLeads(rows, "98765 432").map((r) => r.id)).toEqual(["1"]);
    expect(searchLeads(rows, "99887-7665").map((r) => r.id)).toEqual(["2"]);
  });
  it("blank search keeps everything; fewer than 3 digits never matches a phone by accident", () => {
    expect(searchLeads(rows, "  ")).toHaveLength(3);
    expect(searchLeads(rows, "98").map((r) => r.id)).toEqual([]);
  });
});

describe("Leads paging", () => {
  const many = Array.from({ length: 143 }, (_, i) => i);
  it("pages with a visible range; clamps a stale page number instead of showing an empty list", () => {
    expect(paginate(many, 1, 50)).toMatchObject({ pages: 3, from: 1, to: 50, total: 143 });
    expect(paginate(many, 3, 50)).toMatchObject({ from: 101, to: 143 });
    expect(paginate(many, 99, 50).page).toBe(3);
    expect(paginate(many, 0, 50).page).toBe(1);
    expect(paginate([], 1, 50)).toMatchObject({ total: 0, from: 0, to: 0, pages: 1 });
  });
  it("only the offered page sizes are accepted", () => {
    expect(readPageSize("25")).toBe(25);
    expect(readPageSize("7")).toBe(DEFAULT_PAGE_SIZE);
    expect(readPageSize(null)).toBe(DEFAULT_PAGE_SIZE);
  });
});

describe("column preference", () => {
  it("keeps what was chosen, drops unknown keys, and never leaves the table with no columns", () => {
    expect(parseColumnPref(JSON.stringify(["owner", "bogus", "nextAction"]))).toEqual(["owner", "nextAction"]);
    expect(parseColumnPref("[]")).toEqual(DEFAULT_COLUMNS);
    expect(parseColumnPref("not json")).toEqual(DEFAULT_COLUMNS);
    expect(parseColumnPref(null)).toEqual(DEFAULT_COLUMNS);
  });
});

describe("Leads filters: search and CRM field", () => {
  const get = (qs: string) => { const p = new URLSearchParams(qs); return (k: string) => p.get(k) ?? ""; };
  it("round-trips search and a filterable field through the URL and the API query", () => {
    const f = readLeadFilters(get("q=asha&field=smoker&fv=Yes"), "");
    expect(f).toMatchObject({ q: "asha", fieldKey: "smoker", fieldValue: "Yes" });
    expect(toWorkspaceQuery(f)).toMatchObject({ fieldKey: "smoker", fieldValue: "Yes" });
    expect(toWorkspaceQuery(f)).not.toHaveProperty("q"); // search narrows the loaded list; it is not a server filter
    expect(isDefaultLeadFilters(f)).toBe(false);
    expect(activeLeadChips(f, { sources: [], owners: [], fields: [{ key: "smoker", label: "Smoker" }] }).map((c) => c.label)).toEqual(["Search: asha", "Smoker: Yes"]);
  });
  it("a field without an answer, or a malformed key, is ignored; any filter change goes back to page 1", () => {
    const justChosen = readLeadFilters(get("field=smoker"), "");
    expect(justChosen).toMatchObject({ fieldKey: "smoker", fieldValue: "" });
    expect(toWorkspaceQuery(justChosen)).not.toHaveProperty("fieldKey"); // no answer yet: nothing is sent
    expect(readLeadFilters(get("field=Bad Key&fv=x"), "").fieldKey).toBe("");
    expect(leadFilterPatch({ q: "x" })).toMatchObject({ q: "x", page: undefined });
    expect(leadFilterPatch({ fieldKey: "", fieldValue: "" })).toMatchObject({ field: undefined, fv: undefined });
  });
});
