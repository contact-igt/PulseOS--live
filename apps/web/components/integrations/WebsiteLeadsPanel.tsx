"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@pulseos/api-client";
import { Badge, Button, ConfirmDialog, relativeTime } from "@pulseos/ui";
import type { IntegrationDetail, WebsiteFormView } from "@pulseos/types";
import { Copy, X } from "lucide-react";
import { API_FIELDS, RESPONSES, curlExample, isLocalUrl, nodeExample, originsFromText, originsToText, sampleJson } from "./websiteLeadsDocs";

const field = "h-11 w-full rounded-control border border-line-strong bg-surface px-2 text-sm text-ink outline-none focus:border-primary-500 sm:h-9";

/**
 * While a dialog is open over the integration sheet, Escape closes only that dialog. The sheet listens for Escape on the document
 * too, so this runs first (capture phase) and stops the event there. The shared dialog components are left as they are.
 */
function useEscapeClosesOnlyThis(active: boolean, onClose: () => void) {
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [active, onClose]);
}

/** Copies text and says so. Clipboard access can be refused (insecure page, permissions): the text is then selectable on screen. */
function useCopy() {
  const [copied, setCopied] = useState<string | null>(null);
  async function copy(key: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 2000);
    } catch {
      setCopied(`${key}:failed`);
    }
  }
  return { copied, copy };
}

function CopyButton({ id, text, label, copied, onCopy }: { id: string; text: string; label: string; copied: string | null; onCopy: (id: string, text: string) => void }) {
  return (
    <Button size="sm" variant="secondary" onClick={() => onCopy(id, text)} data-testid={`copy-${id}`} aria-label={label}>
      <Copy size={13} aria-hidden="true" className="mr-1 inline" />
      {copied === id ? "Copied" : copied === `${id}:failed` ? "Select and copy manually" : label}
    </Button>
  );
}

function statusOf(d: IntegrationDetail, f: WebsiteFormView): { label: string; tone: "success" | "danger" | "warning" | "neutral" } {
  if (!f.connectorExists) return { label: "Not configured", tone: "neutral" };
  if (!f.enabled) return { label: "Disabled", tone: "neutral" };
  if (d.health === "UNHEALTHY") return { label: "Error", tone: "danger" };
  if (d.health === "HEALTHY") return { label: "Receiving submissions", tone: "success" };
  return { label: "Not yet verified", tone: "warning" };
}

