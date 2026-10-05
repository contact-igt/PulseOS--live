"use client";

import { useCallback, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Lock, Plus } from "lucide-react";
import { api } from "@pulseos/api-client";
import { Badge, Button, EmptyState, ErrorState, Skeleton } from "@pulseos/ui";
import type { CrmOutcomeVm, JourneyStage } from "@pulseos/types";
import { CheckRow, FormError } from "@/components/settings/FormBits";
import { ReorderStatus, RowOrderControls, SortableGroup, useReorder, useSortableRow, type OrderControl, type RowStatus } from "@/components/settings/SortableList";
import { OutcomeEditorSheet } from "./OutcomeEditorSheet";
import { blankOutcome, outcomeHint, outcomeToForm, type OutcomeForm } from "./outcomeForm";
import { SYSTEM_STAGES, outcomesForStage } from "./stageModel";

type FocusRequest = { id: string; control: OrderControl; n: number } | null;

function OutcomeRow({ o, position, total, locked, status, focusRequest, onMove, onEdit, onArchive, onRestore }: { o: CrmOutcomeVm; position: number; total: number; locked: boolean; status: RowStatus; focusRequest: FocusRequest; onMove: (d: -1 | 1) => void; onEdit: () => void; onArchive: () => void; onRestore: () => void }) {
  const { isDragging, rowProps, gripProps } = useSortableRow(o.id, o.archived || locked, { status, archived: o.archived });
  return (
    <li {...rowProps} className={`${rowProps.className} flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 first:rounded-t-card last:rounded-b-card`} data-testid={`outcome-row-${o.key}`}>
      <RowOrderControls
        rowId={o.id}
        label={o.label}
        position={position}
        total={total}
        disabled={o.archived}
        locked={locked}
        dragging={isDragging}
        gripProps={gripProps}
        onMove={onMove}
        focusRequest={focusRequest}
        ids={{ drag: `outcome-drag-${o.key}`, up: `outcome-move-up-${o.key}`, down: `outcome-move-down-${o.key}` }}
      />
      <button type="button" className="min-w-0 flex-1 basis-40 text-left max-md:flex max-md:min-h-11 max-md:flex-col max-md:justify-center" onClick={onEdit} aria-label={`Edit ${o.label}`} data-testid={`outcome-edit-${o.key}`}>
        <span className="block truncate text-sm font-medium text-ink">{o.label}</span>
        <span className="block truncate text-[11px] text-ink-2">{outcomeHint(o) || "No extra steps"}</span>
      </button>
      <div className="flex shrink-0 items-center gap-1.5">{o.archived && <Badge tone="warning">Archived</Badge>}</div>
      <div className="flex shrink-0 items-center gap-1">
        <Button size="sm" variant="ghost" className="min-h-11 sm:min-h-0" onClick={onEdit}>
          Edit
        </Button>
        {o.archived ? (
          <Button size="sm" variant="ghost" className="min-h-11 sm:min-h-0" onClick={onRestore} data-testid={`outcome-restore-${o.key}`}>
            Restore
          </Button>
        ) : (
          <Button size="sm" variant="ghost" className="min-h-11 sm:min-h-0" onClick={onArchive} data-testid={`outcome-archive-${o.key}`}>
            Archive
          </Button>
        )}
      </div>
    </li>
  );
}

/**
 * Settings → Workflow Outcomes. The journey's STAGES are PulseOS's own — fixed, in order, locked — so reports and the
 * state machines stay consistent. What a hospital configures is the OUTCOMES recorded under the two stages a call or
 * follow-up can move a journey to (Contacted, Lost): add, rename, reorder, archive, and three simple rules.
 */
const active0 = (list: CrmOutcomeVm[]) => list.filter((x) => !x.archived).map((x) => x.id);

