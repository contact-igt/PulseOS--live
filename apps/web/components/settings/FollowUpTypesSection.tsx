"use client";

import { useCallback, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { api, ApiError } from "@pulseos/api-client";
import { Badge, Button, EmptyState, ErrorState, SideSheet, Skeleton } from "@pulseos/ui";
import { FOLLOW_UP_BEHAVIOURS, type FollowUpDefaultOwner, type FollowUpTypeVm, type TaskPriority, type TaskType } from "@pulseos/types";
import { FOLLOW_UP_DEFAULT_LABEL } from "@/lib/followUpLabels";
import { CheckRow, FormError, SelectInput, TextInput } from "./FormBits";
import { ReorderStatus, RowOrderControls, SortableGroup, useReorder, useSortableRow, type OrderControl, type RowStatus } from "./SortableList";

const BEHAVIOUR_LABEL = new Map(FOLLOW_UP_BEHAVIOURS.map((b) => [b.key, b.label]));

interface TypeForm {
  label: string;
  canonicalTaskType: TaskType;
  defaultPriority: TaskPriority;
  defaultOwner: FollowUpDefaultOwner;
  requiresNote: boolean;
  departmentId: string;
}

const blank = (): TypeForm => ({ label: "", canonicalTaskType: "FOLLOW_UP", defaultPriority: "normal", defaultOwner: "JOURNEY_OWNER", requiresNote: false, departmentId: "" });
const fromType = (t: FollowUpTypeVm): TypeForm => ({ label: t.label, canonicalTaskType: t.canonicalTaskType, defaultPriority: t.defaultPriority, defaultOwner: t.defaultOwner, requiresNote: t.requiresNote, departmentId: t.departmentId ?? "" });

const SAVE_ERRORS: Record<string, string> = {
  type_exists: "You already have a follow-up type with that name.",
  last_active_type: "At least one follow-up type must stay available.",
  department_not_found: "That department no longer exists.",
};

function TypeSheet({ existing, onClose, onSaved }: { existing: FollowUpTypeVm | null; onClose: () => void; onSaved: () => void }) {
  const departments = useQuery({ queryKey: ["departments"], queryFn: api.departments });
  const [form, setForm] = useState<TypeForm>(existing ? fromType(existing) : blank());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof TypeForm>(key: K, value: TypeForm[K]) => setForm((f) => ({ ...f, [key]: value }));

  async function save() {
    const label = form.label.trim();
    if (!label) return setError("Give the follow-up type a name.");
    setSaving(true);
    setError(null);
    const body = { label, canonicalTaskType: form.canonicalTaskType, defaultPriority: form.defaultPriority, defaultOwner: form.defaultOwner, requiresNote: form.requiresNote, departmentId: form.departmentId || null };
    try {
      if (existing) await api.updateFollowUpType(existing.id, body);
      else await api.createFollowUpType(body);
      onSaved();
    } catch (err) {
      setError(SAVE_ERRORS[err instanceof ApiError ? err.message : ""] ?? "Couldn't save this follow-up type — what you typed is still here. Try again.");
      setSaving(false);
    }
  }

  return (
    <SideSheet
      title={existing ? "Edit follow-up type" : "Add follow-up type"}
      subtitle="What staff can schedule from a journey"
      onClose={onClose}
      testId="followup-type-editor"
      footer={
        <>
          <Button variant="secondary" className="min-h-11 sm:min-h-0" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button className="min-h-11 sm:min-h-0" onClick={save} disabled={saving} data-testid="followup-type-save">
            {saving ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <TextInput label="Name" value={form.label} maxLength={60} onChange={(e) => set("label", e.target.value)} placeholder="e.g. Pre-surgery counselling" data-testid="followup-type-name" />
        <SelectInput label="Works like" hint={FOLLOW_UP_BEHAVIOURS.find((b) => b.key === form.canonicalTaskType)?.hint} value={form.canonicalTaskType} onChange={(e) => set("canonicalTaskType", e.target.value as TaskType)} data-testid="followup-type-behaviour">
          {FOLLOW_UP_BEHAVIOURS.map((b) => (
            <option key={b.key} value={b.key}>
              {b.label}
            </option>
          ))}
        </SelectInput>
        <div className="grid grid-cols-2 gap-3">
          <SelectInput label="Default priority" value={form.defaultPriority} onChange={(e) => set("defaultPriority", e.target.value as TaskPriority)} data-testid="followup-type-priority">
            <option value="normal">Normal</option>
            <option value="high">High</option>
          </SelectInput>
          <SelectInput label="Default Team Member" value={form.defaultOwner} onChange={(e) => set("defaultOwner", e.target.value as FollowUpDefaultOwner)} data-testid="followup-type-owner">
            {(Object.keys(FOLLOW_UP_DEFAULT_LABEL) as FollowUpDefaultOwner[]).map((k) => (
              <option key={k} value={k}>
                {FOLLOW_UP_DEFAULT_LABEL[k]}
              </option>
            ))}
          </SelectInput>
        </div>
        <SelectInput label="Available for" value={form.departmentId} onChange={(e) => set("departmentId", e.target.value)} data-testid="followup-type-department">
          <option value="">All departments</option>
          {(departments.data ?? []).map((d) => (
            <option key={d.id} value={d.id}>
              {d.displayName}
            </option>
          ))}
        </SelectInput>
        <CheckRow label="Always ask for a note" hint="Staff must say why — useful for things like Appointment Risk." checked={form.requiresNote} onChange={(v) => set("requiresNote", v)} testId="followup-type-requires-note" />
        <FormError message={error} />
      </div>
    </SideSheet>
  );
}

function TypeRow({ t, position, total, busy, status, focusRequest, onMove, onEdit, onToggle }: { t: FollowUpTypeVm; position: number; total: number; busy: boolean; status: RowStatus; focusRequest: { id: string; control: OrderControl; n: number } | null; onMove: (d: -1 | 1) => void; onEdit: () => void; onToggle: () => void }) {
  const { isDragging, rowProps, gripProps } = useSortableRow(t.id, busy || !t.isActive, { status, archived: !t.isActive });
  return (
    <li {...rowProps} className={`${rowProps.className} flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2`} data-testid={`followup-type-row-${t.key}`}>
      <RowOrderControls
        rowId={t.id}
        label={t.label}
        position={position}
        total={total}
        disabled={!t.isActive}
        locked={busy}
        dragging={isDragging}
        gripProps={gripProps}
        onMove={onMove}
        focusRequest={focusRequest}
        ids={{ drag: `followup-type-drag-${t.key}`, up: `followup-type-up-${t.key}`, down: `followup-type-down-${t.key}` }}
      />
      <button type="button" onClick={onEdit} className="min-w-0 flex-1 basis-40 text-left max-md:flex max-md:min-h-11 max-md:flex-col max-md:justify-center" aria-label={`Edit ${t.label}`}>
        <span className="block truncate text-sm font-medium text-ink">{t.label}</span>
        <span className="block truncate text-[11px] text-ink-2">
          {BEHAVIOUR_LABEL.get(t.canonicalTaskType) ?? "Follow-up"} · {t.departmentName ?? "All departments"}
        </span>
      </button>
      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
        {t.defaultPriority === "high" && <Badge tone="warning">High priority</Badge>}
        {t.requiresNote && <Badge tone="neutral">Needs a note</Badge>}
        {!t.isActive && <Badge tone="warning">Archived</Badge>}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button size="sm" variant="ghost" className="min-h-11 sm:min-h-0" onClick={onEdit}>
          Edit
        </Button>
        <Button size="sm" variant="ghost" className="min-h-11 sm:min-h-0" onClick={onToggle} disabled={busy} data-testid={`followup-type-toggle-${t.key}`}>
          {t.isActive ? "Archive" : "Restore"}
        </Button>
      </div>
    </li>
  );
}

/**
 * Settings → Follow-up Types. The names staff pick when they schedule work on a journey. Each one behaves like a stable
 * kind of task underneath, so renaming or adding types never disturbs My Work, reports or history. Archive hides a type
 * from new follow-ups; tasks already scheduled keep their label.
 */
export function FollowUpTypesSection() {
  const queryClient = useQueryClient();
  const types = useQuery({ queryKey: ["followup-types", "all"], queryFn: () => api.followUpTypes({ includeInactive: true }) });
  const [editing, setEditing] = useState<FollowUpTypeVm | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["followup-types"] });
  const list = types.data ?? [];

  async function toggle(t: FollowUpTypeVm) {
    setBusy(true);
    setError(null);
    try {
      await api.updateFollowUpType(t.id, { isActive: !t.isActive });
      refresh();
    } catch (err) {
      setError(SAVE_ERRORS[err instanceof ApiError ? err.message : ""] ?? "Couldn't update that type — try again.");
    } finally {
      setBusy(false);
    }
  }

  const labelOf = useCallback((id: string) => (types.data ?? []).find((t) => t.id === id)?.label ?? "Follow-up type", [types.data]);
  const saveOrder = useCallback((_group: "all", ids: string[]) => api.reorderFollowUpTypes(ids), []);
  const sort = useReorder<"all">({ save: saveOrder, refresh, label: labelOf });
  const shown = sort.ordered("all", list);
  // Only active types are ordered; an archived neighbour is never a swap partner and never counted in positions.
  const active = shown.filter((x) => x.isActive);

  return (
    <div className="space-y-3" data-testid="followup-types-section">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-ink-2">Staff choose from these when they add a follow-up to a journey.</p>
        <Button size="sm" variant="primary" className="min-h-11 sm:min-h-0" onClick={() => setEditing("new")} data-testid="followup-type-add">
          <Plus size={14} aria-hidden="true" /> Add type
        </Button>
      </div>
      <FormError message={error ?? sort.error} />
      <ReorderStatus message={sort.announcement} />
      {types.isLoading && <Skeleton className="h-40" />}
      {types.isError && <ErrorState message="Could not load follow-up types." />}
      {types.data && list.length === 0 && <EmptyState message="No follow-up types yet" />}
      {list.length > 0 && (
        <SortableGroup items={active.map((t) => ({ id: t.id, label: t.label }))} onReorder={(ids, moved) => void sort.reorder("all", ids, moved, "grip", active.map((t) => t.id))}>
          <ul className="divide-y divide-line overflow-hidden rounded-card border border-line bg-surface" aria-label="Follow-up types" aria-busy={sort.isSaving("all")} data-testid="followup-type-list">
            {shown.map((t) => {
              const i = active.findIndex((x) => x.id === t.id);
              return (
              <TypeRow
                key={t.id}
                t={t}
                position={i + 1}
                total={active.length}
                busy={busy || sort.isSaving("all")}
                status={sort.statusOf(t.id)}
                focusRequest={sort.focusRequest}
                onMove={(d) => {
                  const ids = active.map((x) => x.id);
                  const j = i + d;
                  if (i < 0 || j < 0 || j >= ids.length) return;
                  [ids[i], ids[j]] = [ids[j]!, ids[i]!];
                  void sort.reorder("all", ids, t.id, d < 0 ? "up" : "down", active.map((x) => x.id));
                }}
                onEdit={() => setEditing(t)}
                onToggle={() => toggle(t)}
              />
              );
            })}
          </ul>
        </SortableGroup>
      )}
      {editing && (
        <TypeSheet
          existing={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}
