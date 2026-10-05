"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@pulseos/api-client";
import { Badge, ErrorState, Panel, Skeleton, Tabs } from "@pulseos/ui";
import { hasPermission } from "@pulseos/types";
import { CrmFieldsSection } from "@/components/settings/CrmFieldsSection";
import { DepartmentsSection } from "@/components/settings/DepartmentsSection";
import { FollowUpTypesSection } from "@/components/settings/FollowUpTypesSection";
import { ResourcesSection } from "@/components/settings/ResourcesSection";
import { ClinicHoursSection } from "@/components/settings/ClinicHoursSection";
import { LeadSourcesSection } from "@/components/settings/LeadSourcesSection";
import { OutcomesSection } from "@/components/outcomes/OutcomesSection";
import { ActivitySection } from "@/components/settings/ActivitySection";
import { RemindersSection } from "@/components/settings/RemindersSection";
import { FeaturesSection } from "@/components/settings/FeaturesSection";
import { AppearanceSection } from "@/components/settings/AppearanceSection";
import { AllocationSection } from "@/components/allocation/AllocationSection";
import { useUrlFilters } from "@/lib/useUrlFilters";
import { useCapability } from "@/lib/useEdition";

type Section = "services" | "departments" | "fields" | "sources" | "outcomes" | "followups" | "doctors" | "hours" | "allocation" | "features" | "reminders" | "appearance" | "activity";
const SECTIONS: { key: Section; label: string; manageOnly: boolean }[] = [
  { key: "services", label: "Services", manageOnly: false },
  { key: "departments", label: "Departments", manageOnly: true },
  { key: "fields", label: "CRM Fields", manageOnly: true },
  { key: "sources", label: "Lead Sources", manageOnly: true },
  { key: "outcomes", label: "Workflow Outcomes", manageOnly: true },
  { key: "followups", label: "Follow-up Types", manageOnly: true },
  { key: "doctors", label: "Doctors", manageOnly: true },
  { key: "hours", label: "Clinic Hours", manageOnly: true },
  { key: "allocation", label: "Allocation Rules", manageOnly: true },
  { key: "features", label: "Features", manageOnly: true },
  { key: "reminders", label: "Reminders", manageOnly: true },
  { key: "appearance", label: "Appearance", manageOnly: true },
  { key: "activity", label: "Activity", manageOnly: true },
];

/** Add a service the hospital offers (e.g. a new kind of enquiry). It appears in Add Lead, filters and reports at once and can get its own CRM fields. */
function AddServiceForm({ onAdded }: { onAdded: () => void }) {
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function add() {
    const displayName = name.trim();
    if (!displayName || saving) return;
    setSaving(true);
    setError(null);
    try {
      await api.createSpecialty({ displayName });
      setName("");
      onAdded();
    } catch (e) {
      setError((e as { message?: string }).message === "service_exists" ? "That service already exists." : "Could not add the service - what you typed is still here. Try again.");
    } finally {
      setSaving(false);
    }
  }
  return (
    <form
      className="mb-3 flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void add();
      }}
      data-testid="add-service-form"
    >
      <label className="min-w-48 flex-1 text-xs font-medium text-ink">
        Add a service
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={60}
          placeholder="e.g. Glaucoma check"
          className="mt-1 h-11 w-full rounded-control border border-line-strong bg-surface px-3 text-sm text-ink outline-none focus:border-primary-500 sm:h-9"
          data-testid="add-service-name"
        />
      </label>
      <button type="submit" disabled={!name.trim() || saving} className="h-11 rounded-control bg-primary-600 px-4 text-xs font-semibold text-white transition hover:bg-primary-700 disabled:cursor-not-allowed disabled:bg-primary-200 sm:h-9" data-testid="add-service-save">
        {saving ? "Adding…" : "Add service"}
      </button>
      {error && (
        <p role="alert" className="basis-full text-xs text-danger-700" data-testid="add-service-error">
          {error}
        </p>
      )}
    </form>
  );
}

