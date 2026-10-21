"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { platformApi } from "@pulseos/api-client";
import { Button, Panel, Skeleton } from "@pulseos/ui";
import { PLAN_META, type Edition, type PlatformSettingsValues } from "@pulseos/types";
import { CONTROL, FormField } from "../../../../components/settings/FormBits";
import { ErrorPanel, PlatformPage, errorMessage } from "../../../../components/platform/ui";
import { usePlatformUser } from "../../../../components/platform/usePlatformUser";
import { PlatformStaffPanel } from "../../../../components/platform/PlatformStaffPanel";

function SettingsForm({ initial, canEdit, emailProvider }: { initial: PlatformSettingsValues; canEdit: boolean; emailProvider: string }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState(initial);
  const [saved, setSaved] = useState<string[] | null>(null);
  const save = useMutation({
    mutationFn: () => platformApi.saveSettings(form),
    onSuccess: async (r) => {
      setSaved(r.changed);
      await queryClient.invalidateQueries({ queryKey: ["platform", "settings"] });
    },
  });
  const num = (k: keyof PlatformSettingsValues) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: Number(e.target.value) }));

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setSaved(null);
        save.mutate();
      }}
      className="space-y-4"
      data-testid="platform-settings-form"
    >
      <div className="grid gap-4 xl:grid-cols-3">
        <Panel title="New tenants" subtitle="Starting values in Create Tenant">
          <div className="grid gap-3">
            <FormField label="Default plan" htmlFor="s-plan">
              <select id="s-plan" disabled={!canEdit} className={CONTROL} value={form.defaultEdition} onChange={(e) => setForm((f) => ({ ...f, defaultEdition: e.target.value as Edition }))}>
                {(Object.keys(PLAN_META) as Edition[]).map((e) => (
                  <option key={e} value={e}>
                    {PLAN_META[e].name}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField label="Default time zone" htmlFor="s-tz">
              <input id="s-tz" disabled={!canEdit} className={CONTROL} value={form.defaultTimezone} onChange={(e) => setForm((f) => ({ ...f, defaultTimezone: e.target.value }))} />
            </FormField>
            <FormField label="Default locale" htmlFor="s-locale">
              <input id="s-locale" disabled={!canEdit} className={CONTROL} value={form.defaultLocale} onChange={(e) => setForm((f) => ({ ...f, defaultLocale: e.target.value }))} />
            </FormField>
          </div>
        </Panel>
        <Panel title="Access links" subtitle="Invitations and password resets">
          <div className="grid gap-3">
            <FormField label="Link lifetime (hours)" hint="Applies to every new invitation and reset link" htmlFor="s-exp">
              <input id="s-exp" type="number" min={1} max={336} disabled={!canEdit} className={CONTROL} value={form.invitationExpiryHours} onChange={num("invitationExpiryHours")} />
            </FormField>
            <p className="text-xs text-ink-2">
              Email delivery: {emailProvider === "none" ? "no provider is configured, so links are created but not delivered." : emailProvider === "local_outbox" ? "local development outbox." : emailProvider}
            </p>
          </div>
        </Panel>
        <Panel title="Support Mode" subtitle="Limits for every support session">
          <div className="grid gap-3">
            <FormField label="Default session (minutes)" htmlFor="s-sd">
              <input id="s-sd" type="number" min={5} max={240} disabled={!canEdit} className={CONTROL} value={form.supportSessionDefaultMinutes} onChange={num("supportSessionDefaultMinutes")} />
            </FormField>
            <FormField label="Longest session (minutes)" htmlFor="s-sm">
              <input id="s-sm" type="number" min={5} max={480} disabled={!canEdit} className={CONTROL} value={form.supportSessionMaxMinutes} onChange={num("supportSessionMaxMinutes")} />
            </FormField>
            <FormField label="Longest edit window (minutes)" htmlFor="s-em">
              <input id="s-em" type="number" min={5} max={120} disabled={!canEdit} className={CONTROL} value={form.supportEditsMaxMinutes} onChange={num("supportEditsMaxMinutes")} />
            </FormField>
          </div>
        </Panel>
      </div>
      <Panel title="Platform support contact" subtitle="Shown to hospital staff whose workspace is unavailable, and in account emails">
        <FormField label="Contact" hint="For example an email address or phone number. Leave empty to say “your PulseOS administrator”." htmlFor="s-contact">
          <input id="s-contact" maxLength={160} disabled={!canEdit} className={CONTROL} value={form.supportContact} onChange={(e) => setForm((f) => ({ ...f, supportContact: e.target.value }))} />
        </FormField>
      </Panel>
      {canEdit ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" variant="primary" disabled={save.isPending} data-testid="save-settings">
            {save.isPending ? "Saving…" : "Save settings"}
          </Button>
          {saved && <span role="status" className="text-xs text-accent-700">{saved.length ? `Saved: ${saved.join(", ")}.` : "Nothing changed."}</span>}
          {save.isError && <span role="alert" className="text-xs text-danger-700">{errorMessage(save.error)}</span>}
        </div>
      ) : (
        <p className="text-xs text-ink-2">Only a Platform Owner can change these settings.</p>
      )}
    </form>
  );
}

/** Only genuinely global settings with real behaviour - not a dumping ground. */
export default function SettingsPage() {
  const { can } = usePlatformUser();
  const q = useQuery({ queryKey: ["platform", "settings"], queryFn: platformApi.settings });
  return (
    <PlatformPage title="Platform Settings" subtitle="Global defaults and limits. Every change is audited." testId="platform-settings">
      {q.isError ? <ErrorPanel error={q.error} onRetry={() => q.refetch()} /> : !q.data ? <Skeleton className="h-64 w-full" /> : <SettingsForm initial={q.data.settings} canEdit={can("MANAGE_PLATFORM_SETTINGS")} emailProvider={q.data.emailProvider} />}
      <PlatformStaffPanel />
    </PlatformPage>
  );
}
