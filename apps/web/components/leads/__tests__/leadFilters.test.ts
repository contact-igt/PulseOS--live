import { describe, expect, it } from "vitest";
import { activeLeadChips, DEFAULT_LEAD_VIEW, isDefaultLeadFilters, leadFilterPatch, readLeadFilters, resetLeadPatch, toWorkspaceQuery } from "../leadFilters";

const TODAY = "2026-10-02";
const read = (qs: string) => {
  const p = new URLSearchParams(qs);
  return readLeadFilters((k) => p.get(k) ?? "", TODAY);
};
const UUID = "0a1b2c3d-1111-4222-8333-444455556666";

describe("readLeadFilters (URL → filters)", () => {
  it("an empty URL is every lead, any date, any owner", () => {
    expect(read("")).toEqual({ view: DEFAULT_LEAD_VIEW, range: undefined, from: undefined, to: undefined, owner: "", source: "", service: "", status: undefined, due: undefined, q: "", fieldKey: "", fieldValue: "" });
  });

  it("reads view, preset range, owner, source, service", () => {
    expect(read(`view=follow_up_due&range=7d&owner=mine&source=instagram&service=Cataract`)).toMatchObject({ view: "follow_up_due", range: "7d", owner: "mine", source: "instagram", service: "Cataract" });
    expect(read(`owner=${UUID}`).owner).toBe(UUID);
    expect(read("owner=unassigned").owner).toBe("unassigned");
  });

  it("falls back safely on junk: unknown view / range / owner / status are ignored", () => {
    const f = read("view=bogus&range=forever&owner=drop-table&status=zzz&due=sometime");
    expect(f).toMatchObject({ view: "all", range: undefined, owner: "", status: undefined, due: undefined });
  });

  it("a custom range needs two real, ordered dates; otherwise it is dropped", () => {
    expect(read("range=custom&from=2026-09-01&to=2026-09-30")).toMatchObject({ range: "custom", from: "2026-09-01", to: "2026-09-30" });
    expect(read("range=custom&from=2026-09-30&to=2026-09-01").range).toBeUndefined();
    expect(read("range=custom&from=2026-02-30&to=2026-03-01").range).toBeUndefined();
    expect(read("range=custom").range).toBeUndefined();
  });

  it("overdue only applies to Follow-up Due", () => {
    expect(read("view=follow_up_due&due=overdue").due).toBe("overdue");
    expect(read("view=all&due=overdue").due).toBeUndefined();
  });
});

describe("leadFilterPatch (change → URL patch)", () => {
  it("the default view and empty values are removed from the URL", () => {
    expect(leadFilterPatch({ view: "all" })).toMatchObject({ view: undefined });
    expect(leadFilterPatch({ owner: "" })).toMatchObject({ owner: undefined });
    expect(leadFilterPatch({ view: "uncontacted" })).toMatchObject({ view: "uncontacted" });
  });

  it("changing the view drops the overdue refinement unless it is still Follow-up Due", () => {
    expect(leadFilterPatch({ view: "lost" })).toMatchObject({ due: undefined });
    expect(leadFilterPatch({ view: "follow_up_due", due: "overdue" })).toMatchObject({ view: "follow_up_due", due: "overdue" });
  });

  it("a preset range removes custom dates; custom keeps them", () => {
    expect(leadFilterPatch({ range: "30d" })).toMatchObject({ range: "30d", from: undefined, to: undefined });
    expect(leadFilterPatch({ range: "custom", from: "2026-09-01", to: "2026-09-02" })).toMatchObject({ range: "custom", from: "2026-09-01", to: "2026-09-02" });
    expect(leadFilterPatch({ range: undefined })).toMatchObject({ range: undefined, from: undefined, to: undefined });
  });

  it("reset clears every Leads filter and nothing else", () => {
    expect(Object.keys(resetLeadPatch()).sort()).toEqual(["due", "field", "from", "fv", "owner", "page", "q", "range", "service", "source", "status", "to", "view"]);
  });
});

describe("toWorkspaceQuery / chips", () => {
  it("sends only what is set", () => {
    expect(toWorkspaceQuery(read(""))).toEqual({});
    expect(toWorkspaceQuery(read("view=today&owner=mine&range=7d"))).toEqual({ view: "today", owner: "mine", range: "7d" });
    expect(toWorkspaceQuery(read("range=custom&from=2026-09-01&to=2026-09-30"))).toEqual({ range: "custom", from: "2026-09-01", to: "2026-09-30" });
  });

  it("isDefault ignores nothing that narrows the list", () => {
    expect(isDefaultLeadFilters(read(""))).toBe(true);
    expect(isDefaultLeadFilters(read("view=today"))).toBe(false);
    expect(isDefaultLeadFilters(read("source=google"))).toBe(false);
  });

  it("chips name each narrowing filter in plain words, using the catalogue labels", () => {
    const chips = activeLeadChips(read("view=follow_up_due&due=overdue&owner=unassigned&source=instagram&service=Cataract"), { sources: [{ key: "instagram", label: "Instagram" }], owners: [] });
    expect(chips.map((c) => c.label)).toEqual(["Overdue only", "Team Member: Unassigned", "Source: Instagram", "Service: Cataract"]);
  });
});
