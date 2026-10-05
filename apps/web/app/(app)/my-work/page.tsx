"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@pulseos/api-client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Badge, Button, EmptyState, ErrorState, Panel, Skeleton, Tabs, Toolbar, TASK_REASON_LABEL, TASK_REASON_TONE, ViewSwitcher, fmtDateTime as fmtDate, localDayKey, urgencyLabel } from "@pulseos/ui";
import { CalendarDays, Columns3, List } from "lucide-react";
import { useQuickCreate } from "../../../components/shell/QuickCreateProvider";
import { withFrom } from "@/components/shell/BackLink";
import { DATE_PRESETS, hasPermission } from "@pulseos/types";
import type { TaskReason, TaskRow, TaskView } from "@pulseos/types";
import { pathAllowedForRole } from "@/components/shell/nav";
import { useViewState } from "@/lib/useViewState";
import { SOURCE_LABEL } from "@/components/my-work/labels";
import { useTaskActions } from "@/components/my-work/useTaskActions";
import { rescheduleTarget, type DueBucket } from "@/components/my-work/taskBuckets";
import { TaskBoard } from "@/components/my-work/TaskBoard";
import { TaskCalendar } from "@/components/my-work/TaskCalendar";
import { TaskDrawer } from "@/components/my-work/TaskDrawer";
import { LogOutcomeSheet } from "@/components/outcomes/LogOutcomeSheet";
import { useHospitalTimeZone } from "@/lib/useHospitalTimeZone";
import { useUrlFilters } from "@/lib/useUrlFilters";
import { PeriodControls } from "@/components/filters/PeriodControls";
import { periodPatch, readPeriod } from "@/components/filters/periodFilter";

