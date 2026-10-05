"use client";

import { useCallback, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { api } from "@pulseos/api-client";
import { Badge, Button, ConfirmDialog, EmptyState, ErrorState, Skeleton } from "@pulseos/ui";
import { ALL_SERVICES_KEY, CUSTOM_FIELD_TYPES, FIELD_GROUPS, FIELD_ORIGIN_LABEL, FIELD_VISIBILITY, type CrmFieldVm, type SpecialtyTemplateVm } from "@pulseos/types";
import { arrayMove } from "@dnd-kit/sortable";
import { useUrlFilters } from "@/lib/useUrlFilters";
import { CheckRow, FormError, SelectInput, TouchCheckbox } from "./FormBits";
import { FieldEditorSheet } from "./FieldEditorSheet";
import { ReorderStatus, RowOrderControls, SortableGroup, useReorder, useSortableRow, type OrderControl, type RowStatus } from "./SortableList";
import { blankField, fieldToForm, placementSummary, type FieldForm } from "./crmFieldForm";

const TYPE_LABEL = new Map(CUSTOM_FIELD_TYPES.map((t) => [t.key, t.label]));
const VISIBILITY_LABEL = new Map(FIELD_VISIBILITY.map((v) => [v.key, v.label]));

function FieldRow({ field, position, total, canMove, locked, status, focusRequest, onMove, onEdit, onArchive, onRestore, onToggleAddLead }: { field: CrmFieldVm; position: number; total: number; canMove: boolean; locked: boolean; status: RowStatus; focusRequest: { id: string; control: OrderControl; n: number } | null; onMove: (d: -1 | 1) => void; onEdit: () => void; onArchive: () => void; onRestore: () => void; onToggleAddLead: (on: boolean) => Promise<boolean> }) {
  // Shown at once; settles to the saved value when the list refreshes (or snaps back if the save failed).
  const savedAddLead = field.placements.includes("add_lead");
  const [pendingAddLead, setPendingAddLead] = useState<{ on: boolean; wasSaved: boolean } | null>(null);
  const shownAddLead = pendingAddLead && pendingAddLead.wasSaved === savedAddLead ? pendingAddLead.on : savedAddLead;
  // Only the grip starts a drag — the rest of the row keeps its normal click targets (Edit, Archive).
  const { isDragging, rowProps, gripProps } = useSortableRow(field.id, !canMove || locked, { status, archived: field.archived });
  return (
    <li {...rowProps} className={`${rowProps.className} flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 first:rounded-t-card last:rounded-b-card`} data-testid={`field-row-${field.key}`}>
      <RowOrderControls
        rowId={field.id}
        label={field.label}
        position={position}
        total={total}
        disabled={!canMove}
        locked={locked}
        dragging={isDragging}
        gripProps={gripProps}
        onMove={onMove}
        focusRequest={focusRequest}
        ids={{ drag: `field-drag-${field.key}`, up: `field-move-up-${field.key}`, down: `field-move-down-${field.key}`, position: `field-position-${field.key}` }}
      />
      <button type="button" onClick={onEdit} className="min-w-0 flex-1 basis-40 text-left max-md:flex max-md:min-h-11 max-md:flex-col max-md:justify-center" aria-label={`Edit ${field.label}`} data-testid={`field-edit-${field.key}`}>
        <span className="block truncate text-sm font-medium text-ink">{field.label}</span>
        <span className="block truncate text-[11px] text-ink-2">
          {TYPE_LABEL.get(field.fieldType) ?? field.fieldType} · Used in {placementSummary(field.placements)}
        </span>
      </button>
      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
        {field.origin !== "CUSTOM" && <Badge tone={field.origin === "SYSTEM" ? "primary" : "neutral"} data-testid={`field-origin-${field.key}`}>{FIELD_ORIGIN_LABEL[field.origin]}</Badge>}
        {field.required && <Badge tone="primary">Required</Badge>}
        {field.filterable && <Badge>Filterable</Badge>}
        {field.visibleTo !== "everyone" && <Badge>{VISIBILITY_LABEL.get(field.visibleTo)}</Badge>}
        {field.archived && <Badge tone="warning">Archived</Badge>}
      </div>
      {/* The one switch staff reach for most: does this question appear when a new enquiry is added? Nothing recorded is deleted either way. */}
      {!field.archived && (
        <label className="flex min-h-11 shrink-0 cursor-pointer items-center gap-0.5 text-xs text-ink sm:min-h-0 sm:gap-1.5" title="Ask this when a new enquiry is added">
          <TouchCheckbox
            checked={shownAddLead}
            onChange={(on) => {
              setPendingAddLead({ on, wasSaved: savedAddLead });
              void onToggleAddLead(on).then((ok) => {
                if (!ok) setPendingAddLead(null);
              });
            }}
            testId={`field-add-lead-${field.key}`}
            ariaLabel={`Show "${field.label}" on Add Lead`}
          />
          On Add Lead
        </label>
      )}
      <div className="flex shrink-0 items-center gap-1">
        <Button size="sm" variant="ghost" className="min-h-11 sm:min-h-0" onClick={onEdit}>
          Edit
        </Button>
        {field.origin === "SYSTEM" ? (
          <span className="px-2 text-[11px] text-ink-2" data-testid={`field-locked-${field.key}`}>Always on</span>
        ) : field.archived ? (
          <Button size="sm" variant="ghost" onClick={onRestore} data-testid={`field-restore-${field.key}`}>
            Restore
          </Button>
        ) : (
          <Button size="sm" variant="ghost" onClick={onArchive} data-testid={`field-archive-${field.key}`}>
            Archive
          </Button>
        )}
      </div>
    </li>
  );
}

/**
 * Settings → CRM Fields. One field system: each field is defined once and placed wherever it is needed
 * (Add Lead, Journey Detail, Patient 360, follow-up outcome, appointment, treatment). Archiving never
 * deletes what was recorded.
 */
export function CrmFieldsSection({ services }: { services: SpecialtyTemplateVm[] }) {
  const queryClient = useQueryClient();
  const urlFilters = useUrlFilters();
  const requested = urlFilters.get("service");
  const scope = requested === ALL_SERVICES_KEY || services.some((s) => s.key === requested) ? requested : (services[0]?.key ?? ALL_SERVICES_KEY);
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState<{ mode: "create" | "edit"; form: FieldForm; id?: string } | null>(null);
  const [confirming, setConfirming] = useState<CrmFieldVm | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fields = useQuery({ queryKey: ["crm-fields"], queryFn: () => api.crmFields({ includeArchived: true }) });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["crm-fields"] });

  const inScope = useMemo(() => (fields.data ?? []).filter((f) => f.specialtyKey === scope), [fields.data, scope]);
  const shown = inScope.filter((f) => showArchived || !f.archived);
  const sharedCount = scope === ALL_SERVICES_KEY ? 0 : (fields.data ?? []).filter((f) => f.specialtyKey === ALL_SERVICES_KEY && !f.archived).length;
  const archivedCount = inScope.filter((f) => f.archived).length;

  // One reorder path for drag-and-drop and the arrow buttons: show the new order at once, persist it, roll back on failure.
  const labelOf = useCallback((id: string) => (fields.data ?? []).find((f) => f.id === id)?.label ?? "Field", [fields.data]);
  const saveOrder = useCallback((groupKey: CrmFieldVm["groupKey"], orderedIds: string[]) => api.reorderCrmFields({ specialtyKey: scope, groupKey, orderedIds }), [scope]);
  const sort = useReorder<CrmFieldVm["groupKey"]>({ save: saveOrder, refresh, label: labelOf });

  const groups = FIELD_GROUPS.map((g) => ({ ...g, fields: sort.ordered(g.key, shown.filter((f) => f.groupKey === g.key)) })).filter((g) => g.fields.length > 0);

  async function run(action: () => Promise<unknown>, fallback: string) {
    setError(null);
    try {
      await action();
      await refresh();
    } catch {
      setError(fallback);
    }
  }

  // Only active fields are ordered: an archived neighbour is never a swap partner and never counted in positions.
  const move = (group: { key: CrmFieldVm["groupKey"]; fields: CrmFieldVm[] }, field: CrmFieldVm, d: -1 | 1) => {
    const ids = group.fields.filter((f) => !f.archived).map((f) => f.id);
    const index = ids.indexOf(field.id);
    const j = index + d;
    if (index < 0 || j < 0 || j >= ids.length) return;
    return sort.reorder(group.key, arrayMove(ids, index, j), field.id, d < 0 ? "up" : "down", ids);
  };

  return (
    <div className="space-y-4" data-testid="crm-fields-section">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-48 flex-1 sm:max-w-xs">
          <SelectInput label="Fields for" value={scope} onChange={(e) => urlFilters.set({ service: e.target.value })} data-testid="crm-fields-scope">
            <option value={ALL_SERVICES_KEY}>All services (shared)</option>
            {services.map((s) => (
              <option key={s.key} value={s.key}>
                {s.displayName}
              </option>
            ))}
          </SelectInput>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-3">
          {archivedCount > 0 && <CheckRow label={`Show archived (${archivedCount})`} checked={showArchived} onChange={setShowArchived} testId="crm-fields-show-archived" />}
          <Button variant="primary" onClick={() => setEditing({ mode: "create", form: blankField(scope) })} data-testid="crm-fields-add">
            <Plus size={14} aria-hidden="true" /> Add field
          </Button>
        </div>
      </div>

      {sharedCount > 0 && (
        <p className="text-xs text-ink-2" data-testid="crm-fields-shared-note">
          {sharedCount} shared field{sharedCount === 1 ? "" : "s"} also appear for this service.{" "}
          <button type="button" className="font-medium text-primary-700 hover:underline" onClick={() => urlFilters.set({ service: ALL_SERVICES_KEY })}>
            View shared fields
          </button>
        </p>
      )}

      <FormError message={error ?? sort.error} testId="crm-fields-error" />
      <ReorderStatus message={sort.announcement} />

      {fields.isLoading && (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-14" />
          ))}
        </div>
      )}
      {fields.isError && <ErrorState message="Could not load CRM fields." />}
      {fields.data && groups.length === 0 && (
        <EmptyState message="No fields here yet." hint="Add a field to capture more about each patient's enquiry for this service." action={<Button variant="primary" onClick={() => setEditing({ mode: "create", form: blankField(scope) })}>Add field</Button>} />
      )}

      {groups.map((g) => (
        <section key={g.key} aria-labelledby={`group-${g.key}`} data-testid={`field-group-${g.key}`}>
          <h3 id={`group-${g.key}`} className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-2">
            {g.label}
            <span className="ml-2 hidden font-normal normal-case tracking-normal sm:inline">· shown in this order — drag the handle to reorder</span>
          </h3>
          <SortableGroup items={g.fields.filter((f) => !f.archived).map((f) => ({ id: f.id, label: f.label }))} onReorder={(ids, moved) => void sort.reorder(g.key, ids, moved, "grip", g.fields.filter((f) => !f.archived).map((f) => f.id))}>
            <ul className="divide-y divide-line rounded-card border border-line bg-white" aria-label={`${g.label} fields`} aria-busy={sort.isSaving(g.key)}>
              {g.fields.map((f) => {
                const activeFields = g.fields.filter((x) => !x.archived);
                return (
                <FieldRow
                  key={f.id}
                  field={f}
                  position={activeFields.findIndex((x) => x.id === f.id) + 1}
                  total={activeFields.length}
                  canMove={!f.archived}
                  locked={sort.isSaving(g.key)}
                  status={sort.statusOf(f.id)}
                  focusRequest={sort.focusRequest}
                  onMove={(d) => move(g, f, d)}
                  onEdit={() => setEditing({ mode: "edit", form: fieldToForm(f), id: f.id })}
                  onArchive={() => setConfirming(f)}
                  onRestore={() => run(() => api.updateCrmField(f.id, { archived: false }), "Couldn't restore that field — try again.")}
                  onToggleAddLead={async (on) => {
                    const placements = on ? [...f.placements, "add_lead" as const] : f.placements.filter((p) => p !== "add_lead");
                    // A field must be placed somewhere: switching off its last place is archiving, which is a separate, explained step.
                    if (placements.length === 0) {
                      setError("This field is only used on Add Lead. Archive it instead, or place it somewhere else first (Edit).");
                      return false;
                    }
                    setError(null);
                    try {
                      await api.updateCrmField(f.id, { placements });
                      await refresh();
                      return true;
                    } catch {
                      setError(`Couldn't change ${f.label} — try again.`);
                      return false;
                    }
                  }}
                />
                );
              })}
            </ul>
          </SortableGroup>
        </section>
      ))}

      {editing && (
        <FieldEditorSheet
          mode={editing.mode}
          initial={editing.form}
          fieldId={editing.id}
          services={services}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await refresh();
          }}
        />
      )}

      <ConfirmDialog
        open={!!confirming}
        title={confirming ? `Archive "${confirming.label}"?` : ""}
        description="This removes it from new forms and from this list going forward. Existing patients who already have a value saved for it keep that value on their record — archiving doesn't delete historical data, only stops collecting it for new journeys. You can restore it any time."
        confirmLabel="Archive field"
        onConfirm={() => {
          const f = confirming;
          setConfirming(null);
          if (f) void run(() => api.updateCrmField(f.id, { archived: true }), "Couldn't archive that field — try again.");
        }}
        onCancel={() => setConfirming(null)}
      />
    </div>
  );
}
