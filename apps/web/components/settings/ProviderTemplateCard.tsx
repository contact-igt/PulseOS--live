"use client";

import type { ProviderTemplate } from "@pulseos/types";
import { Badge } from "@pulseos/ui";
import { templateDetails, variableMapping } from "./providerTemplateForm";

/**
 * The important facts about the WhatsNexus template a reminder will use, and exactly which detail of the message goes into
 * each placeholder — so an admin can see, before saving, what the patient's message is built from.
 */
export function ProviderTemplateCard({ template, body, compatible, testId }: { template: ProviderTemplate; body: string; compatible: boolean; testId: string }) {
  const mapping = variableMapping(body);
  return (
    <div className="space-y-2 rounded-card border border-line bg-surface-info p-3" data-testid={testId}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">Selected template</span>
        <Badge tone={compatible ? "success" : "danger"}>{compatible ? "Suitable" : "Not suitable"}</Badge>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-4">
        {templateDetails(template).map((d) => (
          <div key={d.label} className={d.label === "Template" ? "col-span-2 sm:col-span-2" : ""}>
            <dt className="text-[11px] text-ink-3">{d.label}</dt>
            <dd className="break-all font-medium text-ink">{d.value}</dd>
          </div>
        ))}
      </dl>
      {template.body && (
        <div>
          <p className="text-[11px] text-ink-3">WhatsApp template preview</p>
          <pre className="mt-1 whitespace-pre-wrap rounded-control border border-line bg-surface px-2 py-1.5 text-xs text-ink" data-testid={`${testId}-body`}>{template.body}</pre>
          <p className="mt-1 text-[11px] text-ink-3">This approved wording is read-only. WhatsNexus sends this text, not the PulseOS mapping above.</p>
        </div>
      )}
      <div>
        <p className="text-[11px] text-ink-3">What goes into each placeholder ({mapping.length} in this message, {template.bodyParameterCount} in the template)</p>
        {mapping.length === 0 ? (
          <p className="text-ink-2">This message has no details to fill in.</p>
        ) : (
          <ol className="mt-1 grid gap-1 sm:grid-cols-2" data-testid={`${testId}-mapping`}>
            {mapping.map((m) => (
              <li key={m.position} className="flex items-center gap-2 rounded-control border border-line bg-surface px-2 py-1">
                <code className="rounded bg-surface-muted px-1 font-mono text-[11px] text-ink-2">{`{{${m.position}}}`}</code>
                <span className="text-ink">{m.variable}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
