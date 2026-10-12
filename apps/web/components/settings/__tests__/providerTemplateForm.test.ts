import { describe, expect, it } from "vitest";
import type { ProviderTemplate, ProviderTemplateCatalogue } from "@pulseos/types";
import { catalogueNotice, defaultFilter, filterOptions, optionCounts, optionValue, suitableFirst, templateChoice, templateDetails, templateOptions, variableMapping } from "../providerTemplateForm";

const tpl = (name: string, bodyParameterCount: number, language = "en", over: Partial<ProviderTemplate> = {}): ProviderTemplate => ({ name, language, status: "APPROVED", bodyParameterCount, hasHeader: false, hasButtons: false, ...over });
const catalogue = (over: Partial<ProviderTemplateCatalogue> = {}): ProviderTemplateCatalogue => ({ provider: "whatsnexus", active: true, state: "OK", message: null, templates: [], fetchedAt: "2026-10-12T10:00:00.000Z", ...over });
const BODY3 = "Hello {{patient_name}}, this is {{staff_name}} from {{hospital_name}}.";
const BODY6 = "Hi {{patient_name}}, {{doctor_name}} at {{hospital_name}} ({{branch_name}}) on {{date}} at {{time}}.";

describe("templateOptions", () => {
  const list = [tpl("zeta_two", 2), tpl("pulseos_follow_up_message", 3), tpl("hindi_followup", 3, "hi"), tpl("us_followup", 3, "en_US")];

  it("judges each approved template on how many variables it needs, and puts the suitable ones first", () => {
    const opts = suitableFirst(templateOptions(list, { body: BODY3 }));
    expect(opts.map((o) => [o.template.name, o.compatible])).toEqual([["hindi_followup", true], ["pulseos_follow_up_message", true], ["us_followup", true], ["zeta_two", false]]);
    expect(opts[3]!.reason).toBe("Template has 2 placeholders; this PulseOS reminder needs 3.");
    expect(opts[1]!.reason).toBeNull();
  });

  it("language never rules a template out: the template's own language is used when it is chosen", () => {
    const opts = templateOptions([tpl("us_followup", 3, "en_US"), tpl("bug_fix", 3, "en_GB")], { body: BODY3 });
    expect(opts.every((o) => o.compatible)).toBe(true);
  });

  it("the label carries language, variables and category", () => {
    const opts = templateOptions([tpl("pulseos_follow_up_message", 3, "en_US", { category: "utility" }), tpl("one", 1, "en")], { body: BODY3 });
    expect(opts[0]!.label).toBe("pulseos_follow_up_message · en_US · 3 variables · Utility");
    expect(opts[1]!.label).toBe("one · en · 1 variable");
  });

  it("recomputes as the message changes: dropping a variable makes the 2-placeholder template fit", () => {
    const opts = templateOptions(list, { body: "Hello {{patient_name}}, this is {{staff_name}}." });
    expect(opts.find((o) => o.template.name === "zeta_two")!.compatible).toBe(true);
    expect(opts.find((o) => o.template.name === "pulseos_follow_up_message")!.compatible).toBe(false);
  });

  it("the same name approved in two languages is two options with distinct values", () => {
    const opts = templateOptions([tpl("dual", 3, "en"), tpl("dual", 1, "hi")], { body: BODY3 });
    expect(opts.map((o) => o.compatible)).toEqual([true, false]);
    expect(new Set(opts.map((o) => o.value)).size).toBe(2);
    expect(opts[0]!.value).toBe(optionValue("dual", "en"));
  });
});

describe("filterOptions / optionCounts (the picker list)", () => {
  const list = suitableFirst(templateOptions([
    tpl("pulseos_follow_up_message", 3, "en", { category: "utility" }),
    tpl("us_followup", 3, "en_US", { category: "marketing" }),
    tpl("school_offer", 0, "en", { category: "marketing", templateType: "image" }),
    tpl("two_vars", 2, "hi", { category: "utility" }),
  ], { body: BODY3 }));
  const names = (o: { template: ProviderTemplate }[]) => o.map((x) => x.template.name);

  it("counts suitable and not suitable templates", () => {
    expect(optionCounts(list)).toEqual({ suitable: 2, unsuitable: 2, all: 4 });
  });
  it("filters by suitability, keeping the suitable-first order", () => {
    expect(names(filterOptions(list, { query: "", filter: "suitable" }))).toEqual(["pulseos_follow_up_message", "us_followup"]);
    expect(names(filterOptions(list, { query: "", filter: "unsuitable" }))).toEqual(["school_offer", "two_vars"]);
    expect(names(filterOptions(list, { query: "", filter: "all" }))).toHaveLength(4);
  });
  it("search matches name, language, category and type, ignoring case and spacing", () => {
    expect(names(filterOptions(list, { query: "  FOLLOW ", filter: "all" }))).toEqual(["pulseos_follow_up_message", "us_followup"]);
    expect(names(filterOptions(list, { query: "en_us", filter: "all" }))).toEqual(["us_followup"]);
    expect(names(filterOptions(list, { query: "marketing", filter: "all" }))).toEqual(["us_followup", "school_offer"]);
    expect(names(filterOptions(list, { query: "image", filter: "all" }))).toEqual(["school_offer"]);
    expect(filterOptions(list, { query: "nothing like this", filter: "all" })).toEqual([]);
  });
  it("search and filter combine", () => {
    expect(names(filterOptions(list, { query: "marketing", filter: "suitable" }))).toEqual(["us_followup"]);
  });
  it("opens on Suitable when something fits, otherwise on All", () => {
    expect(defaultFilter(optionCounts(list))).toBe("suitable");
    expect(defaultFilter({ suitable: 0, unsuitable: 5, all: 5 })).toBe("all");
  });
});

