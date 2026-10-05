"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@pulseos/api-client";
import { Badge, Button, EmptyState, ErrorState, Skeleton, SideSheet } from "@pulseos/ui";
import type { DepartmentTemplateVm, DepartmentVm } from "@pulseos/types";
import { FormError, TextInput } from "./FormBits";

/** Everything that a department install or edit can change, so the rest of the app picks it up straight away. */
function useRefreshDepartments() {
  const queryClient = useQueryClient();
  return () => {
    for (const key of ["departments", "department-templates", "specialties-admin", "specialties", "crm-fields", "lead-sources"]) queryClient.invalidateQueries({ queryKey: [key] });
  };
}

function RenameSheet({ department, onClose, onSaved }: { department: DepartmentVm; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(department.displayName);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const next = name.trim();
    if (!next) return setError("Give the department a name.");
    setSaving(true);
    setError(null);
    try {
      await api.updateDepartment(department.id, { displayName: next });
      onSaved();
    } catch {
      setError("Couldn't save the new name — it's still here, try again.");
      setSaving(false);
    }
  }

  return (
    <SideSheet
      title="Rename department"
      subtitle="Only your hospital sees this name"
      onClose={onClose}
      testId="department-editor"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving} data-testid="department-save">
            {saving ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <TextInput label="Department name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} data-testid="department-name-input" />
        <FormError message={error} />
      </div>
    </SideSheet>
  );
}

function DepartmentCard({ department, onRename, onToggleArchive, busy }: { department: DepartmentVm; onRename: () => void; onToggleArchive: () => void; busy: boolean }) {
  return (
    <li className={`px-4 py-3 ${department.archived ? "bg-neutral-50" : ""}`} data-testid={`department-${department.key}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <div className="min-w-0 flex-1 basis-48">
          <p className="truncate text-sm font-semibold text-ink">{department.displayName}</p>
          <p className="text-[11px] text-ink-2">{department.services.length} service{department.services.length === 1 ? "" : "s"}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {department.templateKey && <Badge tone="primary">From template</Badge>}
          {department.archived && <Badge tone="warning">Archived</Badge>}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button size="sm" variant="ghost" onClick={onRename} data-testid={`department-rename-${department.key}`}>
            Rename
          </Button>
          <Button size="sm" variant="ghost" onClick={onToggleArchive} disabled={busy} data-testid={`department-archive-${department.key}`}>
            {department.archived ? "Restore" : "Archive"}
          </Button>
        </div>
      </div>
      {department.services.length > 0 && (
        <p className="mt-1.5 text-xs text-ink-2" data-testid={`department-services-${department.key}`}>
          {department.services.map((s) => s.displayName).join(" · ")}
        </p>
      )}
      {department.archived && <p className="mt-1.5 text-[11px] text-ink-2">Its services are not offered for new enquiries. Existing patients and journeys are unaffected.</p>}
    </li>
  );
}

/**
 * Settings → Departments. A department is installed from a ready-made template: the hospital gets its OWN copy
 * of the services, fields and treatments, and from then on edits only that copy. Installing again is always safe —
 * it adds what is missing and never undoes your changes.
 */
export function DepartmentsSection() {
  const refresh = useRefreshDepartments();
  const departments = useQuery({ queryKey: ["departments"], queryFn: api.departments });
  const templates = useQuery({ queryKey: ["department-templates"], queryFn: api.departmentTemplates });
  const [renaming, setRenaming] = useState<DepartmentVm | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function install(t: DepartmentTemplateVm) {
    setInstalling(t.key);
    setMessage(null);
    setError(null);
    try {
      const res = await api.installDepartment(t.key);
      setMessage(res.created ? `${t.displayName} installed. Its services and fields are ready to use.` : `${t.displayName} was already installed — anything missing was added back, your changes were kept.`);
      refresh();
    } catch (err) {
      setError(err instanceof ApiError && err.status === 403 ? "Only an Admin can install departments." : `Couldn't install ${t.displayName} — try again.`);
    } finally {
      setInstalling(null);
    }
  }

  async function toggleArchive(d: DepartmentVm) {
    setBusyId(d.id);
    setError(null);
    try {
      await api.updateDepartment(d.id, { archived: !d.archived });
      refresh();
    } catch {
      setError("Couldn't update that department — try again.");
    } finally {
      setBusyId(null);
    }
  }

  const installedKeys = new Set((departments.data ?? []).map((d) => d.templateKey).filter(Boolean));
  const available = (templates.data ?? []).filter((t) => !installedKeys.has(t.key));

  return (
    <div className="space-y-4" data-testid="departments-section">
      {message && (
        <p role="status" className="rounded-control border border-line bg-surface-info px-3 py-2 text-xs text-ink" data-testid="department-message">
          {message}
        </p>
      )}
      <FormError message={error} testId="department-error" />

      {departments.isLoading && <Skeleton className="h-24" />}
      {departments.isError && <ErrorState message="Could not load departments." />}
      {departments.data && departments.data.length === 0 && <EmptyState message="No department yet" hint="Install a template below to start with ready-made services and fields." />}
      {departments.data && departments.data.length > 0 && (
        <ul className="divide-y divide-line overflow-hidden rounded-card border border-line bg-surface" data-testid="department-list">
          {departments.data.map((d) => (
            <DepartmentCard key={d.id} department={d} busy={busyId === d.id} onRename={() => setRenaming(d)} onToggleArchive={() => toggleArchive(d)} />
          ))}
        </ul>
      )}

      <div>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-2">Add a department</h3>
        {templates.isLoading && <Skeleton className="h-16" />}
        {templates.isError && <ErrorState message="Could not load templates." />}
        {templates.data && available.length === 0 && <p className="text-xs text-ink-2">Every available template is installed.</p>}
        {available.length > 0 && (
          <ul className="space-y-2" data-testid="department-templates">
            {available.map((t) => (
              <li key={t.key} className="flex flex-wrap items-center gap-3 rounded-card border border-line bg-surface px-4 py-3" data-testid={`department-template-${t.key}`}>
                <div className="min-w-0 flex-1 basis-56">
                  <p className="text-sm font-semibold text-ink">{t.displayName}</p>
                  <p className="text-xs text-ink-2">{t.description}</p>
                  <p className="mt-1 text-[11px] text-ink-2">Includes: {t.services.join(", ")}</p>
                </div>
                <Button size="sm" variant="primary" onClick={() => install(t)} disabled={installing !== null} data-testid={`department-install-${t.key}`}>
                  {installing === t.key ? "Installing…" : "Install defaults"}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {renaming && (
        <RenameSheet
          department={renaming}
          onClose={() => setRenaming(null)}
          onSaved={() => {
            setRenaming(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}