const VIEWS = ["list", "board", "calendar"] as const;
type WorkView = (typeof VIEWS)[number];
const VIEW_OPTIONS = [
  { key: "list" as const, label: "List", icon: <List size={14} />, controls: "my-work-view-panel" },
  { key: "board" as const, label: "Board", icon: <Columns3 size={14} />, controls: "my-work-view-panel" },
  { key: "calendar" as const, label: "Calendar", icon: <CalendarDays size={14} />, controls: "my-work-view-panel" },
];
/** Used until the hospital's zone arrives (and if it can't be read); tenants default to it too. */
/** Current time, re-read every minute so due buckets roll over without a reload. */
function useMinuteClock(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

const TABS: { key: TaskView | "mine"; label: string }[] = [
  { key: "mine", label: "My Work" },
  { key: "today", label: "Today" },
  { key: "overdue", label: "Overdue" },
  { key: "upcoming", label: "Upcoming" },
  { key: "appointment_risk", label: "Appointment Risk" },
  { key: "unassigned", label: "Unassigned" },
  { key: "completed", label: "Completed" },
];

// Secondary filter row: WHY a task exists, layered on top of the date tabs
// above (which filter WHEN it's due) — the two AND together. "Follow-ups"
// folds three reasons together since they're all "needs a call" variants;
// `reasons: []` means "no reason filter", i.e. the default "All" pill.
// Never label the new_lead group "New Leads" in user-facing copy — CLAUDE.md
// reserves "Lead" for technical/admin contexts; "enquiry" is the north-star
// term for a brand-new, not-yet-contacted patient touchpoint.
const REASON_GROUPS: { key: string; label: string; reasons: TaskReason[] }[] = [
  { key: "all", label: "All", reasons: [] },
  { key: "new_lead", label: "New Enquiries", reasons: ["new_lead"] },
  { key: "follow_up", label: "Follow-ups", reasons: ["overdue_callback", "treatment_decision_pending", "high_intent_uncontacted"] },
  { key: "missed_follow_up", label: "Missed Calls", reasons: ["missed_follow_up"] },
  { key: "no_show", label: "No-Shows", reasons: ["no_show"] },
];

// One grid shared by the column-header row and every task row (xl and up) — the
// actions column is a fixed width so columns line up across rows;
// below xl each row reflows into a two-line card instead of a squeezed table.
const ROW_GRID = "xl:grid-cols-[minmax(0,1.3fr)_minmax(0,2fr)_minmax(0,1fr)_minmax(0,0.7fr)_minmax(0,1fr)_15rem]";


function isOverdue(task: TaskRow) {
  return task.status === "pending" && new Date(task.dueAt).getTime() < Date.now();
}

export default function MyWorkPage() {
  const quickCreate = useQuickCreate();
  // Queue tab and reason live in the URL beside view/date, so a refresh, a shared link or
  // back/forward restores the same dataset in the same view (defaults stay out of the URL).
  const urlFilters = useUrlFilters();
  type TabKey = (typeof TABS)[number]["key"];
  type ReasonKey = (typeof REASON_GROUPS)[number]["key"];
  const tab: TabKey = TABS.find((t) => t.key === urlFilters.get("tab"))?.key ?? "mine";
  const reasonKey: ReasonKey = REASON_GROUPS.find((g) => g.key === urlFilters.get("reason"))?.key ?? "all";
  const setTab = (k: TabKey) => urlFilters.set({ tab: k === "mine" ? undefined : k });
  const setReasonKey = (k: ReasonKey) => urlFilters.set({ reason: k === "all" ? undefined : k });
  // Follow-up type and priority narrow the SAME dataset the date tabs fetched (client-side, instant, in the URL).
  const typeFilter = urlFilters.get("type") ?? "";
  const highOnly = urlFilters.get("priority") === "high";
  const [noteDraft, setNoteDraft] = useState<Record<string, string>>({});

  const session = useQuery({ queryKey: ["session"], queryFn: api.session });
  const currentUserId = session.data?.user.id;
  // MANAGE_TASKS gates create/complete/reschedule/note server-side (Doctor
  // has only the weaker VIEW_TASKS) — mirrored here only to avoid showing
  // dead controls, never as the actual authorization boundary.
  const canManageTasks = !!session.data && hasPermission(session.data.user.role, "MANAGE_TASKS");
  // "Unassigned" is a team-attention queue (tenant-wide, owner-less system
  // tasks), not a personal view — gate it out of the visible tab list for a
  // VIEW_TASKS-only role (e.g. Doctor). The API independently enforces this
  // too (a non-MANAGE_TASKS caller's assignedTo is forced server-side, which
  // always yields an empty result for this view), so this is UI polish only,
  // never the authorization boundary.
  const visibleTabs = TABS.filter((t) => t.key !== "unassigned" || canManageTasks);
  // If session permissions load in without MANAGE_TASKS while "unassigned"
  // is still selected (e.g. stale tab state), fall back to "mine" for the
  // query itself — belt-and-suspenders alongside the server-side gate, which
  // is the real authorization boundary either way.
  const effectiveTab = tab === "unassigned" && !canManageTasks ? "mine" : tab;

  // Hospital timezone decides Today / Overdue / Upcoming and calendar days - never the browser's zone.
  const timeZone = useHospitalTimeZone();
  const now = useMinuteClock();
  const { view, setView, date, setDate, range, calendarMode, setCalendarMode } = useViewState<WorkView>({ views: VIEWS, defaultView: "list", timeZone });
  const canOpenJourney = !!session.data && pathAllowedForRole(session.data.user.role, "/journeys");

  // Completed is a history, so it covers a chosen window (default: last 7 days, by the day each task was completed in
  // the hospital's calendar). Overdue / Today / Upcoming are live buckets and never take one.
  const searchParams = useSearchParams();
  const periodOptions = { prefix: "c", defaultRange: "7d", presets: DATE_PRESETS, today: localDayKey(now, timeZone) } as const;
  const period = readPeriod(new URLSearchParams(searchParams.toString()), periodOptions);
  const completedWindow = { completedFrom: period.from, completedTo: period.to };
  const windowKey = effectiveTab === "completed" ? `${period.from}..${period.to}` : "";

  // ONE tasks query feeds List, Board and Calendar: a view is a presentation, never a different dataset.
  const tasksKey = ["tasks", effectiveTab, currentUserId, windowKey] as const;
  const actions = useTaskActions(tasksKey);
  const tasks = useQuery({
    queryKey: tasksKey,
    // "Unassigned" is tenant-wide by definition — never force it down to the
    // caller's own assignments the way every other tab does.
    queryFn: () =>
      api.tasks(
        effectiveTab === "mine"
          ? { assignedTo: currentUserId }
          : effectiveTab === "unassigned"
            ? { view: "unassigned" }
            : effectiveTab === "completed"
              ? { view: "completed", assignedTo: currentUserId, ...completedWindow }
              : { view: effectiveTab, assignedTo: currentUserId },
      ),
    enabled: !!currentUserId,
  });

  const counts = useQuery({
    queryKey: ["tasks", "counts", currentUserId, `${period.from}..${period.to}`],
    queryFn: () => api.taskCounts(completedWindow),
    enabled: !!currentUserId,
  });

  // Reason grouping is derived client-side from the already-fetched date-tab
  // list rather than a second round trip per pill — "My Work" queues are a
  // single telecaller's own tasks (small), and this keeps switching pills
  // instant with no extra loading state.
  const activeReasons = REASON_GROUPS.find((g) => g.key === reasonKey)?.reasons ?? [];
  const followUpTypes = useQuery({ queryKey: ["followup-types"], queryFn: () => api.followUpTypes(), staleTime: 60_000 });
  const selectedType = followUpTypes.data?.find((ty) => ty.key === typeFilter) ?? null;
  const byReason = tasks.data && activeReasons.length > 0 ? tasks.data.filter((t) => activeReasons.includes(t.reason)) : tasks.data;
  const visibleTasks = byReason?.filter((t) => (!selectedType || t.typeLabel === selectedType.label) && (!highOnly || t.priority === "high"));
  const reasonCounts: Record<string, number> = { all: tasks.data?.length ?? 0 };
  for (const group of REASON_GROUPS) {
    if (group.reasons.length === 0) continue;
    reasonCounts[group.key] = tasks.data?.filter((t) => group.reasons.includes(t.reason)).length ?? 0;
  }

  // Every action goes through its existing endpoint (useTaskActions): optimistic on the shared
  // query, reverted with an inline error when the server rejects it. Invalidation also refreshes
  // Command Centre's Attention/SLA queue ("dashboard"), as before.
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  async function act(task: TaskRow, run: () => Promise<TaskRow | null>) {
    setBusy((b) => ({ ...b, [task.id]: true }));
    const saved = await run();
    setBusy((b) => ({ ...b, [task.id]: false }));
    return saved;
  }
  const complete = (task: TaskRow) => act(task, () => actions.complete(task));
  const plusOneDay = (task: TaskRow) => act(task, () => actions.reschedule(task, new Date(Date.now() + 86_400_000).toISOString()));
  const assignToMe = (task: TaskRow) => (currentUserId ? act(task, () => actions.assignTo(task, currentUserId, session.data?.user.name ?? null)) : Promise.resolve(null));

  async function saveNote(task: TaskRow) {
    const notes = noteDraft[task.id];
    if (notes === undefined) return;
    const saved = await act(task, () => actions.addNote(task, notes));
    if (!saved) return;
    setNoteDraft((d) => {
      const next = { ...d };
      delete next[task.id];
      return next;
    });
  }

  /** Board moves map to real endpoints only: Today/Upcoming = reschedule, Done = complete. */
  function moveCard(task: TaskRow, to: DueBucket) {
    if (to === "done") return actions.moveStrict(() => api.completeTask(task.id));
    if (to === "today" || to === "upcoming") return actions.moveStrict(() => api.rescheduleTask(task.id, rescheduleTarget(task, to, new Date(), timeZone)));
    return Promise.reject(new Error("Tasks cannot be moved into Overdue."));
  }

  // Board card / calendar event -> the task's detail drawer. The last-seen copy is kept so the
  // drawer can show the result even when a refetch drops the task from the current tab.
  const [selected, setSelected] = useState<TaskRow | null>(null);
  // The task whose outcome is being logged (Log outcome closes it and can schedule the next follow-up).
  const [logging, setLogging] = useState<TaskRow | null>(null);
  const selectedTask = selected ? (tasks.data?.find((t) => t.id === selected.id) ?? selected) : null;
  async function drawerAction(run: (task: TaskRow) => Promise<TaskRow | null>) {
    if (!selectedTask) return;
    const saved = await run(selectedTask);
    if (saved) setSelected(saved);
  }

  // Tabs only takes a plain-text `count`, which has no test id; the label is
  // rendered as-is inside the tab button, so the count is passed as part of a
  // node to keep the long-standing `my-work-tab-count-*` test ids.
  const tabItems = visibleTabs.map((t) => ({
    key: t.key,
    label: (
      <>
        {t.label}
        {counts.data && (
          <span className="tabular-nums text-neutral-500" data-testid={`my-work-tab-count-${t.key}`}>
            {t.key === "appointment_risk" ? counts.data.appointmentRisk : counts.data[t.key]}
          </span>
        )}
      </>
    ) as unknown as string,
    testId: `my-work-tab-${t.key}`,
  }));

  return (
    <div className="mx-auto max-w-6xl space-y-3" data-testid="my-work-page">
      <Toolbar
        actions={
          canManageTasks && (
            <Button variant="primary" onClick={() => quickCreate.openAddTask()} data-testid="add-task-button">
              + Add Task
            </Button>
          )
        }
      >
        <Tabs items={tabItems} value={effectiveTab} onChange={(k) => setTab(k as TabKey)} ariaLabel="Work queue" />
      </Toolbar>

      <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter by reason">
        <span className="mr-1 text-[11px] font-semibold uppercase tracking-wide text-ink-2">Reason</span>
        {REASON_GROUPS.map((g) => {
          const active = reasonKey === g.key;
          return (
            <button
              key={g.key}
              type="button"
              aria-pressed={active}
              onClick={() => setReasonKey(g.key)}
              className={`inline-flex h-7 items-center gap-1.5 rounded-control border px-2.5 text-xs font-medium transition ${active ? "border-primary-300 bg-primary-50 text-primary-800" : "border-line bg-surface text-ink-2 hover:border-primary-200 hover:text-ink"}`}
              data-testid={`my-work-reason-${g.key}`}
            >
              {g.label}
              {tasks.data && (
                <span className="tabular-nums text-neutral-500" data-testid={`my-work-reason-count-${g.key}`}>
                  {reasonCounts[g.key]}
                </span>
              )}
            </button>
          );
        })}
      </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {effectiveTab === "completed" && (
            <PeriodControls
              presets={DATE_PRESETS}
              value={{ range: period.range, from: period.from, to: period.to }}
              today={periodOptions.today}
              maxSpanDays={366}
              onChange={(next) => urlFilters.set(periodPatch(next, periodOptions))}
              testIdPrefix="my-work-completed"
              label="Completed in"
            />
          )}
          <label className="sr-only" htmlFor="my-work-type-filter">Follow-up type</label>
          <select
            id="my-work-type-filter"
            value={selectedType ? selectedType.key : ""}
            onChange={(e) => urlFilters.set({ type: e.target.value || undefined })}
            className="h-11 rounded-control border border-line bg-surface px-2 text-xs text-ink outline-none focus:border-primary-500 sm:h-7"
            data-testid="my-work-type-filter"
          >
            <option value="">All types</option>
            {(followUpTypes.data ?? []).map((ty) => (
              <option key={ty.id} value={ty.key}>
                {ty.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            aria-pressed={highOnly}
            onClick={() => urlFilters.set({ priority: highOnly ? undefined : "high" })}
            className={`inline-flex h-11 items-center rounded-control border px-2.5 text-xs font-medium transition sm:h-7 ${highOnly ? "border-primary-300 bg-primary-50 text-primary-800" : "border-line bg-surface text-ink-2 hover:border-primary-200 hover:text-ink"}`}
            data-testid="my-work-priority-filter"
          >
            High priority
          </button>
        <ViewSwitcher ariaLabel="My Work view" value={view} onChange={setView} options={VIEW_OPTIONS} />
        </div>
      </div>

      <Panel padded={false}>
        <div id="my-work-view-panel" role="tabpanel" aria-label={VIEW_OPTIONS.find((o) => o.key === view)?.label} className="min-w-0">
        {(tasks.isLoading || session.isLoading) && <div className="space-y-2 p-4">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-14" />)}</div>}
        {tasks.isError && <div className="p-4"><ErrorState message="Could not load tasks." /></div>}
        {view === "list" && visibleTasks && visibleTasks.length === 0 && (
          <div className="p-6">
            <EmptyState
              message={effectiveTab === "appointment_risk" ? "No appointment risks" : "You're all caught up."}
              hint={effectiveTab === "appointment_risk" ? "When an appointment may fall through — doctor unavailable, a time change, no confirmation — add an Appointment Risk follow-up to a journey." : "Nothing in this queue needs a Next Action right now."}
              action={
                canManageTasks ? (
                  <button type="button" onClick={() => quickCreate.openAddTask()} className="text-xs font-medium text-primary-700 hover:underline">
                    + Add Task
                  </button>
                ) : undefined
              }
            />
          </div>
        )}
        {view === "board" && visibleTasks && (
          <TaskBoard tasks={visibleTasks} now={now} timeZone={timeZone} canManage={canManageTasks} onOpen={setSelected} onMove={moveCard} />
        )}
        {view === "calendar" && visibleTasks && (
          <TaskCalendar tasks={visibleTasks} now={now} timeZone={timeZone} date={date} range={range} mode={calendarMode} onDateChange={setDate} onModeChange={setCalendarMode} onOpen={setSelected} />
        )}
        {view === "list" && visibleTasks && visibleTasks.length > 0 && (
          <div>
            <div className={`hidden gap-x-4 border-b border-line bg-surface-muted px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-ink-2 xl:grid ${ROW_GRID}`} aria-hidden="true">
              <span>Patient / Journey</span>
              <span>Reason / Next Action</span>
              <span>Due</span>
              <span>Source</span>
              <span>Team Member</span>
              <span className="text-right">Actions</span>
            </div>
            <ul className="divide-y divide-line" data-testid="my-work-task-list">
              {visibleTasks.map((task) => {
                const overdue = isOverdue(task);
                const urgency = task.status === "pending" ? urgencyLabel(task.dueAt) : null;
                const canAct = canManageTasks && task.status !== "completed";
                return (
                  <li
                    key={task.id}
                    className={`grid gap-x-4 gap-y-2 px-4 py-3 xl:items-start ${ROW_GRID} ${overdue ? "border-l-2 border-l-danger-500 pl-[14px]" : ""}`}
                    data-testid={`task-row-${task.id}`}
                  >
                    <div className="min-w-0">
                      <Link href={withFrom(`/patients/${task.patientId}`, "my-work")} className="block truncate text-sm font-semibold text-ink hover:text-primary-700 hover:underline" data-testid={`task-patient-${task.id}`}>
                        {task.patientName}
                      </Link>
                      {task.journeyId ? (
                        <Link href={withFrom(`/journeys/${task.journeyId}`, "my-work")} className="block truncate text-xs text-primary-700 hover:underline" data-testid={`task-journey-${task.id}`}>
                          {task.journeyType ?? "Journey"}
                        </Link>
                      ) : (
                        <span className="block truncate text-xs text-ink-2">No journey</span>
                      )}
                    </div>

                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge tone={TASK_REASON_TONE[task.reason]}>{TASK_REASON_LABEL[task.reason]}</Badge>
                        {task.priority === "high" && <Badge tone="warning">High priority</Badge>}
                      </div>
                      <p className="mt-1 text-xs text-ink">
                        <span className="text-ink-2">Next Action · </span>
                        {task.typeLabel}
                      </p>
                      {task.notes && <p className="mt-0.5 text-xs text-ink-2">{task.notes}</p>}
                    </div>

                    {/* Below xl: due / source / owner share one wrapping line; at xl they become grid columns. */}
                    <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 xl:contents">
                      <div className="min-w-0 text-xs tabular-nums">
                        <span className={`block ${overdue ? "font-semibold text-danger-700" : "text-ink"}`}>{urgency ? urgency.text : `Due ${fmtDate(task.dueAt)}`}</span>
                        <span className="block text-ink-2">{fmtDate(task.dueAt)}</span>
                      </div>

                      <div className="min-w-0 text-xs text-ink">
                        <span className="text-ink-2 xl:hidden">Source · </span>
                        {task.source ? (SOURCE_LABEL[task.source] ?? task.source) : "—"}
                      </div>

                      <div className="min-w-0 truncate text-xs text-ink">
                        <span className="text-ink-2 xl:hidden">Team Member · </span>
                        {task.assignedToName ?? <span className="text-ink-2">Unassigned</span>}
                      </div>
                    </div>

                    {canAct && (
                      <div className="flex min-w-0 flex-col gap-1.5 xl:items-end">
                        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                          {!task.assignedTo && (
                            <Button size="sm" variant="secondary" disabled={busy[task.id]} onClick={() => assignToMe(task)} data-testid={`task-assign-me-${task.id}`}>
                              Assign to me
                            </Button>
                          )}
                          <Button size="sm" variant="secondary" disabled={busy[task.id]} onClick={() => plusOneDay(task)} data-testid={`task-reschedule-${task.id}`}>
                            +1 day
                          </Button>
                          {task.journeyId && (
                            <Button size="sm" variant="primary" disabled={busy[task.id]} onClick={() => setLogging(task)} data-testid={`task-log-outcome-${task.id}`}>
                              Log outcome
                            </Button>
                          )}
                          <Button size="sm" variant={task.journeyId ? "secondary" : "primary"} disabled={busy[task.id]} onClick={() => complete(task)} data-testid={`task-complete-${task.id}`}>
                            Complete
                          </Button>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <input
                            type="text"
                            placeholder="Add a note…"
                            aria-label={`Add a note for ${task.patientName}`}
                            value={noteDraft[task.id] ?? ""}
                            onChange={(e) => setNoteDraft((d) => ({ ...d, [task.id]: e.target.value }))}
                            className="h-7 w-full min-w-0 max-w-[11rem] rounded-control border border-line bg-surface px-2 text-xs text-ink outline-none placeholder:text-neutral-500 focus:border-primary-500 xl:w-40"
                            data-testid={`task-note-input-${task.id}`}
                          />
                          {noteDraft[task.id] !== undefined && (
                            <button type="button" onClick={() => saveNote(task)} className="text-xs font-medium text-primary-700 hover:underline">
                              Save
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                    {actions.errors[task.id] && (
                      <p role="alert" className="text-xs font-medium text-danger-700 xl:col-span-6" data-testid={`task-error-${task.id}`}>
                        Not saved: {actions.errors[task.id]}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        </div>
      </Panel>

      {selectedTask && (
        <TaskDrawer
          task={selectedTask}
          timeZone={timeZone}
          now={now}
          canManage={canManageTasks}
          canOpenJourney={canOpenJourney}
          currentUserId={currentUserId}
          error={actions.errors[selectedTask.id]}
          busy={!!busy[selectedTask.id]}
          onClose={() => setSelected(null)}
          onComplete={() => drawerAction(complete)}
          onPlusOneDay={() => drawerAction(plusOneDay)}
          onAssignToMe={() => drawerAction(assignToMe)}
          onLogOutcome={selectedTask.journeyId ? () => { setLogging(selectedTask); setSelected(null); } : undefined}
        />
      )}

      {logging && logging.journeyId && (
        <LogOutcomeSheet
          journeyId={logging.journeyId}
          patient={{ id: logging.patientId, name: logging.patientName }}
          taskId={logging.id}
          onClose={() => setLogging(null)}
        />
      )}
    </div>
  );
}
