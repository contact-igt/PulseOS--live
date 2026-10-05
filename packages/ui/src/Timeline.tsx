"use client";

import { useMemo, useState, type ReactNode } from "react";
import { CalendarCheck, IndianRupee, ListChecks, MessageCircle, Phone, Stethoscope, UserCog, Circle, type LucideIcon } from "lucide-react";
import { Badge, Card, EmptyState, Tabs, type TabItem } from "./primitives";
import { fmtDate, fmtTime, hospitalDaysAgo, isSameHospitalDay } from "./format";
import { INTERACTION_CHANNEL_LABEL, type TimelineEventVm } from "@pulseos/types";

export type { TimelineEventVm };

type Category = TimelineEventVm["category"];

/** "Today" / "Yesterday" / "16 Sept" — the day-group header text, in hospital days. */
function dayHeaderLabel(iso: string): string {
  const diffDays = hospitalDaysAgo(iso);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return fmtDate(iso);
}

/** Same hospital calendar day — not a raw ISO-string prefix compare and not the browser's day. */
const isSameDay = isSameHospitalDay;

const CATEGORY_LABEL: Record<Category, string> = {
  communication: "Communication",
  appointments: "Appointments",
  clinical: "Consultation & treatment",
  tasks: "Tasks & assignment",
  other: "Other",
};

// Restrained icon per category (blue/white/neutral only; the label and the
// icon carry the meaning, never colour alone), with a few event-type
// overrides where a more specific glyph reads faster than the category's.
const CATEGORY_ICON: Record<Category, LucideIcon> = {
  communication: MessageCircle,
  appointments: CalendarCheck,
  clinical: Stethoscope,
  tasks: ListChecks,
  other: Circle,
};

const EVENT_TYPE_ICON: Record<string, LucideIcon> = {
  call_logged: Phone,
  revenue_recorded: IndianRupee,
  journey_owner_changed: UserCog,
};

const CATEGORY_DOT: Record<Category, string> = {
  communication: "bg-primary-100 text-primary-700",
  appointments: "bg-primary-600 text-white",
  clinical: "bg-primary-50 text-primary-700 ring-1 ring-inset ring-primary-200",
  tasks: "bg-neutral-100 text-neutral-600",
  other: "bg-neutral-100 text-neutral-500",
};

const CATEGORY_CHIP_TONE: Record<Category, "primary" | "neutral"> = {
  communication: "primary",
  appointments: "primary",
  clinical: "primary",
  tasks: "neutral",
  other: "neutral",
};

const FILTERS: { key: "all" | Category; label: string }[] = [
  { key: "all", label: "All" },
  { key: "communication", label: "Communication" },
  { key: "appointments", label: "Appointments" },
  { key: "clinical", label: "Consultation & treatment" },
  { key: "tasks", label: "Tasks & assignment" },
];

interface DayGroup {
  key: string;
  label: string;
  events: TimelineEventVm[];
}

function groupByDay(events: TimelineEventVm[]): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const event of events) {
    const last = groups[groups.length - 1];
    if (last && isSameDay(last.events[0].occurredAt, event.occurredAt)) last.events.push(event);
    else groups.push({ key: event.id, label: dayHeaderLabel(event.occurredAt), events: [event] });
  }
  return groups;
}

/**
 * Patient / journey timeline: day-grouped, filterable by category, readable at
 * 390px (titles and descriptions wrap, the time never squeezes the title).
 * `order` defaults to the API's chronological order; pass "desc" for a
 * newest-first feed. Props are additive-only: Journey Detail consumes this too.
 */
export function Timeline({ events, order = "asc", className = "", renderEventDetail }: { events: TimelineEventVm[]; order?: "asc" | "desc"; className?: string; /** Extra body under an event (the app renders a call card for call events). */ renderEventDetail?: (event: TimelineEventVm) => ReactNode }) {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["key"]>("all");

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: events.length };
    for (const e of events) c[e.category] = (c[e.category] ?? 0) + 1;
    return c;
  }, [events]);

  const visible = useMemo(() => {
    const filtered = filter === "all" ? events : events.filter((e) => e.category === filter);
    return order === "desc" ? [...filtered].sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt)) : filtered;
  }, [events, filter, order]);
  const groups = useMemo(() => groupByDay(visible), [visible]);

  // A category with no events yet is hidden rather than offered as an empty tab.
  const tabs: TabItem[] = FILTERS.filter((f) => f.key === "all" || (counts[f.key] ?? 0) > 0).map((f) => ({ key: f.key, label: f.label, count: counts[f.key] ?? 0 }));

  return (
    <Card className={`overflow-hidden ${className}`} data-testid="timeline">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-line px-4 py-3">
        <div className="flex items-baseline gap-2">
          <h2 className="text-sm font-semibold tracking-tight text-ink">Timeline</h2>
          <span className="text-xs text-ink-2">{visible.length} events</span>
        </div>
        {events.length > 0 && <Tabs items={tabs} value={filter} onChange={(k) => setFilter(k as typeof filter)} ariaLabel="Filter timeline" />}
      </div>
      {visible.length === 0 ? (
        <EmptyState message="No timeline events yet" hint={filter === "all" ? "Calls, messages, appointments and treatment updates appear here as they happen." : undefined} />
      ) : (
        <div className="px-4 pb-4 pt-3">
          {groups.map((group) => (
            <section key={group.key} className="mb-4 last:mb-0">
              <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-2">{group.label}</h3>
              <ol className="relative space-y-3.5 border-l border-line pl-7">
                {group.events.map((event) => {
                  const Icon = EVENT_TYPE_ICON[event.eventType] ?? CATEGORY_ICON[event.category];
                  return (
                    <li key={event.id} className="relative" data-testid="timeline-event">
                      <span className={`absolute -left-[38px] top-0 flex h-6 w-6 items-center justify-center rounded-full border-2 border-white ${CATEGORY_DOT[event.category]}`}>
                        <Icon size={12} strokeWidth={2} aria-hidden="true" />
                      </span>
                      <div className="flex items-start justify-between gap-x-3">
                        <span className="min-w-0 break-words text-sm font-medium leading-5 text-ink">{event.title}</span>
                        <span className="shrink-0 pt-0.5 text-[11px] tabular-nums text-ink-2">{fmtTime(event.occurredAt)}</span>
                      </div>
                      {event.description && <p className="mt-0.5 break-words text-xs leading-5 text-ink-2">{event.description}</p>}
                      {renderEventDetail?.(event)}
                      <span className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-ink-2">
                        <Badge tone={CATEGORY_CHIP_TONE[event.category]}>{CATEGORY_LABEL[event.category]}</Badge>
                        {/* How it happened (the channel), and which hospital line a call/WhatsApp message came in on. A lead's source is shown only where no channel is recorded. */}
                        {(event.channel || event.sourceChannel || event.endpointLabel) && (
                          <span className="min-w-0 break-words" data-testid="timeline-channel">
                            {[event.channel ? INTERACTION_CHANNEL_LABEL[event.channel] : event.sourceChannel, event.endpointLabel].filter(Boolean).join(" · ")}
                          </span>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ol>
            </section>
          ))}
        </div>
      )}
    </Card>
  );
}
