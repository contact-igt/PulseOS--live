"use client";

import { treatmentDateLine, treatmentDoctorLabel } from "./treatmentDates";
import { useCallback, useMemo } from "react";
import { Lock } from "lucide-react";
import { KanbanBoard, TREATMENT_STATUS_LABEL, formatInr, formatKey, localDayKey } from "@pulseos/ui";
import type { KanbanColumn } from "@pulseos/ui";
import type { TreatmentRow, TreatmentStatus } from "@pulseos/types";
import { allowedBoardMoves, boardColumnKeys } from "./pipeline";

const COLUMN_HINT: Partial<Record<TreatmentStatus, string>> = {
  DECLINED: "Closed · decline from the table",
  CANCELLED: "Closed",
  LOST: "Closed",
};

/**
 * Treatments as a pipeline board: one column per treatment state. Moves are
 * only the server-valid, non-destructive transitions (see BOARD_MOVES); with
 * no `onMove` (role without MANAGE_TREATMENT) the board is read-only.
 */
export function TreatmentPipelineBoard({
  rows,
  timeZone,
  onOpen,
  onMove,
  showValue = true,
}: {
  rows: TreatmentRow[];
  /** Hospital IANA zone for planned-date labels. */
  timeZone: string;
  onOpen: (row: TreatmentRow) => void;
  onMove?: (row: TreatmentRow, to: TreatmentStatus) => Promise<void>;
  /** False when the hospital has revenue tracking off: no rupee value on the cards. */
  showValue?: boolean;
}) {
  const columns = useMemo<KanbanColumn[]>(
    () => boardColumnKeys(rows).map((key) => ({ key, title: TREATMENT_STATUS_LABEL[key], hint: COLUMN_HINT[key] })),
    [rows],
  );
  const getCardId = useCallback((r: TreatmentRow) => r.id, []);
  const getColumnKey = useCallback((r: TreatmentRow) => r.status, []);

  return (
    <div className="min-w-0 space-y-2" data-testid="treatment-pipeline">
      {onMove ? (
        <p className="text-xs text-ink-2">Drag a card, or use its Move control, to advance a treatment. Decline stays in the table so it can be confirmed.</p>
      ) : (
        <p className="flex items-center gap-1.5 text-xs text-ink-2" data-testid="treatment-board-readonly">
          <Lock size={12} aria-hidden="true" />
          Read-only — your role can view treatments but not change their state.
        </p>
      )}
      <KanbanBoard<TreatmentRow>
        ariaLabel="Treatment pipeline"
        columns={columns}
        cards={rows}
        getCardId={getCardId}
        getColumnKey={getColumnKey}
        getCardLabel={(r) => `${r.patientName}, ${r.treatmentLabel}`}
        onCardClick={onOpen}
        getAllowedMoves={onMove ? (r) => allowedBoardMoves(r.status) : undefined}
        onMove={onMove ? (r, to) => onMove(r, to as TreatmentStatus) : undefined}
        emptyColumnMessage="No treatments"
        renderCard={(r) => (
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="truncate text-sm font-medium text-ink">{r.patientName}</span>
            <span className="truncate text-xs text-ink-2">{r.treatmentLabel}</span>
            <span className="mt-1 flex min-w-0 items-center justify-between gap-2 text-[11px] text-ink-2">
              <span className="truncate">{r.status === "SCHEDULED" || r.status === "COMPLETED" ? treatmentDoctorLabel(r) : (r.doctorName ?? r.service ?? "—")}</span>
              <span className="shrink-0 font-medium tabular-nums text-ink">{showValue ? formatInr(r.estimatedValue) : null}</span>
            </span>
            {(() => {
              const line = treatmentDateLine(r, (iso) => formatKey(localDayKey(iso, timeZone), { day: "numeric", month: "short" }));
              return line && <span className="text-[11px] text-ink-2">{line.label} {line.text}</span>;
            })()}
          </span>
        )}
      />
    </div>
  );
}
