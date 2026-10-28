// What the Website Leads "API details" dialog shows. Everything here mirrors the real intake endpoint
// (apps/api/src/domain/acquisition/website-form.routes.ts): only supported fields, only the responses it really sends, and the
// intake token appears only as an environment-variable placeholder, never as a literal value.

export interface ApiField {
  name: string;
  required: boolean;
  type: string;
  note: string;
}

export const API_FIELDS: ApiField[] = [
  { name: "submissionId", required: true, type: "string ≤ 100", note: "Unique per real submission. Send the SAME value when retrying, so a retry is accepted once." },
  { name: "formId", required: true, type: "string ≤ 100", note: "Names the form for attribution. It is a label, not a security boundary: the token is." },
  { name: "name", required: true, type: "string ≤ 120", note: "The enquirer's name." },
  { name: "phone", required: true, type: "string ≤ 20", note: "A valid phone number. International format (+91…) is safest; a number that cannot be normalised is refused." },
  { name: "email", required: false, type: "email ≤ 254", note: "Optional." },
  { name: "service", required: false, type: "string ≤ 120", note: "e.g. Cataract consultation. Required when \"Require service\" is on." },
  { name: "referralCode", required: false, type: "string ≤ 40", note: "Shown on the patient's website-enquiry timeline entry." },
  { name: "message", required: false, type: "string ≤ 1000", note: "Shown on the patient's timeline entry." },
  { name: "language", required: false, type: "string ≤ 40", note: "Optional." },
  { name: "branchId", required: false, type: "UUID", note: "Optional PulseOS branch id." },
  { name: "pageUrl", required: false, type: "string ≤ 500", note: "The page the form was on." },
  { name: "utm", required: false, type: "object", note: "source, medium, campaign, content, term (each ≤ 200). Used for attribution." },
  { name: "clickIds", required: false, type: "object", note: "gclid, gbraid, wbraid, fbclid (each ≤ 200)." },
];

export interface ApiResponse {
  status: number;
  meaning: string;
}

export const RESPONSES: ApiResponse[] = [
  { status: 200, meaning: "Accepted. { ok: true, duplicate: false, deduped: boolean }. duplicate: true means this submissionId was already received; deduped: true means it was added to the patient's open journey." },
  { status: 401, meaning: "The token is missing or wrong (the same answer for both). { error: \"unauthorized\" }" },
  { status: 403, meaning: "Website intake is switched off, or no intake token has been created yet (it stays closed until one exists), or a browser Origin that is not in the allowed list. { error: \"connector_disabled\" | \"origin_not_allowed\" }" },
  { status: 404, meaning: "The address is not a Website Leads intake address. { error: \"not_found\" }" },
  { status: 422, meaning: "A field is missing, too long, or the phone is not valid. { error: \"invalid_request\" } Do not retry unchanged." },
  { status: 429, meaning: "Too many requests from this address. Wait the number of seconds in the Retry-After header, then retry with the same submissionId." },
  { status: 500, meaning: "PulseOS could not process it. { error: \"processing_failed\" } Safe to retry with the same submissionId." },
];

export interface SamplePayload {
  submissionId: string;
  formId: string;
  name: string;
  phone: string;
  email: string;
  service: string;
  referralCode: string;
  message: string;
  language: string;
  pageUrl: string;
  utm: { source: string; medium: string; campaign: string; content: string; term: string };
  clickIds: { gclid: string | null; gbraid: string | null; wbraid: string | null; fbclid: string | null };
}

export function samplePayload(formId: string): SamplePayload {
  return {
    submissionId: "unique-submission-001",
    formId,
    name: "Asha Sharma",
    phone: "+919876543210",
    email: "asha@example.com",
    service: "Cataract consultation",
    referralCode: "REFERRAL10",
    message: "Please call after 5 pm",
    language: "English",
    pageUrl: "https://clinic.example/contact",
    utm: { source: "google", medium: "cpc", campaign: "cataract-search", content: "ad-a", term: "cataract surgery" },
    clickIds: { gclid: null, gbraid: null, wbraid: null, fbclid: null },
  };
}

export const sampleJson = (formId: string) => JSON.stringify(samplePayload(formId), null, 2);

export function curlExample(url: string, formId: string): string {
  const body = JSON.stringify(samplePayload(formId)).replace(/'/g, "'\\''");
  return [`curl -X POST '${url}' \\`, `  -H 'Content-Type: application/json' \\`, `  -H "X-PulseOS-Intake-Token: $PULSEOS_INTAKE_TOKEN" \\`, `  -d '${body}'`].join("\n");
}

/** Illustrative call site for the website's own server. Not a complete retry or timeout policy. */
export function nodeExample(formId: string): string {
  return `// Runs on YOUR website's server, never in page JavaScript.
const response = await fetch(process.env.PULSEOS_WEBSITE_INTAKE_URL, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-PulseOS-Intake-Token": process.env.PULSEOS_INTAKE_TOKEN,
  },
  body: JSON.stringify({
    submissionId: lead.submissionId, // generate once per real submission; reuse it on every retry
    formId: "${formId}",
    name: lead.name,
    phone: lead.phone,
    email: lead.email,
    service: lead.service,
    referralCode: lead.referralCode,
    message: lead.message,
    pageUrl: lead.pageUrl,
    utm: lead.utm,
    clickIds: lead.clickIds,
  }),
  signal: AbortSignal.timeout(10_000),
});
// 200: done. 422: fix the data, do not retry. 429/5xx/network error: retry later with the same submissionId.`;
}

/** One origin per line (or comma separated) to a list. The server validates and normalises each entry. */
export function originsFromText(text: string): string[] {
  const out: string[] = [];
  for (const part of text.split(/[\n,]/)) {
    const v = part.trim();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

export const originsToText = (origins: string[]) => origins.join("\n");

/** An address a hospital's website cannot reach from the internet. */
export function isLocalUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost");
  } catch {
    return false;
  }
}
