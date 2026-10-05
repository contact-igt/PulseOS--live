"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { api, ApiError } from "@pulseos/api-client";
import { Badge, Button, EmptyState, ErrorState, SideSheet, Skeleton } from "@pulseos/ui";
import type { ScheduleResourceVm } from "@pulseos/types";
import { FormError, SelectInput, TextInput } from "./FormBits";

const SAVE_ERRORS: Record<string, string> = {
  department_invalid: "That department no longer exists.",
  invalid_request: "Give the doctor a name.",
};

function ResourceSheet({ existing, onClose, onSaved }: { existing: ScheduleResourceVm | null; onClose: () => void; onSaved: () => void }) {
  const departments = useQuery({ queryKey: ["departments"], queryFn: api.departments });
  const [name, setName] = useState(existing?.name ?? "");
  const [departmentId, setDepartmentId] = useState(existing?.departmentId ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const trimmed = name.trim();
    if (!trimmed) return setError("Give the doctor a name.");
    setSaving(true);
    setError(null);
    try {
      const body = { name: trimmed, departmentId: departmentId || null };
      if (existing) await api.updateResource(existing.id, body);
      else await api.createResource(body);
      onSaved();
    } catch (err) {
      setError(SAVE_ERRORS[err instanceof ApiError ? err.message : ""] ?? "Couldn't save — what you typed is still here. Try again.");
      setSaving(false);
    }
  }

  return (
    <SideSheet
      title={existing ? "Edit doctor" : "Add doctor"}
      subtitle="Someone appointments and surgeries can be scheduled with"
      onClose={onClose}
      testId="resource-editor"
      footer={
        <>
          <Button variant="secondary" className="min-h-11 sm:min-h-0" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button className="min-h-11 sm:min-h-0" onClick={save} disabled={saving} data-testid="resource-save">
            {saving ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <TextInput label="Name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="e.g. Dr Anand Kulkarni" data-testid="resource-name" />
        <SelectInput label="Department" hint="Optional." value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} data-testid="resource-department">
          <option value="">Any department</option>
          {(departments.data ?? []).map((d) => (
            <option key={d.id} value={d.id}>
              {d.displayName}
            </option>
          ))}
        </SelectInput>
        {existing && !existing.hasLogin && <p className="text-[11px] text-ink-2">This doctor does not have a PulseOS login — they can still be booked.</p>}
        <FormError message={error} />
      </div>
    </SideSheet>
  );
}

/**
 * Settings → Doctors. The people appointments and surgeries are scheduled with. A doctor does not need a PulseOS
 * login to appear here: visiting surgeons and doctors who never sign in can be booked like anyone else. Archiving hides
 * a doctor from new bookings; their past appointments keep their name.
 */
export function ResourcesSection() {
  const queryClient = useQueryClient();
  const resources = useQuery({ queryKey: ["resources", "all"], queryFn: () => api.resources({ includeInactive: true }) });
  const [editing, setEditing] = useState<ScheduleResourceVm | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["resources"] });
    queryClient.invalidateQueries({ queryKey: ["lookups"] });
  };
  const list = resources.data ?? [];

  async function toggle(r: ScheduleResourceVm) {
    setBusy(true);
    setError(null);
    try {
      await api.updateResource(r.id, { isActive: !r.isActive });
      refresh();
    } catch {
      setError("Couldn't update that doctor — try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3" data-testid="resources-section">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-ink-2">Staff pick from these when they book an appointment or schedule a surgery.</p>
        <Button size="sm" variant="primary" className="min-h-11 sm:min-h-0" onClick={() => setEditing("new")} data-testid="resource-add">
          <Plus size={14} aria-hidden="true" /> Add doctor
        </Button>
      </div>
      <FormError message={error} />
      {resources.isLoading && <Skeleton className="h-40" />}
      {resources.isError && <ErrorState message="Could not load doctors." />}
      {resources.data && list.length === 0 && <EmptyState message="No doctors yet" />}
      {list.length > 0 && (
        <ul className="divide-y divide-line overflow-hidden rounded-card border border-line bg-surface" data-testid="resource-list">
          {list.map((r) => (
            <li key={r.id} className={`flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 ${r.isActive ? "" : "bg-neutral-50 text-ink-2"}`} data-testid={`resource-row-${r.id}`}>
              <button type="button" onClick={() => setEditing(r)} className="min-w-0 flex-1 basis-40 text-left max-md:flex max-md:min-h-11 max-md:flex-col max-md:justify-center" aria-label={`Edit ${r.name}`}>
                <span className="block truncate text-sm font-medium text-ink">{r.name}</span>
                <span className="block truncate text-[11px] text-ink-2">{r.departmentName ?? "Any department"}</span>
              </button>
              <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                <Badge tone={r.hasLogin ? "primary" : "neutral"}>{r.hasLogin ? "Has a login" : "No login"}</Badge>
                {!r.isActive && <Badge tone="warning">Archived</Badge>}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button size="sm" variant="ghost" className="min-h-11 sm:min-h-0" onClick={() => setEditing(r)}>
                  Edit
                </Button>
                <Button size="sm" variant="ghost" className="min-h-11 sm:min-h-0" onClick={() => toggle(r)} disabled={busy} data-testid={`resource-toggle-${r.id}`}>
                  {r.isActive ? "Archive" : "Restore"}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <ResourceSheet
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
