"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@pulseos/api-client";
import { Badge, Button, ErrorState, Skeleton, relativeTime } from "@pulseos/ui";
import { templateDetails } from "../settings/providerTemplateForm";

const th = "px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-ink-3";
const td = "px-3 py-2 text-xs text-ink";

/**
 * Read-only view of the templates WhatsNexus has approved for this hospital. WhatsNexus owns them (Meta approval, language,
 * placeholders), so nothing is created or edited here; the list is read from WhatsNexus each time the tab opens and on
 * Refresh, and is never kept.
 */
export function WhatsNexusTemplatesPanel() {
  const q = useQuery({ queryKey: ["provider-templates"], queryFn: api.providerTemplates, retry: false, staleTime: 0, gcTime: 0, refetchOnMount: "always" });
  const c = q.data;
  return (
    <div className="space-y-3 text-sm" data-testid="whatsnexus-templates">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-semibold text-ink">Approved templates</span>
        <Button size="sm" variant="secondary" onClick={() => q.refetch()} disabled={q.isFetching} data-testid="refresh-templates">
          {q.isFetching ? "Refreshing…" : "Refresh templates"}
        </Button>
      </div>
      <p className="text-xs text-ink-2">
        These are the templates WhatsNexus has approved with WhatsApp for this hospital. PulseOS reminders can only use one of these, with the same language and the same number of variables. To add or change a template, do it in WhatsNexus.
      </p>
      {q.isLoading && <Skeleton className="h-24" />}
      {q.isError && <ErrorState message="Could not load the template list. Try again in a moment." />}
      {c && c.state !== "OK" && (
        <p role="alert" className="rounded-control border border-warning-100 bg-warning-100/60 px-3 py-2 text-xs text-warning-700" data-testid="templates-state">{c.message ?? "WhatsNexus templates could not be read right now."}</p>
      )}
      {c && c.state === "OK" && c.templates.length === 0 && (
        <p className="rounded-card border border-dashed border-line p-3 text-center text-xs text-ink-2" data-testid="templates-empty">WhatsNexus has no approved templates for this hospital yet.</p>
      )}
      {c && c.state === "OK" && c.templates.length > 0 && (
        <div className="overflow-x-auto rounded-card border border-line bg-surface">
          <table className="w-full min-w-[640px]" data-testid="templates-table">
            <thead className="border-b border-line bg-surface-muted">
              <tr><th className={th}>Template</th><th className={th}>Category</th><th className={th}>Type</th><th className={th}>Language</th><th className={th}>Variables</th><th className={th}>Header</th><th className={th}>Buttons</th><th className={th}>Status</th></tr>
            </thead>
            <tbody className="divide-y divide-line">
              {c.templates.map((t) => {
                const d = Object.fromEntries(templateDetails(t).map((r) => [r.label, r.value]));
                return (
                  <tr key={`${t.name}::${t.language}`} data-testid="template-row">
                    <td className={`${td} break-all font-medium`}>{t.name}</td>
                    <td className={td}>{d.Category}</td>
                    <td className={td}>{d.Type}</td>
                    <td className={td}>{t.language}</td>
                    <td className={td}>{t.bodyParameterCount}</td>
                    <td className={td}>{d.Header}</td>
                    <td className={td}>{d.Buttons}</td>
                    <td className={td}><Badge tone="success">Approved</Badge></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {c && <p className="text-[11px] text-ink-3" data-testid="templates-fetched">Read from WhatsNexus {relativeTime(c.fetchedAt)}.{c.active ? "" : " WhatsNexus is not the selected sender yet, so reminders still use the template name typed in Settings → Reminders."}</p>}
    </div>
  );
}
