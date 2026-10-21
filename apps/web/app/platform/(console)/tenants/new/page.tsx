"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, Plus, Trash2 } from "lucide-react";
import { platformApi } from "@pulseos/api-client";
import { Button, Card } from "@pulseos/ui";
import {
  CAPABILITIES,
  CAPABILITY_DEPENDENCIES,
  CAPABILITY_META,
  EDITION_CAPABILITIES,
  LOCKED_CAPABILITIES,
  PLAN_META,
  resolveCapabilities,
  type Capability,
  type CreateTenantRequest,
  type Edition,
  type SourceChannel,
  type TenantEnvironment,
} from "@pulseos/types";
import { CONTROL, FormField } from "../../../../../components/settings/FormBits";
import { ErrorPanel, NoAccess, PlatformPage, errorMessage } from "../../../../../components/platform/ui";
import { usePlatformUser } from "../../../../../components/platform/usePlatformUser";

const STEPS = ["Organization", "Plan", "Initial setup", "Administrator", "Review"] as const;
const SLUG = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BUCKETS: { key: SourceChannel; label: string }[] = [
  { key: "other", label: "Custom / other" },
  { key: "meta", label: "Digital · Meta" },
  { key: "google", label: "Digital · Google" },
  { key: "website", label: "Digital · Website" },
  { key: "organic", label: "Direct" },
  { key: "walk_in", label: "Offline · Walk-in" },
  { key: "phone", label: "Offline · Phone" },
  { key: "referral", label: "Referral" },
  { key: "whatsapp", label: "WhatsApp" },
];
const TIMEZONES = ["Asia/Kolkata", "Asia/Dubai", "Asia/Singapore", "Asia/Kathmandu", "Asia/Dhaka", "Asia/Colombo", "Europe/London", "America/New_York"];

function slugify(name: string) {
  const s = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 38)
    .replace(/-+$/g, "");
  return /^[a-z]/.test(s) ? s : s ? `h-${s}`.slice(0, 38) : "";
}

function capabilityProblems(edition: Edition, overrides: Partial<Record<Capability, boolean>>): string[] {
  const map = resolveCapabilities(edition, overrides);
  const out: string[] = [];
  for (const c of CAPABILITIES) if (map[c]) for (const d of CAPABILITY_DEPENDENCIES[c] ?? []) if (!map[d]) out.push(`${CAPABILITY_META[c].label} needs ${CAPABILITY_META[d].label}`);
  return out;
}

