"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { platformApi } from "@pulseos/api-client";
import { Button, Skeleton, Tabs } from "@pulseos/ui";
import { TENANT_TRANSITIONS, lifecycleActionsFor, type PlatformTenantDetail, type TenantEnvironment, type TenantLifecycleAction } from "@pulseos/types";
import { useUrlFilters } from "../../../../../lib/useUrlFilters";
import { CONTROL, FormField } from "../../../../../components/settings/FormBits";
import { ActionDialog, EnvironmentBadge, ErrorPanel, PlatformPage, TenantStatusBadge } from "../../../../../components/platform/ui";
import { usePlatformUser } from "../../../../../components/platform/usePlatformUser";
import { TenantOverviewTab } from "../../../../../components/platform/tenant/TenantOverviewTab";
import { TenantConfigTab } from "../../../../../components/platform/tenant/TenantConfigTab";
import { TenantIntegrationsTab } from "../../../../../components/platform/tenant/TenantIntegrationsTab";
import { TenantBrandingTab } from "../../../../../components/platform/tenant/TenantBrandingTab";
import { TenantUsageTab } from "../../../../../components/platform/tenant/TenantUsageTab";
import { TENANT_EXTRA_TABS } from "../../../../../components/platform/tenant/extraTabs";

const LIFECYCLE_COPY: Record<TenantLifecycleAction, string> = {
  START_ONBOARDING: "Staff of this tenant will be able to sign in while implementation continues.",
  ACTIVATE: "The tenant goes live. Its staff can sign in and use PulseOS.",
  SUSPEND: "Every staff member is signed out immediately and cannot sign in. All data is kept and platform support access still works. Inbound integrations keep recording enquiries; automated messages follow the tenant's capabilities — switch notifications off under Modules & Capabilities to stop them.",
  REACTIVATE: "Staff can sign in again. Nothing was deleted while it was unavailable.",
  ARCHIVE: "The tenant becomes an inactive historical account. Sign-in stays blocked; data is kept. It can be reactivated later.",
};

function EditDetailsDialog({ detail, open, onClose }: { detail: PlatformTenantDetail; open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const t = detail.tenant;
  const [form, setForm] = useState({ name: t.name, loginSlug: t.loginSlug ?? "", industry: t.industry ?? "", country: t.country ?? "", timezone: t.timezone, locale: t.locale, environment: t.environment });
  const save = useMutation({
    mutationFn: () =>
      platformApi.editTenant(t.id, {
        version: t.version,
        name: form.name.trim(),
        ...(form.loginSlug.trim() ? { loginSlug: form.loginSlug.trim() } : {}),
        ...(form.industry.trim() ? { industry: form.industry.trim() } : {}),
        ...(form.country.trim() ? { country: form.country.trim() } : {}),
        timezone: form.timezone.trim(),
        locale: form.locale.trim(),
        environment: form.environment,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["platform"] });
      onClose();
    },
  });
  return (
    <ActionDialog open={open} title="Edit tenant details" description="Changes are saved against the version you opened; if someone else changed it first, you will be asked to reload." confirmLabel="Save changes" pending={save.isPending} error={save.error} onConfirm={() => save.mutate()} onCancel={onClose}>
      <div className="grid gap-3 sm:grid-cols-2">
        {(
          [
            ["name", "Name"],
            ["loginSlug", "Login address"],
            ["industry", "Industry"],
            ["country", "Country"],
            ["timezone", "Time zone"],
            ["locale", "Locale"],
          ] as const
        ).map(([k, label]) => (
          <FormField key={k} label={label} htmlFor={`edit-${k}`}>
            <input id={`edit-${k}`} className={`${CONTROL} ${k === "loginSlug" ? "font-mono" : ""}`} value={form[k]} onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))} />
          </FormField>
        ))}
        <FormField label="Environment" htmlFor="edit-env">
          <select id="edit-env" className={CONTROL} value={form.environment} onChange={(e) => setForm((f) => ({ ...f, environment: e.target.value as TenantEnvironment }))}>
            <option value="PRODUCTION">Production</option>
            <option value="DEMO">Demo</option>
            <option value="TEST">Test</option>
          </select>
        </FormField>
      </div>
    </ActionDialog>
  );
}

