"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { platformApi } from "@pulseos/api-client";
import { Button, Panel } from "@pulseos/ui";
import { SURFACE_STYLES, SURFACE_STYLE_LABEL, type PlatformTenantDetail, type SurfaceStyle } from "@pulseos/types";
import { CONTROL, FormField } from "../../settings/FormBits";
import { errorMessage } from "../ui";

const FIELDS = [
  { key: "shortName", label: "Short name", max: 40 },
  { key: "headline", label: "Headline", max: 120 },
  { key: "tagline", label: "Tagline", max: 160 },
  { key: "badgeLabel", label: "Badge", max: 24 },
  { key: "supportText", label: "Support text", max: 160 },
  { key: "logoPath", label: "Logo file", max: 100, hint: "A file in the app's /brand folder, e.g. /brand/namokar.svg" },
] as const;
type FieldKey = (typeof FIELDS)[number]["key"];

/**
 * The hospital's own sign-in page (/login/<slug>) and interface style. Safe structured words only - never HTML, colours or
 * scripts - and never a developer control: Developer Access exists only on a local development machine.
 */
export function TenantBrandingTab({ detail, canEdit }: { detail: PlatformTenantDetail; canEdit: boolean }) {
  const queryClient = useQueryClient();
  const tenantId = detail.tenant.id;
  const initial = Object.fromEntries(FIELDS.map((f) => [f.key, detail.branding?.[f.key] ?? ""])) as Record<FieldKey, string>;
  const [form, setForm] = useState(initial);
  const [saved, setSaved] = useState(false);
  const save = useMutation({
    mutationFn: () => platformApi.saveTenantBranding(tenantId, Object.fromEntries(FIELDS.map((f) => [f.key, form[f.key].trim() || null]))),
    onSuccess: () => {
      setSaved(true);
      return queryClient.invalidateQueries({ queryKey: ["platform", "tenant", tenantId] });
    },
  });
  const appearance = useMutation({
    mutationFn: (style: SurfaceStyle) => platformApi.saveTenantAppearance(tenantId, style),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["platform", "tenant", tenantId] }),
  });
  const current = (detail.tenant.surfaceStyle ?? "balanced") as SurfaceStyle;

  return (
    <div className="grid gap-4 xl:grid-cols-[1.4fr_1fr]" data-testid="tenant-branding">
      <Panel title="Sign-in page" subtitle={detail.loginPath ? `Shown at ${detail.loginPath}` : "This tenant has no sign-in address yet"}>
        <form
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            setSaved(false);
            save.mutate();
          }}
        >
          {FIELDS.map((f) => (
            <FormField key={f.key} label={f.label} hint={"hint" in f ? f.hint : undefined} htmlFor={`brand-${f.key}`}>
              <input id={`brand-${f.key}`} disabled={!canEdit} maxLength={f.max} className={CONTROL} value={form[f.key]} onChange={(e) => setForm((s) => ({ ...s, [f.key]: e.target.value }))} />
            </FormField>
          ))}
          {canEdit && (
            <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
              <Button type="submit" variant="primary" disabled={save.isPending} data-testid="save-branding">
                {save.isPending ? "Saving…" : "Save sign-in page"}
              </Button>
              {saved && !save.isPending && <span className="text-xs text-accent-700" role="status">Saved.</span>}
              {save.isError && (
                <span role="alert" className="text-xs text-danger-700">
                  {errorMessage(save.error)}
                </span>
              )}
            </div>
          )}
        </form>
      </Panel>
      <Panel title="Appearance" subtitle="The hospital's interface style. Tenant Super Admins can change it too.">
        <div className="space-y-2" role="radiogroup" aria-label="Interface style">
          {SURFACE_STYLES.map((s) => (
            <label key={s} className={`flex cursor-pointer items-start gap-3 rounded-card border p-3 ${current === s ? "border-primary-500 bg-primary-50" : "border-line bg-white"} ${!canEdit ? "cursor-default opacity-80" : ""}`}>
              <input type="radio" name="surface" checked={current === s} disabled={!canEdit || appearance.isPending} onChange={() => appearance.mutate(s)} className="mt-1 h-4 w-4 accent-primary-600" />
              <span>
                <span className="block text-sm font-medium text-ink">{SURFACE_STYLE_LABEL[s].label}</span>
                <span className="block text-xs text-ink-2">{SURFACE_STYLE_LABEL[s].hint}</span>
              </span>
            </label>
          ))}
          {appearance.isError && <p role="alert" className="text-xs text-danger-700">{errorMessage(appearance.error)}</p>}
        </div>
      </Panel>
    </div>
  );
}