export default function CreateTenantPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { can } = usePlatformUser();
  // One key for this wizard: a double-click or a retried submit returns the same tenant instead of creating another.
  const [creationKey] = useState(() => crypto.randomUUID());
  const [step, setStep] = useState(0);
  const [org, setOrg] = useState({ name: "", slug: "", slugEdited: false, industry: "Healthcare", country: "India", timezone: "Asia/Kolkata", locale: "en-IN", environment: "PRODUCTION" as TenantEnvironment });
  const [edition, setEdition] = useState<Edition>("BETA_V1_CORE");
  const [overrides, setOverrides] = useState<Partial<Record<Capability, boolean>>>({});
  const [branchRows, setBranchRows] = useState([{ name: "Main", city: "" }]);
  const [templates, setTemplates] = useState<string[]>([]);
  const [customSources, setCustomSources] = useState<{ label: string; bucket: SourceChannel }[]>([]);
  const [branding, setBranding] = useState({ shortName: "", headline: "", tagline: "", supportText: "" });
  const [admin, setAdmin] = useState({ name: "", email: "", role: "SUPER_ADMIN" as "SUPER_ADMIN" | "HOSPITAL_ADMIN" });
  const [touched, setTouched] = useState(false);

  // Platform Settings decide the starting plan, time zone and locale (applied once, before anything is touched).
  const settings = useQuery({ queryKey: ["platform", "settings"], queryFn: platformApi.settings, staleTime: 300_000 });
  const [defaultsApplied, setDefaultsApplied] = useState(false);
  if (settings.data && !defaultsApplied) {
    setDefaultsApplied(true);
    setEdition(settings.data.settings.defaultEdition);
    setOrg((o) => ({ ...o, timezone: settings.data!.settings.defaultTimezone, locale: settings.data!.settings.defaultLocale }));
  }
  const deptTemplates = useQuery({ queryKey: ["platform", "department-templates"], queryFn: platformApi.departmentTemplates, staleTime: 3_600_000 });
  const effective = useMemo(() => resolveCapabilities(edition, overrides), [edition, overrides]);
  const problems = capabilityProblems(edition, overrides);

  const stepErrors: string[][] = [
    [
      ...(org.name.trim().length < 2 ? ["Enter the organization name"] : []),
      ...(!SLUG.test(org.slug) ? ["The login address must be 3–40 lower-case letters, digits or dashes, starting with a letter"] : []),
      ...(org.industry.trim().length < 2 ? ["Enter the industry"] : []),
      ...(org.country.trim().length < 2 ? ["Enter the country"] : []),
    ],
    problems,
    [
      ...(branchRows.some((b) => b.name.trim().length < 2 || b.city.trim().length < 2) ? ["Every branch needs a name and a city"] : []),
      ...(customSources.some((s) => !s.label.trim()) ? ["Give every custom lead source a name"] : []),
      ...(new Set(customSources.map((s) => s.label.trim().toLowerCase())).size !== customSources.length ? ["Custom lead sources must have different names"] : []),
    ],
    [...(admin.name.trim().length < 2 ? ["Enter the administrator's name"] : []), ...(!EMAIL.test(admin.email.trim()) ? ["Enter a valid email address"] : [])],
    [],
  ];

  const body: CreateTenantRequest = {
    creationKey,
    organization: { name: org.name.trim(), slug: org.slug, industry: org.industry.trim(), country: org.country.trim(), timezone: org.timezone, locale: org.locale, environment: org.environment },
    plan: { edition, capabilityOverrides: overrides },
    setup: {
      branches: branchRows.map((b) => ({ name: b.name.trim(), city: b.city.trim() })),
      departmentTemplates: templates,
      customLeadSources: customSources.map((s) => ({ label: s.label.trim(), bucket: s.bucket })),
      branding: Object.fromEntries(Object.entries(branding).filter(([, v]) => v.trim()).map(([k, v]) => [k, v.trim()])),
    },
    admin: { name: admin.name.trim(), email: admin.email.trim().toLowerCase(), role: admin.role },
  };

  // A second click while the first request is in flight is ignored here (the server would also return the same tenant).
  const submitting = useRef(false);
  const create = useMutation({
    mutationFn: () => platformApi.createTenant(body),
    onSettled: () => {
      submitting.current = false;
    },
    onSuccess: (r) => {
      void queryClient.invalidateQueries({ queryKey: ["platform"] });
      router.push(`/platform/tenants/${r.tenant.id}?created=${r.invitation?.deliveryStatus ?? "existing"}`);
    },
  });

  if (!can("CREATE_TENANT")) {
    return (
      <PlatformPage title="Create tenant">
        <NoAccess what="creating tenants" />
      </PlatformPage>
    );
  }

  function next() {
    setTouched(true);
    if (stepErrors[step]!.length === 0) {
      setTouched(false);
      setStep((s) => Math.min(s + 1, STEPS.length - 1));
    }
  }

  const errors = touched ? stepErrors[step]! : [];

  return (
    <PlatformPage
      title="Create tenant"
      subtitle="A new client workspace, created in one step when you confirm. Nothing is saved until then."
      back={
        <Link href="/platform/tenants" className="inline-flex min-h-11 items-center gap-1 text-xs font-medium text-ink-2 hover:text-ink sm:min-h-0">
          <ArrowLeft size={14} /> Tenants
        </Link>
      }
      testId="create-tenant-wizard"
    >
      <ol className="flex flex-wrap gap-1.5" aria-label="Steps">
        {STEPS.map((label, i) => (
          <li key={label}>
            <button
              type="button"
              disabled={i > step}
              onClick={() => i < step && setStep(i)}
              aria-current={i === step ? "step" : undefined}
              className={`flex min-h-11 items-center gap-1.5 rounded-chip border px-2.5 text-xs font-medium sm:min-h-8 ${i === step ? "border-primary-500 bg-primary-50 text-primary-700" : i < step ? "border-line bg-white text-ink hover:border-primary-300" : "border-line bg-white/60 text-ink-2"}`}
            >
              <span className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] ${i < step ? "bg-primary-600 text-white" : "bg-neutral-100 text-ink-2"}`}>{i < step ? <Check size={12} /> : i + 1}</span>
              {label}
            </button>
          </li>
        ))}
      </ol>

      <Card className="p-4 sm:p-5">
        {step === 0 && (
          <div className="grid gap-4 sm:grid-cols-2" data-testid="step-organization">
            <FormField label="Tenant name" htmlFor="t-name">
              <input
                id="t-name"
                className={CONTROL}
                value={org.name}
                onChange={(e) => setOrg((o) => ({ ...o, name: e.target.value, slug: o.slugEdited ? o.slug : slugify(e.target.value) }))}
                data-testid="tenant-name"
              />
            </FormField>
            <FormField label="Login address" hint={org.slug ? `Staff sign in at /login/${org.slug}` : "Lower-case letters, digits and dashes"} htmlFor="t-slug">
              <input id="t-slug" className={`${CONTROL} font-mono`} value={org.slug} onChange={(e) => setOrg((o) => ({ ...o, slug: e.target.value.toLowerCase(), slugEdited: true }))} data-testid="tenant-slug" />
            </FormField>
            <FormField label="Industry" htmlFor="t-industry">
              <input id="t-industry" list="industries" className={CONTROL} value={org.industry} onChange={(e) => setOrg((o) => ({ ...o, industry: e.target.value }))} />
              <datalist id="industries">
                <option value="Healthcare" />
                <option value="Other" />
              </datalist>
            </FormField>
            <FormField label="Country" htmlFor="t-country">
              <input id="t-country" className={CONTROL} value={org.country} onChange={(e) => setOrg((o) => ({ ...o, country: e.target.value }))} />
            </FormField>
            <FormField label="Time zone" hint="Every day and report is counted in this zone" htmlFor="t-tz">
              <select id="t-tz" className={CONTROL} value={org.timezone} onChange={(e) => setOrg((o) => ({ ...o, timezone: e.target.value }))}>
                {(TIMEZONES.includes(org.timezone) ? TIMEZONES : [org.timezone, ...TIMEZONES]).map((tz) => (
                  <option key={tz}>{tz}</option>
                ))}
              </select>
            </FormField>
            <FormField label="Locale" htmlFor="t-locale">
              <select id="t-locale" className={CONTROL} value={org.locale} onChange={(e) => setOrg((o) => ({ ...o, locale: e.target.value }))}>
                {!["en-IN", "en-GB", "en-US"].includes(org.locale) && <option value={org.locale}>{org.locale}</option>}
                <option value="en-IN">English (India) · en-IN</option>
                <option value="en-GB">English (UK) · en-GB</option>
                <option value="en-US">English (US) · en-US</option>
              </select>
            </FormField>
            <FormField label="Environment" hint="Demo and test workspaces are labelled everywhere in the console" htmlFor="t-env">
              <select id="t-env" className={CONTROL} value={org.environment} onChange={(e) => setOrg((o) => ({ ...o, environment: e.target.value as TenantEnvironment }))}>
                <option value="PRODUCTION">Production (a real client)</option>
                <option value="DEMO">Demo</option>
                <option value="TEST">Test</option>
              </select>
            </FormField>
          </div>
        )}

        {step === 1 && (
          <div className="space-y-4" data-testid="step-plan">
            <fieldset className="grid gap-2 sm:grid-cols-2">
              <legend className="mb-2 text-xs font-medium text-ink">Plan</legend>
              {(Object.keys(PLAN_META) as Edition[]).map((e) => (
                <label key={e} className={`flex cursor-pointer gap-3 rounded-card border p-3 ${edition === e ? "border-primary-500 bg-primary-50" : "border-line bg-white hover:border-primary-300"}`}>
                  <input
                    type="radio"
                    name="plan"
                    checked={edition === e}
                    onChange={() => {
                      setEdition(e);
                      setOverrides({});
                    }}
                    className="mt-1 h-4 w-4 accent-primary-600"
                  />
                  <span>
                    <span className="block text-sm font-semibold text-ink">{PLAN_META[e].name}</span>
                    <span className="block text-xs text-ink-2">{PLAN_META[e].description}</span>
                    <span className="mt-1 block text-[11px] text-ink-2">{EDITION_CAPABILITIES[e].length} capabilities by default</span>
                  </span>
                </label>
              ))}
            </fieldset>
            <div>
              <p className="mb-2 text-xs font-medium text-ink">Capabilities · plan default, your change, and what the tenant gets</p>
              <ul className="divide-y divide-neutral-100 rounded-card border border-line">
                {CAPABILITIES.map((c) => {
                  const planDefault = EDITION_CAPABILITIES[edition].includes(c);
                  const locked = LOCKED_CAPABILITIES.includes(c);
                  const on = effective[c];
                  return (
                    <li key={c} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                      <span className="min-w-0 flex-1 basis-48">
                        <span className="block text-sm text-ink">{CAPABILITY_META[c].label}</span>
                        <span className="block text-[11px] text-ink-2">
                          Plan: {planDefault ? "on" : "off"}
                          {overrides[c] !== undefined && overrides[c] !== planDefault ? ` · overridden ${on ? "on" : "off"}` : ""}
                        </span>
                      </span>
                      <label className="flex min-h-11 items-center gap-2 text-xs sm:min-h-0">
                        <input
                          type="checkbox"
                          checked={on}
                          disabled={locked}
                          onChange={(e) => setOverrides((o) => {
                            const copy = { ...o };
                            if (e.target.checked === planDefault) delete copy[c];
                            else copy[c] = e.target.checked;
                            return copy;
                          })}
                          className="h-4 w-4 accent-primary-600"
                          aria-label={`${CAPABILITY_META[c].label} enabled`}
                        />
                        {locked ? "Always on" : on ? "On" : "Off"}
                      </label>
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-5" data-testid="step-setup">
            <section>
              <h2 className="mb-2 text-sm font-semibold text-ink">Branches</h2>
              <div className="space-y-2">
                {branchRows.map((b, i) => (
                  <div key={i} className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
                    <FormField label="Branch name" htmlFor={`b-name-${i}`}>
                      <input id={`b-name-${i}`} className={CONTROL} value={b.name} onChange={(e) => setBranchRows((rows) => rows.map((r, j) => (j === i ? { ...r, name: e.target.value } : r)))} />
                    </FormField>
                    <FormField label="City" htmlFor={`b-city-${i}`}>
                      <input id={`b-city-${i}`} className={CONTROL} value={b.city} onChange={(e) => setBranchRows((rows) => rows.map((r, j) => (j === i ? { ...r, city: e.target.value } : r)))} data-testid={`branch-city-${i}`} />
                    </FormField>
                    <Button variant="ghost" disabled={branchRows.length === 1} onClick={() => setBranchRows((rows) => rows.filter((_, j) => j !== i))} aria-label={`Remove branch ${i + 1}`}>
                      <Trash2 size={14} />
                    </Button>
                  </div>
                ))}
                <Button size="sm" onClick={() => setBranchRows((rows) => [...rows, { name: "", city: "" }])} disabled={branchRows.length >= 20}>
                  <Plus size={13} /> Add branch
                </Button>
              </div>
            </section>
            <section>
              <h2 className="mb-1 text-sm font-semibold text-ink">Departments</h2>
              <p className="mb-2 text-xs text-ink-2">A template installs the department with its services and treatment catalogue; the hospital owns and edits its copy.</p>
              {deptTemplates.isError ? (
                <ErrorPanel error={deptTemplates.error} onRetry={() => deptTemplates.refetch()} />
              ) : (
                <div className="grid gap-2 sm:grid-cols-2">
                  {(deptTemplates.data?.templates ?? []).map((t) => (
                    <label key={t.key} className={`flex cursor-pointer gap-3 rounded-card border p-3 ${templates.includes(t.key) ? "border-primary-500 bg-primary-50" : "border-line bg-white"}`}>
                      <input type="checkbox" checked={templates.includes(t.key)} onChange={(e) => setTemplates((ts) => (e.target.checked ? [...ts, t.key] : ts.filter((x) => x !== t.key)))} className="mt-1 h-4 w-4 accent-primary-600" />
                      <span>
                        <span className="block text-sm font-medium text-ink">{t.displayName}</span>
                        <span className="block text-xs text-ink-2">{t.description}</span>
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </section>
            <section>
              <h2 className="mb-1 text-sm font-semibold text-ink">Lead sources</h2>
              <p className="mb-2 text-xs text-ink-2">Every tenant starts with the standard catalogue (Instagram, Facebook, YouTube, Google, Referral, Direct, Walk-in, Phone, WhatsApp, Other). Add the hospital&apos;s own sources here.</p>
              <div className="space-y-2">
                {customSources.map((s, i) => (
                  <div key={i} className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
                    <FormField label="Source name" htmlFor={`s-label-${i}`}>
                      <input id={`s-label-${i}`} className={CONTROL} value={s.label} onChange={(e) => setCustomSources((rows) => rows.map((r, j) => (j === i ? { ...r, label: e.target.value } : r)))} />
                    </FormField>
                    <FormField label="Kind" htmlFor={`s-bucket-${i}`}>
                      <select id={`s-bucket-${i}`} className={CONTROL} value={s.bucket} onChange={(e) => setCustomSources((rows) => rows.map((r, j) => (j === i ? { ...r, bucket: e.target.value as SourceChannel } : r)))}>
                        {BUCKETS.map((b) => (
                          <option key={b.key} value={b.key}>
                            {b.label}
                          </option>
                        ))}
                      </select>
                    </FormField>
                    <Button variant="ghost" onClick={() => setCustomSources((rows) => rows.filter((_, j) => j !== i))} aria-label={`Remove source ${i + 1}`}>
                      <Trash2 size={14} />
                    </Button>
                  </div>
                ))}
                <Button size="sm" onClick={() => setCustomSources((rows) => [...rows, { label: "", bucket: "other" }])} disabled={customSources.length >= 20}>
                  <Plus size={13} /> Add a lead source
                </Button>
              </div>
            </section>
            <section>
              <h2 className="mb-1 text-sm font-semibold text-ink">Sign-in page (optional)</h2>
              <div className="grid gap-3 sm:grid-cols-2">
                <FormField label="Short name" htmlFor="br-short">
                  <input id="br-short" maxLength={40} className={CONTROL} value={branding.shortName} onChange={(e) => setBranding((b) => ({ ...b, shortName: e.target.value }))} />
                </FormField>
                <FormField label="Headline" htmlFor="br-head">
                  <input id="br-head" maxLength={120} className={CONTROL} value={branding.headline} onChange={(e) => setBranding((b) => ({ ...b, headline: e.target.value }))} />
                </FormField>
                <FormField label="Tagline" htmlFor="br-tag">
                  <input id="br-tag" maxLength={160} className={CONTROL} value={branding.tagline} onChange={(e) => setBranding((b) => ({ ...b, tagline: e.target.value }))} />
                </FormField>
                <FormField label="Support text" htmlFor="br-sup">
                  <input id="br-sup" maxLength={160} className={CONTROL} value={branding.supportText} onChange={(e) => setBranding((b) => ({ ...b, supportText: e.target.value }))} />
                </FormField>
              </div>
            </section>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-4" data-testid="step-admin">
            <p className="rounded-control bg-surface-info px-3 py-2 text-xs text-ink-2">
              The administrator receives an invitation link and chooses their own password. Platform staff never set or see a client&apos;s password.
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label="Full name" htmlFor="a-name">
                <input id="a-name" className={CONTROL} value={admin.name} onChange={(e) => setAdmin((a) => ({ ...a, name: e.target.value }))} data-testid="admin-name" />
              </FormField>
              <FormField label="Email" htmlFor="a-email">
                <input id="a-email" type="email" className={CONTROL} value={admin.email} onChange={(e) => setAdmin((a) => ({ ...a, email: e.target.value }))} data-testid="admin-email" />
              </FormField>
              <FormField label="Role" hint="Super Admin also controls integrations, credentials and features" htmlFor="a-role">
                <select id="a-role" className={CONTROL} value={admin.role} onChange={(e) => setAdmin((a) => ({ ...a, role: e.target.value as "SUPER_ADMIN" | "HOSPITAL_ADMIN" }))}>
                  <option value="SUPER_ADMIN">Super Admin</option>
                  <option value="HOSPITAL_ADMIN">Admin</option>
                </select>
              </FormField>
            </div>
          </div>
        )}

        {step === 4 && (
          <dl className="grid gap-4 text-sm sm:grid-cols-2" data-testid="step-review">
            <div>
              <dt className="text-[11px] font-medium uppercase tracking-wide text-ink-2">Organization</dt>
              <dd className="mt-1 text-ink">
                {body.organization.name} · <span className="font-mono">/login/{body.organization.slug}</span>
                <br />
                {body.organization.industry} · {body.organization.country} · {body.organization.timezone} · {body.organization.locale} · {body.organization.environment.toLowerCase()}
              </dd>
            </div>
            <div>
              <dt className="text-[11px] font-medium uppercase tracking-wide text-ink-2">Plan</dt>
              <dd className="mt-1 text-ink">
                {PLAN_META[edition].name} · {CAPABILITIES.filter((c) => effective[c]).length} of {CAPABILITIES.length} capabilities on
                {Object.keys(overrides).length > 0 && <span className="text-ink-2"> ({Object.keys(overrides).length} changed from the plan)</span>}
              </dd>
            </div>
            <div>
              <dt className="text-[11px] font-medium uppercase tracking-wide text-ink-2">Setup</dt>
              <dd className="mt-1 text-ink">
                {body.setup.branches.map((b) => `${b.name} (${b.city})`).join(", ")}
                <br />
                Departments: {templates.length ? templates.join(", ") : "none yet"} · Custom sources: {customSources.length}
              </dd>
            </div>
            <div>
              <dt className="text-[11px] font-medium uppercase tracking-wide text-ink-2">Administrator</dt>
              <dd className="mt-1 break-words text-ink">
                {body.admin.name} · {body.admin.email} · {admin.role === "SUPER_ADMIN" ? "Super Admin" : "Admin"}
                <br />
                <span className="text-ink-2">Invitation sent on creation</span>
              </dd>
            </div>
            <div className="sm:col-span-2">
              <p className="text-xs text-ink-2">The tenant is created as Draft. Staff can sign in once it is moved to Onboarding or Active.</p>
            </div>
          </dl>
        )}

        {errors.length > 0 && (
          <ul role="alert" className="mt-4 list-disc space-y-0.5 rounded-control bg-danger-100/50 py-2 pl-7 pr-3 text-xs text-danger-700" data-testid="wizard-errors">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        )}
        {create.isError && (
          <p role="alert" className="mt-4 rounded-control bg-danger-100/50 px-3 py-2 text-xs text-danger-700" data-testid="create-error">
            {errorMessage(create.error)}
          </p>
        )}

        <div className="mt-5 flex flex-wrap justify-between gap-2 border-t border-line pt-4">
          <Button onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0 || create.isPending}>
            Back
          </Button>
          {step < STEPS.length - 1 ? (
            <Button variant="primary" onClick={next} data-testid="wizard-next">
              Continue
            </Button>
          ) : (
            <Button variant="primary" onClick={() => {
                if (submitting.current) return;
                submitting.current = true;
                create.mutate();
              }}
              disabled={create.isPending}
              data-testid="wizard-create">
              {create.isPending ? "Creating…" : "Create tenant"}
            </Button>
          )}
        </div>
      </Card>
    </PlatformPage>
  );
}
