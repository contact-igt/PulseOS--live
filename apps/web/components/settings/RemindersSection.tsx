"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@pulseos/api-client";
import { Badge, Button, ErrorState, Skeleton, relativeTime } from "@pulseos/ui";
import { TEMPLATE_PURPOSE_LABEL, TEMPLATE_VARIABLES, templateVariablesUsed, type MessageTemplateVm, type NotificationRuleVm, type ProviderTemplateCatalogue } from "@pulseos/types";
import { catalogueNotice, optionValue, suitableFirst, templateChoice, templateOptions } from "./providerTemplateForm";
import { ProviderTemplateCard } from "./ProviderTemplateCard";
import { ProviderTemplatePicker } from "./ProviderTemplatePicker";

const field = "h-11 rounded-control border border-line-strong bg-surface px-2 text-sm text-ink outline-none focus:border-primary-500 sm:h-9";
const ERR: Record<string, string> = {
  unknown_variable: "That message uses a detail this template does not offer.",
  invalid_body: "The message cannot be empty.",
  invalid_offset: "Enter a whole number of 1 or more.",
  invalid_gap: "Enter a whole number of minutes (0 or more).",
  template_mismatch: "Choose a template made for this kind of reminder.",
  feature_not_available: "WhatsApp Notifications is switched off for this hospital.",
  template_incompatible: "That template cannot be used with this message.",
  catalogue_unavailable: "WhatsNexus could not be checked right now, so this was not saved.",
};

/** The server's plain-words reason when it sent one (an incompatible WhatsNexus template), else our own wording. */
const errorText = (e: unknown, fallback = "Could not save.") => {
  const err = e as ApiError;
  return err?.detail ?? ERR[err?.message] ?? fallback;
};

function RuleRow({ rule, templates }: { rule: NotificationRuleVm; templates: MessageTemplateVm[] }) {
  const queryClient = useQueryClient();
  const [value, setValue] = useState(String(rule.offsetValue));
  const [unit, setUnit] = useState(rule.offsetUnit);
  const [gap, setGap] = useState(String(rule.minGapMinutes));
  const [msg, setMsg] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: Parameters<typeof api.updateNotificationRule>[1]) => api.updateNotificationRule(rule.id, body),
    onSuccess: () => { setMsg(null); queryClient.invalidateQueries({ queryKey: ["notification-rules"] }); },
    onError: (e) => setMsg(ERR[(e as ApiError).message] ?? "Could not save."),
  });
  const kind = rule.kind === "CONFIRMATION" ? "Confirmation — sent when booked" : `Reminder — ${rule.offsetValue} ${rule.offsetUnit} before`;
  const purpose = rule.subject === "SURGERY" ? "SURGERY_REMINDER" : rule.kind === "CONFIRMATION" ? "APPOINTMENT_CONFIRMATION" : "APPOINTMENT_REMINDER";
  return (
    <li className="flex flex-wrap items-end gap-3 p-3 text-xs" data-testid={`rule-${rule.id}`}>
      <div className="min-w-0 flex-1 basis-48">
        <p className="text-sm font-medium text-ink">{kind}</p>
        <label className="mt-1 flex min-h-11 items-center gap-2 text-ink-2 sm:min-h-0">
          <input type="checkbox" className="max-sm:size-11" checked={rule.enabled} onChange={(e) => save.mutate({ enabled: e.target.checked })} aria-label={`${kind} enabled`} data-testid={`rule-enabled-${rule.id}`} />
          {rule.enabled ? "On" : "Off"}
        </label>
      </div>
      {rule.kind === "REMINDER" && (
        <div className="flex items-end gap-1">
          <label className="flex flex-col gap-1 text-ink-2">Before<input inputMode="numeric" value={value} onChange={(e) => setValue(e.target.value)} onBlur={() => { const n = Number(value); if (!/^\d+$/.test(value.trim()) || n < 1) { setMsg(ERR.invalid_offset!); setValue(String(rule.offsetValue)); } else if (n !== rule.offsetValue) save.mutate({ offsetValue: n }); }} className={`${field} w-20`} data-testid={`rule-offset-${rule.id}`} /></label>
          <select aria-label="Unit" value={unit} onChange={(e) => { setUnit(e.target.value as typeof unit); save.mutate({ offsetUnit: e.target.value as typeof unit }); }} className={field}>
            <option value="minutes">minutes</option><option value="hours">hours</option><option value="days">days</option>
          </select>
        </div>
      )}
      <label className="flex flex-col gap-1 text-ink-2">Min gap (min)<input inputMode="numeric" value={gap} onChange={(e) => setGap(e.target.value)} onBlur={() => { const n = Number(gap); if (!/^\d+$/.test(gap.trim())) { setMsg(ERR.invalid_gap!); setGap(String(rule.minGapMinutes)); } else if (n !== rule.minGapMinutes) save.mutate({ minGapMinutes: n }); }} className={`${field} w-24`} /></label>
      <label className="flex flex-col gap-1 text-ink-2">Template
        <select value={rule.templateId ?? ""} onChange={(e) => save.mutate({ templateId: e.target.value || null })} className={field}>
          <option value="">None</option>
          {templates.filter((t) => t.purpose === purpose).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </label>
      {msg && <p role="alert" className="basis-full text-danger-700">{msg}</p>}
    </li>
  );
}

