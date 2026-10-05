"use client";

import { useCallback, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { api, ApiError } from "@pulseos/api-client";
import { Badge, Button, ErrorState, SOURCE_LABELS, Skeleton, SideSheet } from "@pulseos/ui";
import type { LeadSourceVm, SourceChannel } from "@pulseos/types";
import { FormError, SelectInput, TextInput } from "./FormBits";
import { ReorderStatus, RowOrderControls, SortableGroup, useReorder, useSortableRow, type OrderControl, type RowStatus } from "./SortableList";

const BUCKETS = Object.keys(SOURCE_LABELS) as SourceChannel[];

function SourceSheet({ source, onClose, onSaved }: { source: LeadSourceVm | null; onClose: () => void; onSaved: () => void }) {
  const [label, setLabel] = useState(source?.label ?? "");
  const [bucket, setBucket] = useState<SourceChannel>(source?.bucket ?? "other");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const name = label.trim();
    if (!name) return setError("Give the source a name.");
    setSaving(true);
    setError(null);
    try {
      if (source) await api.updateLeadSource(source.id, { label: name, bucket });
      else await api.createLeadSource({ label: name, bucket });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError && err.status === 409 ? "You already have a source with that name." : "Couldn't save this source — what you typed is still here. Try again.");
      setSaving(false);
    }
  }

  return (
    <SideSheet
      title={source ? "Edit source" : "Add source"}
      subtitle="Where patients originally come from"
      onClose={onClose}
      testId="source-editor"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving} data-testid="source-save">
            {saving ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <TextInput label="Source name" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} placeholder="e.g. Newspaper ad" data-testid="source-name-input" />
        <SelectInput label="Report it under" hint="Reports and campaign views group sources by platform. Pick the closest one." value={bucket} onChange={(e) => setBucket(e.target.value as SourceChannel)} data-testid="source-bucket-select">
          {BUCKETS.map((b) => (
            <option key={b} value={b}>
              {SOURCE_LABELS[b]}
            </option>
          ))}
        </SelectInput>
        <FormError message={error} />
      </div>
    </SideSheet>
  );
}

function SourceRow({ s, position, total, locked, status, focusRequest, busy, onMove, onEdit, onToggle }: { s: LeadSourceVm; position: number; total: number; locked: boolean; status: RowStatus; focusRequest: { id: string; control: OrderControl; n: number } | null; busy: boolean; onMove: (d: -1 | 1) => void; onEdit: () => void; onToggle: () => void }) {
  const { isDragging, rowProps, gripProps } = useSortableRow(s.id, s.archived || locked, { status, archived: s.archived });
  return (
    <li {...rowProps} className={`${rowProps.className} flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2`} data-testid={`source-row-${s.key}`}>
      <RowOrderControls
        rowId={s.id}
        label={s.label}
        position={position}
        total={total}
        disabled={s.archived}
        locked={locked}
        dragging={isDragging}
        gripProps={gripProps}
        onMove={onMove}
        focusRequest={focusRequest}
        ids={{ drag: `source-drag-${s.key}`, up: `source-move-up-${s.key}`, down: `source-move-down-${s.key}` }}
      />
      <div className="min-w-0 flex-1 basis-40 max-md:min-h-11 max-md:py-1">
        <p className="truncate text-sm font-medium text-ink">{s.label}</p>
        <p className="text-[11px] text-ink-2">Reported under {SOURCE_LABELS[s.bucket]}</p>
      </div>
      {s.archived && <Badge tone="warning">Archived</Badge>}
      <div className="flex shrink-0 items-center gap-1">
        <Button size="sm" variant="ghost" onClick={onEdit} data-testid={`source-edit-${s.key}`}>
          Edit
        </Button>
        <Button size="sm" variant="ghost" onClick={onToggle} disabled={busy} data-testid={`source-archive-${s.key}`}>
          {s.archived ? "Restore" : "Archive"}
        </Button>
      </div>
    </li>
  );
}

/**
 * Settings → Lead Sources: the places patients originally come from. This is separate from HOW someone gets in
 * touch (a phone call, a WhatsApp message, a walk-in) — a patient who found you on Instagram and later phones
 * is still an Instagram patient. Archiving hides a source from new enquiries but keeps it on existing ones.
 */
export function LeadSourcesSection() {
  const queryClient = useQueryClient();
  const sources = useQuery({ queryKey: ["lead-sources", "all"], queryFn: () => api.leadSources({ includeArchived: true }) });
  const [editing, setEditing] = useState<LeadSourceVm | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["lead-sources"] });
  // The order here is the order Staff see in Add Lead: one shared drag / arrow / announce path with the other Settings lists.
  const labelOf = useCallback((id: string) => sources.data?.find((x) => x.id === id)?.label ?? "Source", [sources.data]);
  const saveOrder = useCallback((_g: "all", ids: string[]) => api.reorderLeadSources(ids), []);
  const sort = useReorder<"all">({ save: saveOrder, refresh, label: labelOf });
  const shown = sort.ordered("all", sources.data ?? []);
  const active = shown.filter((x) => !x.archived);

  async function toggleArchive(s: LeadSourceVm) {
    setBusyId(s.id);
    setError(null);
    try {
      await api.updateLeadSource(s.id, { archived: !s.archived });
      refresh();
    } catch {
      setError("Couldn't update that source — try again.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-3" data-testid="lead-sources-section">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-ink-2">Staff pick from these when they add an enquiry.</p>
        <Button size="sm" variant="primary" onClick={() => setEditing("new")} data-testid="source-add">
          <Plus size={14} aria-hidden="true" /> Add source
        </Button>
      </div>
      <FormError message={error ?? sort.error} />
      <ReorderStatus message={sort.announcement} />
      {sources.isLoading && <Skeleton className="h-32" />}
      {sources.isError && <ErrorState message="Could not load sources." />}
      {sources.data && (
        <SortableGroup items={active.map((x) => ({ id: x.id, label: x.label }))} onReorder={(ids, moved) => void sort.reorder("all", ids, moved, "grip", active.map((x) => x.id))}>
          <ul className="divide-y divide-line overflow-hidden rounded-card border border-line bg-surface" aria-label="Lead sources" aria-busy={sort.isSaving("all")} data-testid="source-list">
            {shown.map((src) => {
              const i = active.findIndex((x) => x.id === src.id);
              return (
                <SourceRow
                  key={src.id}
                  s={src}
                  position={i + 1}
                  total={active.length}
                  locked={sort.isSaving("all")}
                  status={sort.statusOf(src.id)}
                  focusRequest={sort.focusRequest}
                  busy={busyId === src.id}
                  onMove={(d) => {
                    const ids = active.map((x) => x.id);
                    const j = i + d;
                    if (j < 0 || j >= ids.length) return;
                    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
                    void sort.reorder("all", ids, src.id, d < 0 ? "up" : "down", active.map((x) => x.id));
                  }}
                  onEdit={() => setEditing(src)}
                  onToggle={() => toggleArchive(src)}
                />
              );
            })}
          </ul>
        </SortableGroup>
      )}
      {editing && (
        <SourceSheet
          source={editing === "new" ? null : editing}
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