export function OutcomesSection() {
  const queryClient = useQueryClient();
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState<{ mode: "create" | "edit"; form: OutcomeForm; id?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const outcomes = useQuery({ queryKey: ["crm-outcomes", "all"], queryFn: () => api.crmOutcomes({ includeArchived: true }) });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["crm-outcomes"] });

  const all = useMemo(() => outcomes.data ?? [], [outcomes.data]);
  const archivedCount = all.filter((o) => o.archived).length;

  async function run(action: () => Promise<unknown>, fallback: string) {
    setError(null);
    try {
      await action();
      await refresh();
    } catch {
      setError(fallback);
    }
  }

  // One reorder path for drag and arrows: show the order at once, save it, put it back with a message on failure.
  const labelOf = useCallback((id: string) => all.find((o) => o.id === id)?.label ?? "Outcome", [all]);
  const saveOrder = useCallback((_stage: JourneyStage, ids: string[]) => api.reorderCrmOutcomes(ids), []);
  const sort = useReorder<JourneyStage>({ save: saveOrder, refresh, label: labelOf });

  const listFor = (stage: JourneyStage) => sort.ordered(stage, outcomesForStage(all, stage, showArchived));
  const add = (stage: "contacted" | "lost") => setEditing({ mode: "create", form: { ...blankOutcome(), stage } });

  return (
    <div className="space-y-4" data-testid="outcomes-section">
      <p className="max-w-2xl text-xs leading-relaxed text-ink-2">
        Every journey moves through the same fixed stages, so reports mean the same thing everywhere. Your team chooses the outcomes recorded under <strong className="font-semibold text-ink">Contacted</strong> and <strong className="font-semibold text-ink">Lost</strong> — what happened on a call or follow-up. All other stages update on their own.
      </p>
      <div className="flex flex-wrap items-center justify-end gap-3">
        {archivedCount > 0 && <CheckRow label={`Show archived (${archivedCount})`} checked={showArchived} onChange={setShowArchived} testId="outcomes-show-archived" />}
        <Button variant="primary" onClick={() => add("contacted")} data-testid="outcomes-add">
          <Plus size={14} aria-hidden="true" /> Add outcome
        </Button>
      </div>
      <FormError message={error ?? sort.error} testId="outcomes-error" />
      <ReorderStatus message={sort.announcement} />
      {outcomes.isLoading && <div className="space-y-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-14" />)}</div>}
      {outcomes.isError && <ErrorState message="Could not load outcomes." />}

      {outcomes.data && (
        <ol className="space-y-3" aria-label="Journey stages" data-testid="outcome-list">
          {SYSTEM_STAGES.map((stage) => {
            const list = stage.outcomes ? listFor(stage.key) : [];
            const busy = sort.isSaving(stage.key);
            return (
              <li key={stage.key} data-testid={`stage-${stage.key}`}>
                <div className={`flex flex-wrap items-center gap-x-2 gap-y-1 rounded-card border px-3 py-2 ${stage.outcomes ? "border-line bg-primary-50/60" : "border-line/70 bg-neutral-50/70"}`}>
                  <Lock size={13} className="shrink-0 text-ink-2" aria-hidden="true" />
                  <h3 className="text-sm font-semibold text-ink">{stage.label}</h3>
                  <span data-testid={`stage-locked-${stage.key}`}>
                    <Badge tone="neutral">System stage · fixed</Badge>
                  </span>
                  <span className="min-w-0 flex-1 basis-48 text-xs text-ink-2">
                    {stage.how}
                    {!stage.outcomes && " Set automatically."}
                  </span>
                  {stage.outcomes && (
                    <Button size="sm" variant="secondary" onClick={() => add(stage.key as "contacted" | "lost")} data-testid={`outcomes-add-${stage.key}`}>
                      <Plus size={13} aria-hidden="true" /> Add outcome
                    </Button>
                  )}
                </div>
                {stage.outcomes && (
                  <div className="ml-1 mt-1.5 border-l-2 border-primary-100 pl-2.5 sm:ml-5 sm:pl-4">
                    {list.length === 0 ? (
                      <EmptyState message={`No outcomes under ${stage.label} yet.`} hint="Add the outcomes your team records." />
                    ) : (
                      <SortableGroup items={list.filter((o) => !o.archived).map((o) => ({ id: o.id, label: o.label }))} onReorder={(ids, moved) => void sort.reorder(stage.key, ids, moved, "grip", active0(list))}>
                        <ul className="divide-y divide-line rounded-card border border-line bg-white" aria-label={`${stage.label} outcomes`} aria-busy={busy} data-testid={`outcome-group-${stage.key}`}>
                          {list.map((o) => {
                            // Only active outcomes are ordered: an archived neighbour is never a swap partner.
                            const active = list.filter((x) => !x.archived);
                            const i = active.findIndex((x) => x.id === o.id);
                            return (
                            <OutcomeRow
                              key={o.id}
                              o={o}
                              position={i + 1}
                              total={active.length}
                              locked={busy}
                              status={sort.statusOf(o.id)}
                              focusRequest={sort.focusRequest}
                              onMove={(d) => {
                                const ids = active.map((x) => x.id);
                                const j = i + d;
                                if (j < 0 || j >= ids.length) return;
                                [ids[i], ids[j]] = [ids[j]!, ids[i]!];
                                void sort.reorder(stage.key, ids, o.id, d < 0 ? "up" : "down", active0(list));
                              }}
                              onEdit={() => setEditing({ mode: "edit", form: outcomeToForm(o), id: o.id })}
                              onArchive={() => run(() => api.updateCrmOutcome(o.id, { archived: true }), "Couldn't archive that outcome — try again.")}
                              onRestore={() => run(() => api.updateCrmOutcome(o.id, { archived: false }), "Couldn't restore that outcome — try again.")}
                            />
                            );
                          })}
                        </ul>
                      </SortableGroup>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}

      {editing && (
        <OutcomeEditorSheet
          mode={editing.mode}
          initial={editing.form}
          outcomeId={editing.id}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await refresh();
          }}
        />
      )}
    </div>
  );
}
