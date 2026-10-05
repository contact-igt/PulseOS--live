import type { LeadRow } from "@pulseos/types";

// Pure helpers for the Leads list: search, paging and the saved column choice. The server decides WHICH leads match the
// filters; these only shape how the loaded list is shown, so none of it can change a number the filters produced.

/** Name or phone, as typed: letters match the name, digits match the phone (spaces and dashes ignored). */
export function searchLeads(rows: LeadRow[], q: string): LeadRow[] {
  const text = q.trim().toLowerCase();
  if (!text) return rows;
  const digits = text.replace(/\D/g, "");
  return rows.filter((r) => r.patientName.toLowerCase().includes(text) || (digits.length >= 3 && r.phone.replace(/\D/g, "").includes(digits)));
}

export const PAGE_SIZES = [25, 50, 100] as const;
export type PageSize = (typeof PAGE_SIZES)[number];
export const DEFAULT_PAGE_SIZE: PageSize = 50;

export function readPageSize(raw: string | null | undefined): PageSize {
  const n = Number(raw);
  return (PAGE_SIZES as readonly number[]).includes(n) ? (n as PageSize) : DEFAULT_PAGE_SIZE;
}

export interface Page<T> {
  rows: T[];
  total: number;
  page: number;
  pages: number;
  /** 1-based, for "Showing 26–50 of 143"; 0 when empty. */
  from: number;
  to: number;
}

/** A page number that is out of range (a stale link after filtering) is clamped, never an empty screen. */
export function paginate<T>(rows: T[], page: number, size: number): Page<T> {
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / size));
  const p = Math.min(Math.max(1, Math.floor(page) || 1), pages);
  const start = (p - 1) * size;
  const slice = rows.slice(start, start + size);
  return { rows: slice, total, page: p, pages, from: total === 0 ? 0 : start + 1, to: start + slice.length };
}

export type LeadColumn = "enquiry" | "source" | "status" | "outcome" | "owner" | "created" | "appointment" | "lastInteraction" | "nextAction";

/** Patient (with phone) is always shown; everything else can be hidden. This is a VIEW choice only. */
export const LEAD_COLUMNS: { key: LeadColumn; label: string }[] = [
  { key: "enquiry", label: "Enquiry / Service" },
  { key: "source", label: "Original source" },
  { key: "status", label: "Journey status" },
  { key: "outcome", label: "Outcome" },
  { key: "owner", label: "Team Member" },
  { key: "created", label: "Created" },
  { key: "appointment", label: "Appointment" },
  { key: "lastInteraction", label: "Last interaction" },
  { key: "nextAction", label: "Next action" },
];
export const DEFAULT_COLUMNS: LeadColumn[] = ["enquiry", "source", "status", "outcome", "owner", "created", "appointment", "lastInteraction", "nextAction"];

/** What was saved, made safe: unknown keys dropped, never empty (a table with no columns is a broken table). */
export function parseColumnPref(raw: string | null | undefined): LeadColumn[] {
  try {
    const parsed = JSON.parse(raw ?? "null") as unknown;
    if (!Array.isArray(parsed)) return DEFAULT_COLUMNS;
    const known = new Set<string>(LEAD_COLUMNS.map((c) => c.key));
    const picked = parsed.filter((k): k is LeadColumn => typeof k === "string" && known.has(k));
    return picked.length > 0 ? picked : DEFAULT_COLUMNS;
  } catch {
    return DEFAULT_COLUMNS;
  }
}

const prefKey = (userId: string) => `pulseos.leads.columns.v1:${userId}`;

/** Per-person, per-browser view preference. Storage can be blocked or empty: then the defaults apply. */
export function loadColumnPref(userId: string): LeadColumn[] {
  try {
    return parseColumnPref(window.localStorage.getItem(prefKey(userId)));
  } catch {
    return DEFAULT_COLUMNS;
  }
}
export function saveColumnPref(userId: string, columns: LeadColumn[]): void {
  try {
    window.localStorage.setItem(prefKey(userId), JSON.stringify(columns));
  } catch {
    /* a view preference is a convenience, never a requirement */
  }
}