/** Website Leads: one website form per hospital (V1). Settings are typed; the token is created and shown once. */
export function WebsiteLeadsPanel({ d }: { d: IntegrationDetail }) {
  const f = d.websiteForm!;
  const queryClient = useQueryClient();
  const { copied, copy } = useCopy();
  const [editing, setEditing] = useState(!f.connectorExists);
  const [apiOpen, setApiOpen] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const status = statusOf(d, f);
  useEscapeClosesOnlyThis(confirmRotate, () => setConfirmRotate(false));

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["integration-detail", d.key] });
    queryClient.invalidateQueries({ queryKey: ["integration-hub"] });
  };
  const rotate = useMutation({
    mutationFn: () => api.rotateWebsiteToken(),
    // The token must not linger in the query client's mutation cache once it has been shown.
    gcTime: 0,
    onSuccess: (res) => {
      setToken(res.token);
      refresh();
    },
  });
  const toggle = useMutation({
    mutationFn: () => api.saveWebsiteForm({ displayName: f.displayName, formId: f.formId, description: f.description, enabled: !f.enabled, requireService: f.requireService, fixedSource: f.fixedSource, allowedOrigins: f.allowedOrigins }),
    onSuccess: refresh,
  });

  return (
    <div className="space-y-4 text-sm" data-testid="website-leads-panel">
      {f.connectorExists && !f.publicBaseConfigured && (
        <div role="alert" className="rounded-card border border-danger-100 bg-danger-100/50 p-3 text-xs text-danger-700" data-testid="public-url-missing">
          <p className="font-semibold">This API has no valid public address configured.</p>
          <p className="mt-1">Set <code className="font-mono">PUBLIC_API_BASE_URL</code> in the API&apos;s environment to its public https address. Until then the intake address is not shown, because an address a website cannot reach would only mislead. Settings and the token are unaffected.</p>
          {f.intakePath && <p className="mt-1">Path on this API: <code className="font-mono">{f.intakePath}</code></p>}
        </div>
      )}
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-ink">Website Leads — Website Forms</h3>
          <Button size="sm" variant="secondary" disabled title="This version supports one website form per hospital." data-testid="add-form">Add Form</Button>
        </div>
        <p className="text-[11px] text-ink-3">One website form per hospital for now. It covers any number of pages: your website sends the same form ID.</p>
        <div className="overflow-x-auto rounded-card border border-line bg-surface">
          <table className="w-full text-left text-xs" data-testid="website-forms-table">
            <thead className="text-ink-3">
              <tr><th className="px-3 py-2 font-medium">Form name</th><th className="px-3 py-2 font-medium">Form ID</th><th className="px-3 py-2 font-medium">Status</th><th className="px-3 py-2 font-medium">Last submission</th><th className="px-3 py-2 font-medium">Actions</th></tr>
            </thead>
            <tbody>
              <tr className="border-t border-line">
                <td className="px-3 py-2 font-medium text-ink">{f.displayName}</td>
                <td className="px-3 py-2 font-mono">{f.formId}</td>
                <td className="px-3 py-2"><Badge tone={status.tone}>{status.label}</Badge></td>
                <td className="px-3 py-2 text-ink-2" data-testid="website-last-submission">{f.lastSubmissionAt ? relativeTime(f.lastSubmissionAt) : "Never"}</td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-1.5">
                    <Button size="sm" variant="secondary" disabled={!d.webhookUrl} onClick={() => setApiOpen(true)} data-testid="view-api-details">View API details</Button>
                    <Button size="sm" variant="secondary" disabled={!d.canConfigure} onClick={() => setEditing((v) => !v)} data-testid="edit-form">Edit</Button>
                    {d.webhookUrl && <CopyButton id="endpoint" text={d.webhookUrl} label="Copy endpoint" copied={copied} onCopy={copy} />}
                    {f.connectorExists && <Button size="sm" variant="secondary" disabled={!d.canConfigure || toggle.isPending} onClick={() => toggle.mutate()} data-testid="toggle-form">{f.enabled ? "Disable" : "Enable"}</Button>}
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        {toggle.isError && <p role="alert" className="text-xs text-danger-700">Could not change the setting.</p>}
        {f.lastErrorSummary && <p className="rounded-control border border-danger-100 bg-danger-100/50 px-3 py-2 text-xs text-danger-700" data-testid="website-last-error">{f.lastErrorSummary}</p>}
      </div>

      {editing && d.canConfigure && <FormEditor key={`${f.formId}-${f.connectorExists}`} d={d} f={f} onDone={() => { setEditing(false); refresh(); }} />}

      <TokenSection d={d} f={f} token={token} copied={copied} onCopy={copy} onAsk={() => setConfirmRotate(true)} onHide={() => { setToken(null); rotate.reset(); }} pending={rotate.isPending} failed={rotate.isError} />
      <ConfirmDialog
        open={confirmRotate}
        danger
        title={f.hasToken ? "Replace the intake token?" : "Create an intake token?"}
        description={f.hasToken ? "The current token stops working immediately. Your website's server will be refused until you give it the new token, and the connection must be verified again." : "The new token is shown once. Put it in your website's server settings; it must never appear in page JavaScript."}
        confirmLabel={f.hasToken ? "Replace token" : "Create token"}
        onCancel={() => setConfirmRotate(false)}
        onConfirm={() => { setConfirmRotate(false); rotate.mutate(); }}
      />
      {apiOpen && d.webhookUrl && <ApiDetailsDialog url={d.webhookUrl} f={f} onClose={() => setApiOpen(false)} copied={copied} onCopy={copy} />}
    </div>
  );
}