function TemplateEditor({ template, catalogue }: { template: MessageTemplateVm; catalogue: ProviderTemplateCatalogue | null }) {
  const queryClient = useQueryClient();
  const [body, setBody] = useState(template.body);
  const [providerName, setProviderName] = useState(template.providerTemplateName);
  // The language belongs to the template WhatsNexus approved: choosing a template sets both.
  const [language, setLanguage] = useState(template.language);
  const [msg, setMsg] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (b: Parameters<typeof api.updateMessageTemplate>[1]) => api.updateMessageTemplate(template.id, b),
    onSuccess: () => { setMsg("Saved."); queryClient.invalidateQueries({ queryKey: ["message-templates"] }); },
    onError: (e) => setMsg(errorText(e)),
  });

  // While WhatsNexus is the sender the template must be one it has approved; otherwise the free-text name still applies.
  const fromCatalogue = catalogue?.active === true;
  const options = fromCatalogue ? suitableFirst(templateOptions(catalogue.templates, { body })) : [];
  const unsuitable = options.filter((o) => !o.compatible);
  const choice = fromCatalogue && catalogue.state === "OK" ? templateChoice({ providerTemplateName: providerName, language, body }, catalogue.templates) : null;
  const notice = catalogue ? catalogueNotice(catalogue, { body }) : null;
  const selected = options.find((o) => o.value === optionValue(providerName, language));
  const variableCount = templateVariablesUsed(body).length;
  const blocked = fromCatalogue && (notice?.blocksSave === true || !choice?.ok);

  return (
    <li className="space-y-2 p-3 text-xs" data-testid={`template-${template.purpose}`}>
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-medium text-ink">{TEMPLATE_PURPOSE_LABEL[template.purpose]}</p>
        <Badge tone={template.enabled ? "primary" : "neutral"}>{template.enabled ? "On" : "Off"}</Badge>
      </div>
      <label className="block text-ink-2">PulseOS field mapping
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={3} className="mt-1 w-full rounded-control border border-line-strong bg-surface p-2 text-sm text-ink outline-none focus:border-primary-500" data-testid={`template-body-${template.purpose}`} />
      </label>
      <p className="text-ink-3">Set the value for each WhatsApp placeholder. Details you can use: {TEMPLATE_VARIABLES[template.purpose].map((v) => `{{${v}}}`).join("  ")}</p>
      {fromCatalogue ? (
        <div className="space-y-2">
          <div className="text-ink-2">
            <span id={`template-label-${template.purpose}`}>Approved WhatsNexus template</span>
            <ProviderTemplatePicker
              options={options}
              selectedValue={selected?.value}
              currentLabel={providerName ? `${providerName} (${language})` : null}
              onSelect={(o) => { setProviderName(o.template.name); setLanguage(o.template.language); setMsg(null); }}
              variableCount={variableCount}
              testId={`template-provider-${template.purpose}`}
            />
          </div>
          <p className="text-ink-3">This message uses {variableCount} variable{variableCount === 1 ? "" : "s"}. Only templates with the same number of placeholders are suitable. The template decides the language the patient receives.</p>
          {selected && <ProviderTemplateCard template={selected.template} body={body} compatible={selected.compatible} testId={`template-card-${template.purpose}`} />}
          {choice?.ok && <p role="status" className="text-primary-700" data-testid={`template-compatible-${template.purpose}`}>Compatible: name, language and variables match.</p>}
          {choice && !choice.ok && <p role="alert" className="text-danger-700" data-testid={`template-incompatible-${template.purpose}`}>{choice.message}</p>}
          {notice && <p role="alert" className={notice.blocksSave ? "text-danger-700" : "text-warning-700"} data-testid={`template-catalogue-notice-${template.purpose}`}>{notice.text}</p>}
          {unsuitable.length > 0 && (
            <details className="text-ink-3" data-testid={`template-why-${template.purpose}`}>
              <summary className="cursor-pointer text-ink-2">Why can&apos;t I pick {unsuitable.length} of the templates?</summary>
              <ul className="mt-1 list-disc space-y-0.5 pl-4">
                {unsuitable.map((o) => <li key={o.value}><span className="font-medium text-ink-2">{o.template.name}</span> ({o.template.language}): {o.reason}</li>)}
              </ul>
            </details>
          )}
        </div>
      ) : (
        <label className="block text-ink-2">Approved template name with WhatsApp
          <input value={providerName} onChange={(e) => setProviderName(e.target.value)} className={`mt-1 w-full ${field}`} />
        </label>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" variant="primary" onClick={() => save.mutate({ body, providerTemplateName: providerName, ...(fromCatalogue ? { language } : {}) })} disabled={save.isPending || blocked} data-testid={`template-save-${template.purpose}`}>Save</Button>
        <label className="flex min-h-11 items-center gap-2 text-ink-2 sm:min-h-0"><input type="checkbox" className="max-sm:size-11" checked={template.enabled} onChange={(e) => save.mutate({ enabled: e.target.checked })} />Enabled</label>
        {msg && <span role="status" className="text-ink-2">{msg}</span>}
      </div>
    </li>
  );
}

/** WhatsNexus → Reminders. When messages go out, and what they say. Admin only; needs WhatsApp Notifications on. */
export function RemindersSection() {
  const rules = useQuery({ queryKey: ["notification-rules"], queryFn: api.notificationRules, retry: false });
  const templates = useQuery({ queryKey: ["message-templates"], queryFn: api.messageTemplates, retry: false });
  // Read from WhatsNexus every time this page opens (and on Refresh): Meta approval can change, so it is never kept.
  const provider = useQuery({ queryKey: ["provider-templates"], queryFn: api.providerTemplates, retry: false, staleTime: 0, gcTime: 0, refetchOnMount: "always" });
  if (rules.isLoading || templates.isLoading) return <Skeleton className="h-32" />;
  const status = (rules.error ?? templates.error) instanceof ApiError ? ((rules.error ?? templates.error) as ApiError) : null;
  if (rules.isError || templates.isError || !rules.data || !templates.data) {
    if (status?.message === "feature_not_available") return <ErrorState message="WhatsApp Notifications is switched off for this hospital. Ask your Super Admin to turn it on in Settings → Features." />;
    if (status?.status === 403) return <ErrorState message="Only a Hospital Admin can change reminders." />;
    return <ErrorState message="Could not load reminders. Try again in a moment." />;
  }
  const group = (subject: "APPOINTMENT" | "SURGERY") => rules.data.filter((r) => r.subject === subject);
  return (
    <div className="space-y-5" data-testid="reminders-section">
      <p className="text-xs text-ink-2">A reminder whose time has already passed is never sent late, and two messages closer together than the minimum gap are never both sent. Messages are only sent while the visit is still on.</p>
      {(["APPOINTMENT", "SURGERY"] as const).map((s) => (
        <section key={s} className="space-y-2">
          <h3 className="text-sm font-semibold text-ink">{s === "APPOINTMENT" ? "Appointments" : "Surgeries"}</h3>
          <ul className="divide-y divide-line rounded-card border border-line bg-surface">{group(s).map((r) => <RuleRow key={r.id} rule={r} templates={templates.data} />)}</ul>
        </section>
      ))}
      <section className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <h3 className="text-sm font-semibold text-ink">Messages</h3>
          {provider.data?.active && (
            <>
              <Button size="sm" variant="secondary" onClick={() => provider.refetch()} disabled={provider.isFetching} data-testid="refresh-provider-templates">{provider.isFetching ? "Refreshing…" : "Refresh WhatsNexus templates"}</Button>
              <span className="text-ink-3" data-testid="provider-templates-fetched">{provider.data.state === "OK" ? `${provider.data.templates.length} approved · read ${relativeTime(provider.data.fetchedAt)}` : "Could not read WhatsNexus templates"}</span>
            </>
          )}
        </div>
        {provider.isLoading && <p className="text-xs text-ink-3">Reading approved templates from WhatsNexus…</p>}
        <ul className="divide-y divide-line rounded-card border border-line bg-surface">{templates.data.map((t) => <TemplateEditor key={t.id} template={t} catalogue={provider.data ?? null} />)}</ul>
      </section>
    </div>
  );
}
