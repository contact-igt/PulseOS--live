import { describe, expect, it } from "vitest";
import { checkProviderTemplate, templateVariablesUsed, type ProviderTemplate } from "@pulseos/types";
import { variablesUsed } from "../domain/notification/message-template.js";

const tpl = (over: Partial<ProviderTemplate> = {}): ProviderTemplate => ({ name: "pulseos_follow_up_message", language: "en", status: "APPROVED", bodyParameterCount: 3, hasHeader: false, hasButtons: false, ...over });
const want = (over: Partial<Parameters<typeof checkProviderTemplate>[0]> = {}) => ({ providerTemplateName: "pulseos_follow_up_message", language: "en", variableCount: 3, ...over });

describe("templateVariablesUsed", () => {
  it("lists the distinct variables in order of first use, which is the order the provider receives them", () => {
    expect(templateVariablesUsed("Hello {{patient_name}}, {{staff_name}} from {{hospital_name}}. Bye {{patient_name}}")).toEqual(["patient_name", "staff_name", "hospital_name"]);
    expect(templateVariablesUsed("no variables")).toEqual([]);
  });
  it("is the same list the sender uses (one definition)", () => {
    const body = "Hi {{ patient_name }} {{date}} {{ patient_name}}";
    expect(variablesUsed(body)).toEqual(templateVariablesUsed(body));
  });
});

describe("checkProviderTemplate", () => {
  it("accepts an approved template whose name, language and placeholder count all match", () => {
    expect(checkProviderTemplate(want(), [tpl()])).toEqual({ ok: true });
  });

  it("language is compared case-insensitively, like WhatsNexus does at send time", () => {
    expect(checkProviderTemplate(want({ language: "EN" }), [tpl({ language: "en" })])).toEqual({ ok: true });
  });

  it("refuses a name that is not among the approved templates", () => {
    const r = checkProviderTemplate(want({ providerTemplateName: "pulseos_typo" }), [tpl()]);
    expect(r).toMatchObject({ ok: false, code: "TEMPLATE_NOT_FOUND" });
    expect(r.ok ? "" : r.message).toContain("pulseos_typo");
    expect(checkProviderTemplate(want({ providerTemplateName: "  " }), [tpl()])).toMatchObject({ ok: false, code: "TEMPLATE_NOT_FOUND" });
    expect(checkProviderTemplate(want(), [])).toMatchObject({ ok: false, code: "TEMPLATE_NOT_FOUND" });
  });

  it("refuses a template approved only in another language and says which", () => {
    const r = checkProviderTemplate(want({ language: "en" }), [tpl({ language: "hi" })]);
    expect(r).toMatchObject({ ok: false, code: "TEMPLATE_LANGUAGE_MISMATCH" });
    expect(r.ok ? "" : r.message).toMatch(/hi/);
    expect(r.ok ? "" : r.message).toMatch(/en/);
  });

  it("refuses a different number of variables, in plain words: too few at the provider, and too many", () => {
    const fewer = checkProviderTemplate(want({ variableCount: 3 }), [tpl({ bodyParameterCount: 2 })]);
    expect(fewer).toEqual({ ok: false, code: "TEMPLATE_PARAMETER_COUNT_MISMATCH", message: "Template has 2 placeholders; this PulseOS reminder needs 3." });
    const more = checkProviderTemplate(want({ variableCount: 1 }), [tpl({ bodyParameterCount: 3 })]);
    expect(more).toEqual({ ok: false, code: "TEMPLATE_PARAMETER_COUNT_MISMATCH", message: "Template has 3 placeholders; this PulseOS reminder needs 1." });
    expect(checkProviderTemplate(want({ variableCount: 1 }), [tpl({ bodyParameterCount: 1 })])).toEqual({ ok: true });
    expect(checkProviderTemplate(want({ variableCount: 0 }), [tpl({ bodyParameterCount: 1 })]).ok).toBe(false);
  });

  it("uses the same language to pick between entries that share a name", () => {
    const list = [tpl({ language: "hi", bodyParameterCount: 1 }), tpl({ language: "en", bodyParameterCount: 3 })];
    expect(checkProviderTemplate(want({ language: "en" }), list)).toEqual({ ok: true });
    expect(checkProviderTemplate(want({ language: "hi" }), list)).toMatchObject({ ok: false, code: "TEMPLATE_PARAMETER_COUNT_MISMATCH" });
  });

  it("header and button flags are information only: WhatsNexus supplies them, so they never block a choice", () => {
    expect(checkProviderTemplate(want(), [tpl({ hasHeader: true, hasButtons: true })])).toEqual({ ok: true });
  });
});
