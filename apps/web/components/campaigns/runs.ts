import { addDays, diffDays, formatKey, localDayKey, shiftDate } from "@pulseos/ui";
import type { CalendarEvent, DayKey, GanttItem } from "@pulseos/ui";
import type { CampaignFilters, CampaignRunStatus, CampaignViewRow, SourceChannel } from "@pulseos/types";

export const CAMPAIGN_VIEWS = ["table", "calendar", "timeline"] as const;
export type CampaignView = (typeof CAMPAIGN_VIEWS)[number];

export const SOURCE_OPTIONS: SourceChannel[] = ["meta", "google", "website", "whatsapp", "phone", "walk_in", "referral", "organic", "other"];
export const SOURCE_LABEL: Record<SourceChannel, string> = { meta: "Meta", google: "Google", website: "Website", whatsapp: "WhatsApp", phone: "Phone", walk_in: "Walk-in", referral: "Referral", organic: "Organic", other: "Other" };

const RUN_STATUS_LABEL: Record<CampaignRunStatus, string> = { active: "Active", paused: "Paused", ended: "Ended" };

/** A null end date means the campaign is still running. We never invent one. */
export function isOngoing(row: CampaignViewRow): boolean {
  return row.endDate === null;
}

/** "Ongoing" wins over the stored status whenever there is no end date; otherwise the stored status. */
export function runStatusLabel(row: CampaignViewRow): string {
  if (isOngoing(row)) return row.campaignStatus === "paused" ? "Paused · Ongoing" : "Ongoing";
  return RUN_STATUS_LABEL[row.campaignStatus];
}

function dayLabel(iso: string, timeZone: string): string {
  return formatKey(localDayKey(iso, timeZone), { day: "numeric", month: "short", year: "numeric" });
}

/** "30 Aug 2026 – Ongoing" / "1 Jul 2026 – 31 Jul 2026", in hospital days. */
export function runLabel(row: CampaignViewRow, timeZone: string): string {
  return `${dayLabel(row.startDate, timeZone)} – ${row.endDate ? dayLabel(row.endDate, timeZone) : "Ongoing"}`;
}

export function campaignCalendarEvents(rows: CampaignViewRow[], timeZone: string): CalendarEvent<CampaignViewRow>[] {
  return rows.map((r) => ({
    id: r.campaignId,
    start: r.startDate,
    // Ongoing: a point on its start day, labelled Ongoing — never a made-up end.
    end: r.endDate,
    title: r.campaignName,
    subtitle: `${SOURCE_LABEL[r.source] ?? r.source} · ${runLabel(r, timeZone)}`,
    status: runStatusLabel(r),
    state: r.endDate ? ("completed" as const) : ("default" as const),
    tone: r.endDate ? ("neutral" as const) : ("primary" as const),
    ariaLabel: `${r.campaignName}, ${SOURCE_LABEL[r.source] ?? r.source}, runs ${runLabel(r, timeZone)}, ${runStatusLabel(r)}`,
    data: r,
  }));
}

export function campaignGanttItems(rows: CampaignViewRow[]): GanttItem<CampaignViewRow>[] {
  return rows.map((r) => ({
    id: r.campaignId,
    label: r.campaignName,
    sublabel: SOURCE_LABEL[r.source] ?? r.source,
    start: r.startDate,
    end: r.endDate,
    status: runStatusLabel(r),
    tone: r.endDate ? ("neutral" as const) : ("primary" as const),
    data: r,
  }));
}

/** Campaigns whose run overlaps the inclusive hospital-day range [from, to]. */
export function runningDuring(rows: CampaignViewRow[], from: DayKey, to: DayKey, timeZone: string): CampaignViewRow[] {
  return rows.filter((r) => {
    const start = localDayKey(r.startDate, timeZone);
    if (diffDays(start, to) < 0) return false; // starts after the range
    if (!r.endDate) return true;
    return diffDays(from, localDayKey(r.endDate, timeZone)) >= 0;
  });
}

/** Timeline shows the selected month with one month either side (week ticks). */
export function timelineWindow(date: DayKey): { rangeStart: DayKey; rangeEnd: DayKey } {
  const monthStart = `${date.slice(0, 7)}-01`;
  return { rangeStart: shiftDate(monthStart, "month", -1), rangeEnd: addDays(shiftDate(shiftDate(monthStart, "month", 1), "month", 1), -1) };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Campaign filters live in the URL: branch, specialty, source, from, to. */
export function readCampaignFilters(params: URLSearchParams): CampaignFilters {
  const f: CampaignFilters = {};
  const branch = params.get("branch");
  const specialty = params.get("specialty");
  const source = params.get("source");
  const from = params.get("from");
  const to = params.get("to");
  if (branch) f.branchId = branch;
  if (specialty) f.specialtyKey = specialty;
  if (source && (SOURCE_OPTIONS as string[]).includes(source)) f.source = source as SourceChannel;
  if (from && DATE_RE.test(from)) f.dateFrom = from;
  if (to && DATE_RE.test(to)) f.dateTo = to;
  return f;
}

export function campaignFilterPatch(patch: Partial<CampaignFilters>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  if ("branchId" in patch) out.branch = patch.branchId || undefined;
  if ("specialtyKey" in patch) out.specialty = patch.specialtyKey || undefined;
  if ("source" in patch) out.source = patch.source || undefined;
  if ("dateFrom" in patch) out.from = patch.dateFrom || undefined;
  if ("dateTo" in patch) out.to = patch.dateTo || undefined;
  return out;
}