/** A service's name and default Journey type. Its CRM fields live in the CRM Fields section. */
function ServiceDetail({ specialtyKey, onManageFields }: { specialtyKey: string; onManageFields: () => void }) {
  const queryClient = useQueryClient();
  const detail = useQuery({ queryKey: ["specialty-detail", specialtyKey], queryFn: () => api.specialtyDetail(specialtyKey) });
  // A save failure must never look like it silently succeeded: inputs keep what was typed (uncontrolled
  // defaultValue is untouched on error), so the only missing piece is saying it didn't persist.
  const [saveError, setSaveError] = useState<string | null>(null);

  async function saveHeader(input: { displayName?: string; defaultJourneyType?: string }) {
    try {
      setSaveError(null);
      await api.updateSpecialty(specialtyKey, input);
      queryClient.invalidateQueries({ queryKey: ["specialty-detail", specialtyKey] });
      queryClient.invalidateQueries({ queryKey: ["specialties-admin"] });
      queryClient.invalidateQueries({ queryKey: ["specialties"] });
    } catch {
      setSaveError("Could not save that change — your entry is still here, try again.");
    }
  }

  if (detail.isLoading) return <Skeleton className="h-20" />;
  if (detail.isError || !detail.data) return <ErrorState message="Could not load this service." />;
  const d = detail.data;

  return (
    <div className="space-y-3 border-t border-line p-4">
      {saveError && (
        <p className="rounded-control border border-danger-100 bg-danger-100/60 px-2.5 py-1.5 text-xs text-danger-700" data-testid="specialty-save-error">
          {saveError}
        </p>
      )}
      <div className="flex flex-wrap items-end gap-4 text-xs">
        <label className="flex flex-col gap-1">
          <span className="text-ink-2">Display label</span>
          <input
            type="text"
            defaultValue={d.displayName}
            onBlur={(e) => {
              const next = e.target.value.trim();
              if (next && next !== d.displayName) saveHeader({ displayName: next });
            }}
            className="h-11 rounded-control border border-line-strong bg-surface px-2 text-sm text-ink outline-none focus:border-primary-500 sm:h-8 sm:text-xs"
            data-testid="specialty-display-label"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-ink-2">Default Journey type</span>
          <input
            type="text"
            defaultValue={d.defaultJourneyType}
            onBlur={(e) => {
              const next = e.target.value.trim();
              if (next && next !== d.defaultJourneyType) saveHeader({ defaultJourneyType: next });
            }}
            className="h-11 rounded-control border border-line-strong bg-surface px-2 text-sm text-ink outline-none focus:border-primary-500 sm:h-8 sm:text-xs"
            data-testid="specialty-default-journey-type"
          />
        </label>
        <button type="button" onClick={onManageFields} className="min-h-11 text-xs font-medium text-primary-700 hover:underline sm:min-h-0 sm:pb-1.5" data-testid="specialty-manage-fields">
          Manage {d.fieldCount} CRM field{d.fieldCount === 1 ? "" : "s"} →
        </button>
      </div>
    </div>
  );
}

