import type { BranchDoctorRow, TeamWorkloadRow } from "@pulseos/types";
import { Badge, Panel } from "./primitives";

interface LoadRow {
  id: string;
  name: string;
  roleLabel: string;
  /** Bar length. */
  total: number;
  /** Portion of the bar that is overdue (tasks only). */
  overdue: number;
  summary: string;
}

const ROW_CLASS = "flex w-full items-center gap-3 rounded-control px-2 py-2.5 text-left";

function LoadBar({ row, max, onClick }: { row: LoadRow; max: number; onClick?: () => void }) {
  const onTime = Math.max(row.total - row.overdue, 0);
  const body = (
    <>
      <span className="min-w-0 flex-1 @[24rem]:w-32 @[24rem]:flex-none">
        <span className="block truncate text-sm font-medium text-ink">{row.name}</span>
        <span className="block truncate text-[11px] text-ink-2">{row.roleLabel}</span>
      </span>
      <span className="hidden h-2 min-w-8 flex-1 gap-px overflow-hidden rounded-full bg-primary-100 @[24rem]:flex" aria-hidden="true">
        <span className="h-full bg-primary-500" style={{ width: `${max > 0 ? (onTime / max) * 100 : 0}%` }} />
        <span className="h-full bg-danger-500" style={{ width: `${max > 0 ? (row.overdue / max) * 100 : 0}%` }} />
      </span>
      <span className="shrink-0 text-right">
        <span className="block text-sm font-semibold tabular-nums text-ink">{row.total}</span>
      </span>
      <span className="flex w-24 shrink-0 justify-end">
        {row.overdue > 0 ? <Badge tone="danger">{row.overdue} overdue</Badge> : <span className="text-[11px] text-ink-2">{row.summary}</span>}
      </span>
    </>
  );
  // A row is only a button when it goes somewhere real — no dead clicks.
  return onClick ? (
    <button type="button" onClick={onClick} className={`${ROW_CLASS} transition hover:bg-primary-50 focus-visible:-outline-offset-2`} data-testid={`load-row-${row.id}`}>
      {body}
    </button>
  ) : (
    <div className={ROW_CLASS} data-testid={`load-row-${row.id}`}>
      {body}
    </div>
  );
}

function Group({ label, rows, max, onRowClick }: { label: string; rows: LoadRow[]; max: number; onRowClick?: (id: string) => void }) {
  if (rows.length === 0) return null;
  return (
    <section>
      <h3 className="px-2 pb-0.5 pt-1 text-[11px] font-semibold uppercase tracking-wide text-ink-2">{label}</h3>
      <div>
        {rows.map((row) => (
          <LoadBar key={row.id} row={row} max={max} onClick={onRowClick ? () => onRowClick(row.id) : undefined} />
        ))}
      </div>
    </section>
  );
}

/**
 * Workload by person: the coordination team (open tasks, overdue split out)
 * and doctors (appointments, waiting). Rows are plain, non-interactive unless
 * the caller supplies a click handler that lands somewhere real.
 */
export function TeamPanel({
  team,
  doctors,
  onTeamClick,
  onDoctorClick,
}: {
  team: TeamWorkloadRow[];
  doctors: BranchDoctorRow[];
  onTeamClick?: (row: TeamWorkloadRow) => void;
  onDoctorClick?: (row: BranchDoctorRow) => void;
}) {
  const teamRows: LoadRow[] = team.map((r) => ({
    id: r.userId,
    name: r.name,
    roleLabel: `${r.role === "FRONT_DESK" ? "Front Desk" : "Coordinator"} · open tasks`,
    total: r.openTasks,
    overdue: r.overdueTasks,
    summary: "none overdue",
  }));
  const doctorRows: LoadRow[] = doctors.map((r) => ({
    id: r.id,
    name: r.name,
    roleLabel: "Doctor · appointments",
    total: r.appointments,
    overdue: 0,
    summary: r.waitingLoad > 0 ? `${r.waitingLoad} waiting` : `${r.consultations} consulted`,
  }));

  const openTasks = team.reduce((sum, r) => sum + r.openTasks, 0);
  const overdueTasks = team.reduce((sum, r) => sum + r.overdueTasks, 0);
  const appointments = doctors.reduce((sum, r) => sum + r.appointments, 0);
  const max = Math.max(...teamRows.map((r) => r.total), ...doctorRows.map((r) => r.total), 1);

  return (
    <Panel title="Team / Doctor Load" subtitle="Assigned work by person" className="h-full" data-testid="team-panel">
      <p className="mb-2 text-xs text-ink-2" data-testid="team-summary">
        <span className="font-semibold tabular-nums text-ink">{openTasks}</span> open tasks, <span className="font-semibold tabular-nums text-ink">{overdueTasks}</span> overdue
        {" · "}
        <span className="font-semibold tabular-nums text-ink">{appointments}</span> doctor appointments
      </p>
      <div className="@container -mx-2 space-y-3">
        <Group
          label="Coordination team"
          rows={teamRows}
          max={max}
          onRowClick={onTeamClick ? (id) => onTeamClick(team.find((t) => t.userId === id)!) : undefined}
        />
        <Group
          label="Doctors"
          rows={doctorRows}
          max={max}
          onRowClick={onDoctorClick ? (id) => onDoctorClick(doctors.find((d) => d.id === id)!) : undefined}
        />
      </div>
    </Panel>
  );
}