function FormEditor({ d, f, onDone }: { d: IntegrationDetail; f: WebsiteFormView; onDone: () => void }) {
  const [displayName, setDisplayName] = useState(f.displayName);
  const [formId, setFormId] = useState(f.formId);
  const [description, setDescription] = useState(f.description ?? "");
  const [enabled, setEnabled] = useState(f.enabled);
  const [requireService, setRequireService] = useState(f.requireService);
  const [fixedSource, setFixedSource] = useState(f.fixedSource);
  const [origins, setOrigins] = useState(originsToText(f.allowedOrigins));
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => api.saveWebsiteForm({ displayName, formId, description: description.trim() || null, enabled, requireService, fixedSource, allowedOrigins: originsFromText(origins) }),
    onSuccess: onDone,
    onError: (e) => {
      const err = e as ApiError;
      setError(err.status === 400 ? "Check the highlighted values: the Form ID uses lower-case letters, numbers, - and _ (3 to 60 characters), and each allowed origin is a site address such as https://www.clinic.example (https, no path, no *)." : err.status === 403 ? "You do not have permission to change this." : "Could not save. Try again.");
    },
  });
  return (
    <form
      className="space-y-3 rounded-card border border-line bg-surface p-3"
      data-testid="website-form-editor"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        save.mutate();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-xs text-ink-2">Form name<input value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={80} required className={`mt-1 ${field}`} data-testid="form-name" /></label>
        <label className="block text-xs text-ink-2">Form ID<input value={formId} onChange={(e) => setFormId(e.target.value)} maxLength={60} required pattern="[a-z0-9][a-z0-9_\-]{2,59}" className={`mt-1 ${field} font-mono`} data-testid="form-id" />
          <span className="mt-0.5 block text-[11px] text-ink-3">Your website sends this in every request. It labels the form; it does not secure it.</span>
        </label>
      </div>
      <label className="block text-xs text-ink-2">Description (optional)<input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={200} className={`mt-1 ${field}`} data-testid="form-description" /></label>
      <label className="flex items-start gap-2 text-xs text-ink-2"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="mt-0.5" data-testid="form-enabled" /><span>Enabled. When off, every submission is refused. Nothing already received is deleted.</span></label>
      <label className="flex items-start gap-2 text-xs text-ink-2"><input type="checkbox" checked={requireService} onChange={(e) => setRequireService(e.target.checked)} className="mt-0.5" data-testid="form-require-service" /><span>Require service. Submissions without a service are refused.</span></label>
      <label className="flex items-start gap-2 text-xs text-ink-2"><input type="checkbox" checked={fixedSource} onChange={(e) => setFixedSource(e.target.checked)} className="mt-0.5" data-testid="form-fixed-source" /><span>Always record the source as Website, whatever the page&apos;s UTM tags say.</span></label>
      <label className="block text-xs text-ink-2">Allowed origins (one per line, optional)
        <textarea value={origins} onChange={(e) => setOrigins(e.target.value)} rows={3} placeholder="https://www.clinic.example" className={`mt-1 h-auto py-1.5 font-mono ${field}`} data-testid="form-origins" />
        <span className="mt-0.5 block text-[11px] text-ink-3">Refuses a browser request from any other site. This is not authentication: your website&apos;s server still needs the token. Leave empty if only your server calls PulseOS.</span>
      </label>
      {error && <p role="alert" className="rounded-control border border-danger-100 bg-danger-100/50 px-3 py-2 text-xs text-danger-700" data-testid="form-error">{error}</p>}
      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" variant="primary" disabled={save.isPending || !d.canConfigure} data-testid="save-website-form">{save.isPending ? "Saving…" : "Save"}</Button>
        <Button type="button" size="sm" variant="secondary" onClick={onDone}>Cancel</Button>
      </div>
    </form>
  );
}