function TenantDetail() {
  const { id } = useParams<{ id: string }>();
  const { get, set } = useUrlFilters();
  const { can } = usePlatformUser();
  const queryClient = useQueryClient();
  const detail = useQuery({ queryKey: ["platform", "tenant", id], queryFn: () => platformApi.tenant(id) });
  const [lifecycle, setLifecycle] = useState<TenantLifecycleAction | null>(null);
  const [editing, setEditing] = useState(false);
  const created = get("created");
  const act = useMutation({
    mutationFn: ({ action, reason }: { action: TenantLifecycleAction; reason: string }) => platformApi.tenantLifecycle(id, { action, reason, version: detail.data!.tenant.version }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["platform"] });
      setLifecycle(null);
    },
  });

  const tabs = [
    { key: "overview", label: "Overview" },
    ...TENANT_EXTRA_TABS.filter((x) => x.position === "afterOverview").map((x) => ({ key: x.key, label: x.label })),
    { key: "configuration", label: "Branches & Departments" },
    ...TENANT_EXTRA_TABS.filter((x) => x.position === "afterConfiguration").map((x) => ({ key: x.key, label: x.label })),
    { key: "integrations", label: "Integrations" },
    { key: "branding", label: "Branding & Login" },
    { key: "usage", label: "Usage" },
    ...TENANT_EXTRA_TABS.filter((x) => x.position === "end").map((x) => ({ key: x.key, label: x.label })),
  ];
  const tab = tabs.some((t) => t.key === get("tab")) ? get("tab") : "overview";

  const back = (
    <Link href="/platform/tenants" className="inline-flex min-h-11 items-center gap-1 text-xs font-medium text-ink-2 hover:text-ink sm:min-h-0">
      <ArrowLeft size={14} /> Tenants
    </Link>
  );

  if (detail.isError)
    return (
      <PlatformPage title="Tenant" back={back}>
        <ErrorPanel error={detail.error} onRetry={() => detail.refetch()} />
      </PlatformPage>
    );
  if (!detail.data)
    return (
      <PlatformPage title="Loading tenant…" back={back}>
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-64 w-full" />
      </PlatformPage>
    );

  const d = detail.data;
  const t = d.tenant;
  const actions = can("MANAGE_TENANT_LIFECYCLE") ? lifecycleActionsFor(t.status) : [];
  const extra = TENANT_EXTRA_TABS.find((x) => x.key === tab);

  return (
    <PlatformPage
      title={t.name}
      back={back}
      testId="platform-tenant-detail"
      actions={
        <>
          <span className="flex items-center gap-1.5">
            <TenantStatusBadge status={t.status} />
            <EnvironmentBadge environment={t.environment} />
          </span>
          {can("START_SUPPORT_SESSION") && (
            <Link href={`/platform/support?tenant=${t.id}`} className="inline-flex min-h-11 items-center gap-1.5 rounded-control border border-line-strong bg-white/85 px-3.5 text-sm font-medium text-neutral-700 shadow-panel hover:bg-white md:min-h-9" data-testid="open-as-support">
              Open as support
            </Link>
          )}
          {can("EDIT_TENANT") && (
            <Button onClick={() => setEditing(true)} data-testid="edit-tenant">
              Edit details
            </Button>
          )}
          {actions.map((a) => (
            <Button key={a} variant={TENANT_TRANSITIONS[a].dangerous ? "danger" : "secondary"} onClick={() => setLifecycle(a)} data-testid={`lifecycle-${a}`}>
              {TENANT_TRANSITIONS[a].label}
            </Button>
          ))}
        </>
      }
    >
      {created && (
        <p role="status" className="rounded-card border border-line bg-surface-info px-4 py-2.5 text-sm text-ink" data-testid="created-banner">
          {created === "existing"
            ? "This tenant already existed for that submission; nothing new was created."
            : created === "SENT"
              ? "Tenant created as Draft. The administrator's invitation was sent."
              : "Tenant created as Draft. The invitation could not be delivered (no email provider is configured) — resend it from Access & Invitations once email is available."}
          <button type="button" className="ml-2 text-xs font-medium text-primary-700 underline" onClick={() => set({ created: undefined })}>
            Dismiss
          </button>
        </p>
      )}

      <Tabs items={tabs} value={tab} onChange={(k) => set({ tab: k === "overview" ? undefined : k })} variant="underline" ariaLabel="Tenant sections" />

      {tab === "overview" && <TenantOverviewTab detail={d} canManagePrimary={can("MANAGE_MEMBERSHIPS")} />}
      {tab === "configuration" && <TenantConfigTab tenantId={t.id} canEdit={can("EDIT_TENANT")} />}
      {tab === "integrations" && <TenantIntegrationsTab detail={d} />}
      {tab === "branding" && <TenantBrandingTab key={d.branding?.updatedAt ?? "none"} detail={d} canEdit={can("EDIT_TENANT")} />}
      {tab === "usage" && <TenantUsageTab tenantId={t.id} />}
      {extra && <extra.Component detail={d} />}

      {editing && <EditDetailsDialog detail={d} open={editing} onClose={() => setEditing(false)} />}
      <ActionDialog
        open={lifecycle !== null}
        title={lifecycle ? `${TENANT_TRANSITIONS[lifecycle].label}: ${t.name}` : ""}
        description={lifecycle ? LIFECYCLE_COPY[lifecycle] : ""}
        confirmLabel={lifecycle ? TENANT_TRANSITIONS[lifecycle].label : ""}
        danger={lifecycle ? TENANT_TRANSITIONS[lifecycle].dangerous : false}
        requireReason
        typedConfirmation={lifecycle && TENANT_TRANSITIONS[lifecycle].dangerous ? (t.loginSlug ?? lifecycle) : undefined}
        pending={act.isPending}
        error={act.error}
        onConfirm={(reason) => lifecycle && act.mutate({ action: lifecycle, reason })}
        onCancel={() => {
          setLifecycle(null);
          act.reset();
        }}
      />
    </PlatformPage>
  );
}

export default function TenantDetailPage() {
  return (
    <Suspense fallback={null}>
      <TenantDetail />
    </Suspense>
  );
}
