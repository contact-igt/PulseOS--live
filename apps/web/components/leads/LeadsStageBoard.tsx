"use client";

import { KanbanBoard, relativeTime, urgencyLabel } from "@pulseos/ui";
import type { LeadRow } from "@pulseos/types";
import { Info } from "lucide-react";
import { STAGE_COLUMNS } from "./stageBoard";

/**
 * Leads as a READ-ONLY board by journey stage. There is no journey-stage
 * mutation endpoint, so no drag and no move menu: stage changes happen on the
 * journey page (card click). Renders exactly the rows the table renders.
 */
export function LeadsStageBoard({ rows, onOpen }: { rows: LeadRow[]; onOpen: (row: LeadRow) => void }) {
  return (
    <div className="min-w-0 space-y-2" data-testid="leads-board">
      <p className="flex items-center gap-1.5 px-1 text-xs text-ink-2" data-testid="leads-board-hint">
        <Info size={13} aria-hidden="true" className="shrink-0" />
        Read-only view. Stages change from the journey page.
      </p>
      <KanbanBoard
        ariaLabel="Journeys by stage"
        columns={STAGE_COLUMNS}
        cards={rows}
        getCardId={(r) => r.id}
        getColumnKey={(r) => r.stage}
        getCardLabel={(r) => `${r.patientName}, ${r.specialtyLabel ?? "journey"}. Open journey`}
        onCardClick={onOpen}
        emptyColumnMessage="No journeys"
        renderCard={(r) => {
          const due = r.nextActionDueAt ? urgencyLabel(r.nextActionDueAt) : null;
          return (
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="truncate text-sm font-semibold text-ink">{r.patientName}</span>
              <span className="truncate text-xs text-ink-2">
                {r.specialtyLabel ?? "Journey"} · {r.sourceLabel}
              </span>
              <span className="truncate text-[11px] text-ink-2">{r.ownerName ?? "Unassigned"}</span>
              <span className={`truncate text-[11px] ${due?.overdue ? "font-medium text-danger-700" : "text-ink-2"}`}>
                {due ? `Next Action · ${due.text}` : `Last activity ${relativeTime(r.lastInteractionAt)}`}
              </span>
            </span>
          );
        }}
      />
    </div>
  );
}