function TokenSection({ d, f, token, copied, onCopy, onAsk, onHide, pending, failed }: { d: IntegrationDetail; f: WebsiteFormView; token: string | null; copied: string | null; onCopy: (id: string, text: string) => void; onAsk: () => void; onHide: () => void; pending: boolean; failed: boolean }) {
  return (
    <div className="space-y-2 rounded-card border border-line bg-surface p-3" data-testid="website-token-section">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-ink">Intake token</span>
        <Badge tone={f.hasToken ? "success" : "warning"}>{f.hasToken ? "Token active" : "No token"}</Badge>
      </div>
      <p className="text-xs text-ink-2">
        {f.hasToken
          ? "Your website's server sends the token in the X-PulseOS-Intake-Token header. It cannot be shown again; create a new one if it is lost. Creating a new token stops the current one at once."
          : f.requireToken || !f.connectorExists
            ? "No token yet, so PulseOS refuses every submission. Create one to start receiving leads."
            : "No token on this older connection: anyone who has the address can submit. Create a token to close it."}
      </p>
      {token && (
        <div className="space-y-2 rounded-control border border-amber-200 bg-amber-50 p-3" role="status" data-testid="website-token-reveal">
          <p className="text-xs font-semibold text-amber-900">Copy this token now. It is shown once.</p>
          <code className="block break-all rounded-control bg-white px-2 py-1.5 font-mono text-xs" data-testid="website-token-value">{token}</code>
          <div className="flex gap-2">
            <CopyButton id="token" text={token} label="Copy token" copied={copied} onCopy={onCopy} />
            <Button size="sm" variant="secondary" onClick={onHide} data-testid="hide-token"><X size={13} aria-hidden="true" className="mr-1 inline" />I have saved it</Button>
          </div>
          <p className="text-[11px] text-amber-900">Store it in your website server&apos;s environment (for example PULSEOS_INTAKE_TOKEN). Never put it in page JavaScript or a URL.</p>
        </div>
      )}
      <div className="flex items-center gap-3">
        <Button size="sm" variant="primary" disabled={!d.canManageSecrets || pending} onClick={onAsk} data-testid="generate-token">{pending ? "Working…" : f.hasToken ? "Replace token" : "Create token"}</Button>
        {!d.canManageSecrets && <span className="text-xs text-ink-2">Only a Super Admin can create or replace the token.</span>}
        {failed && <span role="alert" className="text-xs text-danger-700">Could not create the token.</span>}
      </div>
    </div>
  );
}