describe("templateChoice (what the admin currently has selected)", () => {
  const list = [tpl("pulseos_follow_up_message", 3, "en_US")];
  const want = (over: Partial<Parameters<typeof templateChoice>[0]> = {}) => ({ providerTemplateName: "pulseos_follow_up_message", language: "en_US", body: BODY3, ...over });

  it("is compatible when name, language and variable count match", () => {
    expect(templateChoice(want(), list)).toEqual({ ok: true });
  });
  it("says why a saved name is not usable any more", () => {
    expect(templateChoice(want({ providerTemplateName: "gone" }), list)).toMatchObject({ ok: false, code: "TEMPLATE_NOT_FOUND" });
    expect(templateChoice(want({ body: "Hi {{patient_name}}" }), list)).toMatchObject({ ok: false, code: "TEMPLATE_PARAMETER_COUNT_MISMATCH", message: "Template has 3 placeholders; this PulseOS reminder needs 1." });
    expect(templateChoice(want({ language: "en" }), list)).toMatchObject({ ok: false, code: "TEMPLATE_LANGUAGE_MISMATCH" });
  });
});

describe("templateDetails", () => {
  it("describes a template in plain words for the detail card", () => {
    const d = templateDetails(tpl("appointment_reminder", 4, "en_US", { category: "utility", templateType: "image", hasHeader: true, hasButtons: true }));
    expect(d).toEqual([
      { label: "Template", value: "appointment_reminder" },
      { label: "Category", value: "Utility" },
      { label: "Type", value: "Image" },
      { label: "Language", value: "en_US" },
      { label: "Variables", value: "4" },
      { label: "Header", value: "Yes" },
      { label: "Buttons", value: "Yes" },
      { label: "Status", value: "Approved" },
    ]);
  });
  it("says 'Not reported' when an older WhatsNexus does not send the category or type", () => {
    const d = templateDetails(tpl("x", 0));
    expect(d.find((r) => r.label === "Category")!.value).toBe("Not reported");
    expect(d.find((r) => r.label === "Type")!.value).toBe("Not reported");
    expect(d.find((r) => r.label === "Header")!.value).toBe("No");
  });
});

describe("variableMapping", () => {
  it("shows which message detail becomes {{1}}, {{2}} … (order of first use, repeats counted once)", () => {
    expect(variableMapping("Hi {{patient_name}}, {{staff_name}} from {{hospital_name}}. Bye {{patient_name}}")).toEqual([
      { position: 1, variable: "patient_name" },
      { position: 2, variable: "staff_name" },
      { position: 3, variable: "hospital_name" },
    ]);
    expect(variableMapping(BODY6)).toHaveLength(6);
    expect(variableMapping("nothing")).toEqual([]);
  });
});

describe("catalogueNotice", () => {
  it("says nothing when WhatsNexus is not the sender: the free-text name still applies", () => {
    expect(catalogueNotice(catalogue({ active: false, state: "NOT_CONFIGURED", message: "not set up" }))).toBeNull();
    expect(catalogueNotice(catalogue({ active: false }))).toBeNull();
  });
  it("blocks saving, with the reason, when WhatsNexus is the sender but its list cannot be read", () => {
    expect(catalogueNotice(catalogue({ state: "UNAVAILABLE", message: "WhatsNexus could not list templates (HTTP 503)." }))).toEqual({ blocksSave: true, text: "WhatsNexus could not list templates (HTTP 503)." });
    expect(catalogueNotice(catalogue({ state: "REJECTED", message: null }))?.blocksSave).toBe(true);
  });
  it("blocks saving when the list is empty: no choice could be valid", () => {
    const n = catalogueNotice(catalogue({ templates: [] }));
    expect(n).toMatchObject({ blocksSave: true });
    expect(n!.text).toMatch(/no approved templates/i);
  });
  it("tells the admin when templates exist but none fits this message", () => {
    const n = catalogueNotice(catalogue({ templates: [tpl("a", 1), tpl("b", 4)] }), { body: BODY6 });
    expect(n).toEqual({ blocksSave: false, text: "None of the approved templates has 6 placeholders. Change the message so it uses the same number of details as one of them, or ask for a matching template in WhatsNexus." });
  });
  it("is silent when the list is there and something fits", () => {
    expect(catalogueNotice(catalogue({ templates: [tpl("a", 1)] }), { body: "Hi {{patient_name}}" })).toBeNull();
    expect(catalogueNotice(catalogue({ templates: [tpl("a", 1)] }))).toBeNull();
  });
});
