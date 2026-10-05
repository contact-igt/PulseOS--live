import { TEMPLATE_VARIABLES, type TemplatePurpose } from "@pulseos/types";

const VAR = /\{\{\s*([a-z_]+)\s*\}\}/g;

export function variablesUsed(body: string): string[] {
  return [...new Set([...body.matchAll(VAR)].map((m) => m[1]!))];
}

/** A body may only use the variables its purpose declares; anything else is a typo or an injection attempt. */
export function validateTemplateBody(purpose: TemplatePurpose, body: string): { ok: true } | { ok: false; unknown: string[] } {
  const allowed = new Set(TEMPLATE_VARIABLES[purpose]);
  const unknown = variablesUsed(body).filter((v) => !allowed.has(v));
  return unknown.length === 0 ? { ok: true } : { ok: false, unknown };
}

/** Fill the body. A variable with no value is reported (and left visible as {{name}}) — a message is never sent with a hole in it. */
export function renderTemplate(body: string, values: Record<string, string | null | undefined>): { text: string; missing: string[] } {
  const missing: string[] = [];
  const text = body.replace(VAR, (whole, name: string) => {
    const v = values[name];
    if (v === undefined || v === null || v === "") {
      if (!missing.includes(name)) missing.push(name);
      return whole;
    }
    return v;
  });
  return { text, missing };
}

/** Provider templates take positional parameters: the used variables, in order of first use. */
export function templateParameters(body: string, values: Record<string, string | null | undefined>): string[] {
  return variablesUsed(body).map((v) => String(values[v] ?? ""));
}

export const DEFAULT_TEMPLATES: { purpose: TemplatePurpose; name: string; providerTemplateName: string; body: string }[] = [
  { purpose: "APPOINTMENT_CONFIRMATION", name: "Appointment confirmation", providerTemplateName: "appointment_confirmation", body: "Hello {{patient_name}}, your appointment with {{doctor_name}} at {{hospital_name}} ({{branch_name}}) is confirmed for {{date}} at {{time}}." },
  { purpose: "APPOINTMENT_REMINDER", name: "Appointment reminder", providerTemplateName: "appointment_reminder", body: "Hello {{patient_name}}, a reminder of your appointment with {{doctor_name}} at {{hospital_name}} ({{branch_name}}) on {{date}} at {{time}}." },
  { purpose: "SURGERY_REMINDER", name: "Surgery reminder", providerTemplateName: "surgery_reminder", body: "Hello {{patient_name}}, a reminder of your {{procedure}} at {{hospital_name}} ({{branch_name}}) on {{date}} at {{time}}." },
  { purpose: "FOLLOW_UP_MESSAGE", name: "Follow-up message", providerTemplateName: "follow_up_message", body: "Hello {{patient_name}}, this is {{staff_name}} from {{hospital_name}}. We are following up on your recent enquiry — please reply to this message or call us." },
];