function ApiDetailsDialog({ url, f, onClose, copied, onCopy }: { url: string; f: WebsiteFormView; onClose: () => void; copied: string | null; onCopy: (id: string, text: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  // Shown over the integration sheet, outside its DOM (a portal), so it is never clipped by it. For the same reason it keeps its own
  // keyboard handling, ahead of the sheet's: Escape closes only this dialog, and Tab stays inside it. Focus returns to the opener.
  useEffect(() => {
    const opener = document.activeElement;
    const focusables = () => Array.from(ref.current?.querySelectorAll<HTMLElement>("a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex=\"-1\"])") ?? []);
    (focusables()[0] ?? ref.current)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopImmediatePropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      e.stopImmediatePropagation();
      const els = focusables();
      if (els.length === 0) return;
      const first = els[0]!;
      const last = els[els.length - 1]!;
      const active = document.activeElement;
      if (!ref.current?.contains(active)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (opener instanceof HTMLElement) opener.focus();
    };
  }, [onClose]);
  const json = sampleJson(f.formId);
  const curl = curlExample(url, f.formId);
  const node = nodeExample(f.formId);
  return createPortal(
    <div className="fixed inset-0 z-(--z-dialog) flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Website Form API Details">
      <button type="button" aria-label="Close" onClick={onClose} className="drawer-backdrop absolute inset-0 bg-slate-900/40" />
      <div
        ref={ref}
        tabIndex={-1}
        className="dialog-panel relative max-h-[90dvh] w-full max-w-2xl space-y-4 overflow-y-auto rounded-panel p-5 focus:outline-none"
        data-testid="website-api-details"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-ink">Website Form API Details</h2>
            <p className="text-xs text-ink-3">{f.displayName} · <span className="font-mono">{f.formId}</span></p>
          </div>
          <Button size="sm" variant="secondary" onClick={onClose} data-testid="close-api-details">Close</Button>
        </div>

        <section className="space-y-1.5">
          <h3 className="text-xs font-semibold text-ink">API URL</h3>
          <div className="flex items-start gap-2">
            <code className="block flex-1 break-all rounded-control bg-neutral-100 px-2 py-1.5 font-mono text-xs" data-testid="api-url">{url}</code>
            <CopyButton id="api-url" text={url} label="Copy API URL" copied={copied} onCopy={onCopy} />
          </div>
          {isLocalUrl(url) && <p className="rounded-control border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-800" data-testid="api-url-local-warning">This is a local address: a hospital website on the internet cannot reach it. Set <code className="font-mono">PUBLIC_API_BASE_URL</code> in the API settings to the public address.</p>}
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 pt-1 text-xs">
            <dt className="text-ink-3">Method</dt><dd className="font-medium">POST</dd>
            <dt className="text-ink-3">Content-Type</dt><dd className="font-mono">application/json</dd>
            <dt className="text-ink-3">Authentication</dt><dd className="font-mono">X-PulseOS-Intake-Token: &lt;your intake token&gt;</dd>
          </dl>
        </section>

        <section className="space-y-1.5">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold text-ink">Sample payload</h3>
            <CopyButton id="payload" text={json} label="Copy sample payload" copied={copied} onCopy={onCopy} />
          </div>
          <pre className="max-h-64 overflow-auto rounded-control bg-neutral-100 p-3 font-mono text-[11px] leading-relaxed" data-testid="api-sample-payload">{json}</pre>
        </section>

        <section className="space-y-1.5">
          <h3 className="text-xs font-semibold text-ink">Fields</h3>
          <div className="overflow-x-auto rounded-card border border-line">
            <table className="w-full text-left text-[11px]">
              <tbody>
                {API_FIELDS.map((a) => (
                  <tr key={a.name} className="border-t border-line first:border-t-0">
                    <td className="whitespace-nowrap px-2.5 py-1.5 font-mono font-medium">{a.name}</td>
                    <td className="whitespace-nowrap px-2.5 py-1.5">{a.required ? <Badge tone="primary">required</Badge> : <span className="text-ink-3">optional</span>}</td>
                    <td className="px-2.5 py-1.5 text-ink-2">{a.type}. {a.note}{a.name === "service" && f.requireService ? " Required for this form." : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="space-y-1.5">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold text-ink">Backend request example</h3>
            <div className="flex gap-2">
              <CopyButton id="node" text={node} label="Copy server example" copied={copied} onCopy={onCopy} />
              <CopyButton id="curl" text={curl} label="Copy cURL" copied={copied} onCopy={onCopy} />
            </div>
          </div>
          <pre className="max-h-64 overflow-auto rounded-control bg-neutral-100 p-3 font-mono text-[11px] leading-relaxed" data-testid="api-node-example">{node}</pre>
        </section>

        <section className="space-y-1.5">
          <h3 className="text-xs font-semibold text-ink">Responses</h3>
          <ul className="divide-y divide-line rounded-card border border-line text-[11px]">
            {RESPONSES.map((r) => <li key={r.status} className="flex gap-3 px-2.5 py-1.5"><span className="w-8 shrink-0 font-mono font-semibold">{r.status}</span><span className="text-ink-2">{r.meaning}</span></li>)}
          </ul>
        </section>

        <section className="space-y-1 text-[11px] text-ink-2">
          <h3 className="text-xs font-semibold text-ink">Good to know</h3>
          <ul className="list-disc space-y-1 pl-4">
            <li>Call this from your website&apos;s <strong>server</strong>, over HTTPS, with a timeout. The token must never be in page JavaScript, a URL or browser storage.</li>
            <li>Generate <code className="font-mono">submissionId</code> once per real submission and reuse it on retries. Retry only network errors, 429 and 5xx.</li>
            <li>Allowed origins only filter browser requests; they are not authentication. Server-to-server calls send no Origin and are judged by the token alone.</li>
            <li>Requests from one network address are rate limited (default 20 a minute per address).</li>
            <li>Keep your website&apos;s other destinations (its own database, spreadsheets, another CRM) as they are: PulseOS receiving the lead does not replace them.</li>
          </ul>
        </section>
      </div>
    </div>,
    document.body,
  );
}