export default function SettingsPage() {
  const queryClient = useQueryClient();
  const urlFilters = useUrlFilters();
  const session = useQuery({ queryKey: ["session"], queryFn: api.session });
  // MANAGE_SPECIALTIES gates every write server-side (Hospital/Super Admin only) — mirrored here only to keep
  // read-only roles from seeing controls that would 403, never as the actual authorization boundary.
  const canManage = !!session.data && hasPermission(session.data.user.role, "MANAGE_SPECIALTIES");
  const specialties = useQuery({ queryKey: ["specialties-admin"], queryFn: () => api.specialties(true) });
  const [expanded, setExpanded] = useState<string | null>(null);

  const whatsappOn = useCapability("WHATSAPP_NOTIFICATIONS");
  const visible = SECTIONS.filter((s) => (canManage || !s.manageOnly) && (s.key !== "reminders" || whatsappOn));
  const requested = urlFilters.get("section");
  const section: Section = visible.find((s) => s.key === requested)?.key ?? "services";

  async function toggleEnabled(key: string, enabled: boolean) {
    await api.updateSpecialty(key, { enabled: !enabled });
    queryClient.invalidateQueries({ queryKey: ["specialties-admin"] });
    queryClient.invalidateQueries({ queryKey: ["specialties"] });
  }

  return (
    <div className="mx-auto max-w-4xl space-y-5" data-testid="settings-page">
      {visible.length > 1 && <Tabs variant="underline" ariaLabel="Settings sections" value={section} onChange={(k) => urlFilters.set({ section: k === "services" ? undefined : k, service: undefined })} items={visible.map((s) => ({ key: s.key, label: s.label, testId: `settings-tab-${s.key}` }))} />}

      {section === "departments" && canManage && (
        <Panel title="Departments" subtitle="Install a ready-made department, then make it yours">
          <DepartmentsSection />
        </Panel>
      )}
      {section === "sources" && canManage && (
        <Panel title="Lead Sources" subtitle="Where patients originally come from">
          <LeadSourcesSection />
        </Panel>
      )}
      {section === "fields" && canManage && (
        <Panel title="CRM Fields" subtitle="What you capture about each enquiry, and where it appears">
          {specialties.isLoading && <Skeleton className="h-24" />}
          {specialties.isError && <ErrorState message="Could not load services." />}
          {specialties.data && <CrmFieldsSection services={specialties.data} />}
        </Panel>
      )}

      {section === "outcomes" && canManage && (
        <Panel title="Workflow Outcomes" subtitle="What staff can record after a call or follow-up">
          <OutcomesSection />
        </Panel>
      )}

      {section === "doctors" && canManage && (
        <Panel title="Doctors" subtitle="Who appointments and surgeries are scheduled with">
          <ResourcesSection />
        </Panel>
      )}
      {section === "hours" && canManage && (
        <Panel title="Clinic Hours" subtitle="When appointments can be booked. Booking, the Front Desk and the Doctor Planner all use this">
          <ClinicHoursSection />
        </Panel>
      )}
      {section === "followups" && canManage && (
        <Panel title="Follow-up Types" subtitle="The kinds of follow-up staff can schedule">
          <FollowUpTypesSection />
        </Panel>
      )}
      {section === "allocation" && canManage && (
        <Panel title="Allocation Rules" subtitle="Which team member a new enquiry is assigned to">
          {specialties.data ? <AllocationSection services={specialties.data} /> : <Skeleton className="h-24" />}
        </Panel>
      )}

      {section === "features" && canManage && (
        <Panel title="Features" subtitle="What this hospital can use — enabled, configured and healthy are separate">
          <FeaturesSection />
        </Panel>
      )}

      {section === "activity" && canManage && (
        <Panel title="Activity" subtitle="Who changed which setting, and when">
          <ActivitySection />
        </Panel>
      )}
      {section === "appearance" && canManage && (
        <Panel title="Appearance" subtitle="How solid the interface looks for everyone in this hospital">
          <AppearanceSection />
        </Panel>
      )}
      {section === "reminders" && canManage && (
        <Panel title="Reminders" subtitle="When appointment and surgery messages go out, and what they say">
          <RemindersSection />
        </Panel>
      )}

      {section === "services" && (
        <Panel title="Services" subtitle="Which services Add Lead offers">
          {(specialties.isLoading || session.isLoading) && <div className="space-y-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-12" />)}</div>}
          {specialties.isError && <ErrorState message="Could not load specialties." />}
          {canManage && (
            <AddServiceForm
              onAdded={() => {
                queryClient.invalidateQueries({ queryKey: ["specialties-admin"] });
                queryClient.invalidateQueries({ queryKey: ["specialties"] });
              }}
            />
          )}
          {specialties.data && !session.isLoading && (
            <ul className="divide-y divide-line rounded-control border border-line" data-testid="specialty-list">
              {specialties.data.map((s) => (
                <li key={s.key}>
                  <div className="flex items-center justify-between px-4 py-3">
                    {canManage ? (
                      <button type="button" onClick={() => setExpanded(expanded === s.key ? null : s.key)} className="flex min-h-11 min-w-0 flex-1 items-center gap-3 text-left sm:min-h-0">
                        <span className="text-sm font-medium text-ink">{s.displayName}</span>
                        <Badge tone={s.enabled ? "success" : "neutral"}>{s.enabled ? "Enabled" : "Disabled"}</Badge>
                        <span className="min-w-0 truncate text-xs text-ink-2">{s.fieldCount} custom field{s.fieldCount === 1 ? "" : "s"}</span>
                      </button>
                    ) : (
                      <div className="flex min-h-11 min-w-0 flex-1 items-center gap-3 text-left sm:min-h-0">
                        <span className="text-sm font-medium text-ink">{s.displayName}</span>
                        <Badge tone={s.enabled ? "success" : "neutral"}>{s.enabled ? "Enabled" : "Disabled"}</Badge>
                        <span className="min-w-0 truncate text-xs text-ink-2">{s.fieldCount} custom field{s.fieldCount === 1 ? "" : "s"}</span>
                      </div>
                    )}
                    {canManage && (
                      <div className="flex shrink-0 items-center gap-3">
                        <button type="button" onClick={() => toggleEnabled(s.key, s.enabled)} className="min-h-11 text-xs font-medium text-primary-700 hover:underline sm:min-h-0" data-testid={`specialty-toggle-${s.key}`}>
                          {s.enabled ? "Disable" : "Enable"}
                        </button>
                        <button type="button" onClick={() => setExpanded(expanded === s.key ? null : s.key)} className="min-h-11 text-xs text-ink-2 hover:text-ink sm:min-h-0">
                          {expanded === s.key ? "Close" : "Edit"}
                        </button>
                      </div>
                    )}
                  </div>
                  {canManage && expanded === s.key && <ServiceDetail specialtyKey={s.key} onManageFields={() => urlFilters.set({ section: "fields", service: s.key })} />}
                </li>
              ))}
            </ul>
          )}
        </Panel>
      )}
    </div>
  );
}
