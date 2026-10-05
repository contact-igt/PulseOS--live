"use client";

import Link from "next/link";
import { CalendarClock, ListChecks, Stethoscope } from "lucide-react";
import { APPOINTMENT_STATUS_LABEL, Badge, EmptyState, TREATMENT_STATUS_LABEL, addDays, formatKey, localDayKey } from "@pulseos/ui";
import type { AppointmentStatus, PatientUpcomingItem, Role, TaskType, TreatmentStatus } from "@pulseos/types";
import { pathAllowedForRole } from "@/components/shell/nav";
import { withFrom } from "@/components/shell/BackLink";
import { groupUpcoming } from "./upcoming";

const TASK_LABEL: Record<TaskType, string> = {
  CALLBACK: "Callback",
  FOLLOW_UP: "Follow-up",
  APPOINTMENT_CONFIRMATION: "Appointment confirmation",
  NO_SHOW_RECOVERY: "No-show recovery",
  TREATMENT_DECISION: "Treatment decision",
  POST_CARE: "Post-care",
  RECALL: "Recall",
  OTHER: "Next Action",
};

const KIND_ICON = { appointment: CalendarClock, task: ListChecks, treatment: Stethoscope } as const;

const timeFmt = new Map<string, Intl.DateTimeFormat>();
function timeIn(iso: string, timeZone: string) {
  let f = timeFmt.get(timeZone);
  if (!f) timeFmt.set(timeZone, (f = new Intl.DateTimeFormat("en-IN", { timeZone, hour: "numeric", minute: "2-digit", hour12: true })));
  return f.format(new Date(iso));
}

function title(item: PatientUpcomingItem): string {
  if (item.kind === "appointment") return item.label ? `Appointment · ${item.label}` : "Appointment";
  if (item.kind === "task") return `Next Action · ${TASK_LABEL[item.label as TaskType] ?? "Task"}`;
  return `Treatment · ${item.label ?? "Scheduled"}`;
}

function statusText(item: PatientUpcomingItem): string {
  if (item.overdue) return "Overdue";
  if (item.kind === "appointment") return APPOINTMENT_STATUS_LABEL[item.status as AppointmentStatus] ?? item.status;
  if (item.kind === "treatment") return TREATMENT_STATUS_LABEL[item.status as TreatmentStatus] ?? item.status;
  return item.status === "in_progress" ? "In progress" : "Open";
}

/** Where an item's entity lives: its journey page (which lists its tasks, appointments and treatments), else the item's own workspace. */
function hrefFor(item: PatientUpcomingItem, role: Role | undefined): string | null {
  if (!role) return null;
  if (item.journeyId && pathAllowedForRole(role, "/journeys")) return withFrom(`/journeys/${item.journeyId}`, "patients");
  const fallback = item.kind === "appointment" ? "/appointments" : item.kind === "task" ? "/my-work" : "/treatments";
  return pathAllowedForRole(role, fallback) ? fallback : null;
}

/**
 * Patient 360 "Upcoming": the patient's future appointments, open tasks and
 * scheduled treatments - existing records only - grouped by hospital-local day.
 */
export function PatientUpcomingList({
  items,
  timeZone,
  journeyId,
  showJourney,
  role,
  now,
}: {
  items: PatientUpcomingItem[];
  timeZone: string;
  /** Selected journey (Patient 360 journey selector); undefined = all journeys. */
  journeyId?: string;
  /** True when the patient has more than one journey: every item then names its journey. */
  showJourney: boolean;
  role: Role | undefined;
  now: Date;
}) {
  const groups = groupUpcoming(items, timeZone, journeyId);
  const today = localDayKey(now, timeZone);
  const tomorrow = addDays(today, 1);

  if (groups.length === 0) {
    return (
      <div className="rounded-card border border-line bg-surface" data-testid="patient-upcoming">
        <EmptyState message="Nothing upcoming" hint="No future appointments, open Next Actions or scheduled treatments for this patient." />
      </div>
    );
  }

  return (
    <div className="space-y-3" data-testid="patient-upcoming">
      {groups.map((g) => {
        const heading = g.key === "overdue" ? "Overdue" : `${formatKey(g.key, { weekday: "short", day: "numeric", month: "short" })}${g.key === today ? " · Today" : g.key === tomorrow ? " · Tomorrow" : ""}`;
        return (
          <section key={g.key} aria-label={`${heading}, ${g.items.length} ${g.items.length === 1 ? "item" : "items"}`} className="overflow-hidden rounded-card border border-line bg-surface" data-testid={`upcoming-day-${g.key}`}>
            <h3 className={`border-b border-line px-4 py-2 text-xs font-semibold ${g.key === "overdue" ? "bg-warning-100/60 text-warning-700" : "bg-surface-muted text-ink"}`}>{heading}</h3>
            <ul className="divide-y divide-line">
              {g.items.map((item) => {
                const Icon = KIND_ICON[item.kind];
                const href = hrefFor(item, role);
                const name = title(item);
                return (
                  <li key={`${item.kind}-${item.id}`} className="flex items-start gap-3 px-4 py-2.5" data-testid={`upcoming-item-${item.id}`} data-kind={item.kind}>
                    <span className="w-16 shrink-0 pt-0.5 text-xs font-medium tabular-nums text-ink-2">{g.key === "overdue" ? formatKey(localDayKey(item.at, timeZone), { day: "numeric", month: "short" }) : timeIn(item.at, timeZone)}</span>
                    <Icon size={15} aria-hidden="true" className="mt-0.5 shrink-0 text-primary-600" />
                    <div className="min-w-0 flex-1">
                      {href ? (
                        <Link href={href} className="block break-words text-sm font-medium text-ink hover:text-primary-700 hover:underline">
                          {name}
                        </Link>
                      ) : (
                        <span className="block break-words text-sm font-medium text-ink">{name}</span>
                      )}
                      <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-2">
                        {showJourney && <span className="rounded-chip bg-primary-50 px-1.5 py-0.5 font-medium text-primary-800">{item.journeyType ?? "No journey"}</span>}
                        {item.personName && <span>{item.personName}</span>}
                      </p>
                    </div>
                    <Badge tone={item.overdue ? "warning" : "neutral"}>{statusText(item)}</Badge>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
