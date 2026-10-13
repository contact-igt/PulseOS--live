import { checkProviderTemplate, templateVariablesUsed, type ProviderTemplate, type ProviderTemplateCatalogue, type ProviderTemplateCheck } from "@pulseos/types";

export interface TemplateOption {
  /** `name::language`: a name approved in two languages is two options. */
  value: string;
  template: ProviderTemplate;
  label: string;
  compatible: boolean;
  /** Why this option cannot be chosen for this reminder (plain words), or null. */
  reason: string | null;
}

const variables = (n: number) => `${n} variable${n === 1 ? "" : "s"}`;
const CATEGORY: Record<string, string> = { utility: "Utility", marketing: "Marketing", authentication: "Authentication" };
const title = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export const optionValue = (name: string, language: string) => `${name}::${language}`;

/**
 * Every approved WhatsNexus template, each judged against THIS reminder. What matters is how many variables the message uses
 * and the template expects. The language is the template's own: picking a template also sets the reminder's language to it
 * (WhatsNexus approves a template in one language), so language never rules a template out.
 */
export function templateOptions(templates: readonly ProviderTemplate[], want: { body: string }): TemplateOption[] {
  const variableCount = templateVariablesUsed(want.body).length;
  return templates.map((t) => {
    const check = checkProviderTemplate({ providerTemplateName: t.name, language: t.language, variableCount }, [t]);
    const category = t.category ? CATEGORY[t.category] : null;
    const label = [t.name, t.language, variables(t.bodyParameterCount), category].filter(Boolean).join(" · ");
    return { value: optionValue(t.name, t.language), template: t, label, compatible: check.ok, reason: check.ok ? null : check.message };
  });
}

/** Suitable templates first, then the others; each group alphabetical. */
export function suitableFirst(options: readonly TemplateOption[]): TemplateOption[] {
  return [...options].sort((a, b) => Number(b.compatible) - Number(a.compatible) || a.template.name.localeCompare(b.template.name) || a.template.language.localeCompare(b.template.language));
}

export type PickerFilter = "suitable" | "unsuitable" | "all";

export function optionCounts(options: readonly TemplateOption[]): { suitable: number; unsuitable: number; all: number } {
  const suitable = options.filter((o) => o.compatible).length;
  return { suitable, unsuitable: options.length - suitable, all: options.length };
}

/** Open on Suitable when anything fits, otherwise show everything so the admin can see what exists. */
export const defaultFilter = (c: ReturnType<typeof optionCounts>): PickerFilter => (c.suitable > 0 ? "suitable" : "all");

/** The rows the picker shows: narrowed by suitability and by a search over name, language, category and type. */
export function filterOptions(options: readonly TemplateOption[], f: { query: string; filter: PickerFilter }): TemplateOption[] {
  const q = f.query.trim().toLowerCase();
  return options.filter((o) => {
    if (f.filter === "suitable" && !o.compatible) return false;
    if (f.filter === "unsuitable" && o.compatible) return false;
    if (!q) return true;
    const t = o.template;
    return [t.name, t.language, t.category ?? "", t.templateType ?? ""].some((s) => s.toLowerCase().includes(q));
  });
}

/** Is what the admin has now (saved or just picked: name AND language) usable with this message? */
export function templateChoice(want: { providerTemplateName: string; language: string; body: string }, templates: readonly ProviderTemplate[]): ProviderTemplateCheck {
  return checkProviderTemplate({ providerTemplateName: want.providerTemplateName, language: want.language, variableCount: templateVariablesUsed(want.body).length }, templates);
}

/** The facts an admin needs about a template, in the order they are shown. */
export function templateDetails(t: ProviderTemplate): { label: string; value: string }[] {
  return [
    { label: "Template", value: t.name },
    { label: "Category", value: t.category ? (CATEGORY[t.category] ?? title(t.category)) : "Not reported" },
    { label: "Type", value: t.templateType ? title(t.templateType) : "Not reported" },
    { label: "Language", value: t.language },
    { label: "Variables", value: String(t.bodyParameterCount) },
    { label: "Header", value: t.hasHeader ? "Yes" : "No" },
    { label: "Buttons", value: t.hasButtons ? "Yes" : "No" },
    { label: "Status", value: "Approved" },
  ];
}

/** Which detail of the message becomes {{1}}, {{2}} … at the provider (order of first use; a repeat is not a new position). */
export function variableMapping(body: string): { position: number; variable: string }[] {
  return templateVariablesUsed(body).map((variable, i) => ({ position: i + 1, variable }));
}

/**
 * Something to tell the admin about the catalogue itself. Null when WhatsNexus is not the sender (the free-text name still
 * applies) or the list is fine. `blocksSave` mirrors the server, which refuses a save it cannot verify.
 */
export function catalogueNotice(c: ProviderTemplateCatalogue, want?: { body: string }): { blocksSave: boolean; text: string } | null {
  if (!c.active) return null;
  if (c.state !== "OK") return { blocksSave: true, text: c.message ?? "WhatsNexus templates could not be read right now." };
  if (c.templates.length === 0) return { blocksSave: true, text: "WhatsNexus has no approved templates for this hospital yet. Get one approved in WhatsNexus, then refresh." };
  if (want) {
    const needed = templateVariablesUsed(want.body).length;
    if (!c.templates.some((t) => t.bodyParameterCount === needed)) {
      return { blocksSave: false, text: `None of the approved templates has ${needed} placeholders. Change the message so it uses the same number of details as one of them, or ask for a matching template in WhatsNexus.` };
    }
  }
  return null;
}
