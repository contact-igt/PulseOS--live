import { LEAD_VIEWS, REPORT_RANGES, type LeadStatus, type LeadView, type LeadsWorkspaceQuery, type ReportRange } from "@pulseos/types";
import { isRealDate } from "@/components/report/reportFilters";

// The Leads workspace's filters live in the URL (?view=&range=&from=&to=&owner=&source=&service=&status=&due=), so
// refresh, back/forward and shared links restore exactly the same list. Anything malformed falls back to "no filter"
// instead of breaking the page; the server validates again.

export const DEFAULT_LEAD_VIEW: LeadView = "all";

/** Presets offered on Leads. A range is measured against the date context the active view states. */
export const LEAD_RANGES: { key: ReportRange; label: string }[] = REPORT_RANGES;
const RANGES = new Set<string>(LEAD_RANGES.map((r) => r.key));
const VIEWS = new Set<string>(LEAD_VIEWS.map((v) => v.key));
const STATUSES = new Set<string>(["new", "uncontacted", "follow_up_due", "appointment_booked", "no_response", "converted", "lost"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const KEYS = ["view", "range", "from", "to", "owner", "source", "service", "status", "due", "q", "field", "fv", "page"] as const;

export interface LeadFilters {
  view: LeadView;
  range: ReportRange | undefined;
  from: string | undefined;
  to: string | undefined;
  owner: string;
  source: string;
  service: string;
  status: LeadStatus | undefined;
  due: "overdue" | undefined;
  /** Name / phone search over the loaded list. */
  q: string;
  /** A CRM field the hospital marked filterable, and the answer chosen. */
  fieldKey: string;
  fieldValue: string;
}

/** URL → a valid set of filters. */
export function readLeadFilters(get: (key: string) => string, _today: string): LeadFilters {
  const rawView = get("view");
  const view = (VIEWS.has(rawView) ? rawView : DEFAULT_LEAD_VIEW) as LeadView;
  const rawRange = get("range");
  let range = (RANGES.has(rawRange) ? rawRange : undefined) as ReportRange | undefined;
  const from = get("from");
  const to = get("to");
  if (range === "custom" && !(isRealDate(from) && isRealDate(to) && from <= to)) range = undefined;
  const rawOwner = get("owner");
  const owner = rawOwner === "mine" || rawOwner === "unassigned" || UUID.test(rawOwner) ? rawOwner : "";
  const rawStatus = get("status");
  return {
    view,
    range,
    from: range === "custom" ? from : undefined,
    to: range === "custom" ? to : undefined,
    owner,
    source: get("source").slice(0, 60),
    service: get("service").slice(0, 120),
    status: STATUSES.has(rawStatus) ? (rawStatus as LeadStatus) : undefined,
    due: view === "follow_up_due" && get("due") === "overdue" ? "overdue" : undefined,
    q: get("q").trim().slice(0, 80),
    // The field alone is a valid state (it was just chosen; the answer comes next); the API only gets both.
    fieldKey: /^[a-z][a-z0-9_]{1,47}$/.test(get("field")) ? get("field") : "",
    fieldValue: /^[a-z][a-z0-9_]{1,47}$/.test(get("field")) ? get("fv").slice(0, 80) : "",
  };
}

/** A filter change → the URL patch (undefined clears a key). */
export function leadFilterPatch(patch: Partial<LeadFilters>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  if ("view" in patch) {
    out.view = patch.view && patch.view !== DEFAULT_LEAD_VIEW ? patch.view : undefined;
    // The overdue refinement belongs to Follow-up Due only.
    if (patch.view !== "follow_up_due") out.due = undefined;
  }
  if ("due" in patch) out.due = patch.due || undefined;
  if ("range" in patch) {
    out.range = patch.range || undefined;
    if (patch.range !== "custom") Object.assign(out, { from: undefined, to: undefined });
  }
  if (patch.range === "custom" || (patch.range === undefined && !("range" in patch))) {
    if ("from" in patch) out.from = patch.from || undefined;
    if ("to" in patch) out.to = patch.to || undefined;
  }
  for (const k of ["owner", "source", "service", "status"] as const) if (k in patch) out[k] = (patch[k] as string | undefined) || undefined;
  if ("q" in patch) out.q = patch.q?.trim() || undefined;
  if ("fieldKey" in patch || "fieldValue" in patch) {
    out.field = patch.fieldKey || undefined;
    out.fv = patch.fieldKey ? patch.fieldValue || undefined : undefined;
  }
  // Any change to what is listed starts again at the first page.
  out.page = undefined;
  return out;
}

/** Clears every Leads filter (and only Leads' own keys). */
export function resetLeadPatch(): Record<string, undefined> {
  return Object.fromEntries(KEYS.map((k) => [k, undefined]));
}

export function isDefaultLeadFilters(f: LeadFilters): boolean {
  return f.view === DEFAULT_LEAD_VIEW && !f.range && !f.owner && !f.source && !f.service && !f.status && !f.due && !f.q && !f.fieldKey;
}

export function toWorkspaceQuery(f: LeadFilters): LeadsWorkspaceQuery {
  return {
    ...(f.view !== DEFAULT_LEAD_VIEW ? { view: f.view } : {}),
    ...(f.range ? { range: f.range } : {}),
    ...(f.range === "custom" ? { from: f.from, to: f.to } : {}),
    ...(f.owner ? { owner: f.owner } : {}),
    ...(f.source ? { source: f.source } : {}),
    ...(f.service ? { service: f.service } : {}),
    ...(f.status ? { status: f.status } : {}),
    ...(f.due ? { due: f.due } : {}),
    ...(f.fieldKey && f.fieldValue ? { fieldKey: f.fieldKey, fieldValue: f.fieldValue } : {}),
  };
}

export interface LeadChip {
  key: "due" | "owner" | "source" | "service" | "status" | "q" | "field";
  label: string;
}

const STATUS_WORDS: Record<LeadStatus, string> = { new: "New", uncontacted: "Uncontacted", follow_up_due: "Follow-up due", appointment_booked: "Appointment booked", no_response: "No response", converted: "Converted", lost: "Lost" };

/** Plain-words chips for every narrowing filter that is set (the view and date have their own controls). */
export function activeLeadChips(f: LeadFilters, o: { sources: { key: string; label: string }[]; owners: { id: string; name: string }[]; fields?: { key: string; label: string }[] }): LeadChip[] {
  const chips: LeadChip[] = [];
  if (f.q) chips.push({ key: "q", label: `Search: ${f.q}` });
  if (f.fieldKey) chips.push({ key: "field", label: `${o.fields?.find((x) => x.key === f.fieldKey)?.label ?? f.fieldKey}: ${f.fieldValue === "true" ? "Yes" : f.fieldValue === "false" ? "No" : f.fieldValue}` });
  if (f.due) chips.push({ key: "due", label: "Overdue only" });
  if (f.owner) chips.push({ key: "owner", label: `Team Member: ${f.owner === "mine" ? "Mine" : f.owner === "unassigned" ? "Unassigned" : (o.owners.find((x) => x.id === f.owner)?.name ?? "…")}` });
  if (f.source) chips.push({ key: "source", label: `Source: ${o.sources.find((s) => s.key === f.source)?.label ?? f.source}` });
  if (f.service) chips.push({ key: "service", label: `Service: ${f.service}` });
  if (f.status) chips.push({ key: "status", label: `Status: ${STATUS_WORDS[f.status]}` });
  return chips;
}
