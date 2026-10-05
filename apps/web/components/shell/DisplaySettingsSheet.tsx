"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@pulseos/api-client";
import { Button, SideSheet } from "@pulseos/ui";
import { DEFAULT_INTERFACE_SIZE, DEFAULT_SURFACE_STYLE, DEFAULT_TEXT_SIZE, INTERFACE_SIZES, INTERFACE_SIZE_LABEL, TEXT_SIZES, TEXT_SIZE_LABEL, type InterfaceSize, type TextSize } from "@pulseos/types";
import { AppearancePreview } from "@/components/settings/AppearanceSection";
import { FormError } from "@/components/settings/FormBits";

function Choice<K extends string>({ name, legend, options, value, onChange, labels, defaultKey, testPrefix }: { name: string; legend: string; options: readonly K[]; value: K; onChange: (k: K) => void; labels: Record<K, { label: string; hint: string }>; defaultKey: K; testPrefix: string }) {
  return (
    <fieldset>
      <legend className="text-xs font-semibold text-ink">{legend}</legend>
      <div className="mt-2 grid gap-2" role="radiogroup" aria-label={legend}>
        {options.map((key) => (
          <label
            key={key}
            className={`relative flex min-h-11 cursor-pointer items-start gap-2.5 rounded-card border px-3 py-2 text-xs transition focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-focus-ring ${value === key ? "border-primary-500 bg-primary-50" : "border-line bg-surface hover:bg-primary-50"}`}
          >
            {/* The real input fills the whole row (a 44px+ tap target, keyboard and screen-reader native); the dot is only its picture. */}
            <input type="radio" name={name} value={key} checked={value === key} onChange={() => onChange(key)} className="peer absolute inset-0 h-full w-full cursor-pointer opacity-0" data-testid={`${testPrefix}-${key}`} />
            <span aria-hidden="true" className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-line-strong bg-surface peer-checked:border-primary-600 peer-checked:*:opacity-100">
              <span className="h-2 w-2 rounded-full bg-primary-600 opacity-0" />
            </span>
            <span>
              <span className="block font-semibold text-ink">
                {labels[key].label}
                {key === defaultKey ? <span className="ml-1.5 font-normal text-ink-2">(standard)</span> : null}
              </span>
              <span className="block text-ink-2">{labels[key].hint}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/**
 * "Display settings" from the profile menu - for EVERY role. Two independent choices that belong to the signed-in person alone:
 * Interface size (spacing, control and row size) and Text size. The preview shows the choice at once; the real interface changes
 * only on Save (stored on the person's account, so it follows them), and Cancel discards. A failed save keeps what was picked.
 */
export function DisplaySettingsSheet({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const session = useQuery({ queryKey: ["session"], queryFn: api.session, staleTime: 60_000 });
  const savedUi: InterfaceSize = session.data?.user.interfaceSize ?? DEFAULT_INTERFACE_SIZE;
  const savedText: TextSize = session.data?.user.textSize ?? DEFAULT_TEXT_SIZE;
  const [ui, setUi] = useState<InterfaceSize | null>(null);
  const [text, setText] = useState<TextSize | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const uiChoice = ui ?? savedUi;
  const textChoice = text ?? savedText;
  const changed = uiChoice !== savedUi || textChoice !== savedText;

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await api.setMyPreferences({ interfaceSize: uiChoice, textSize: textChoice });
      await queryClient.invalidateQueries({ queryKey: ["session"] });
      onClose();
    } catch {
      setError("Could not save your display settings. Your choices are still selected - try again.");
      setSaving(false);
    }
  }

  return (
    <SideSheet
      title="Display settings"
      subtitle="Only for you. Everyone else keeps their own."
      onClose={onClose}
      testId="display-settings"
      footer={
        <>
          <Button variant="secondary" className="min-h-11 sm:min-h-0" onClick={onClose} disabled={saving} data-testid="display-cancel">
            Cancel
          </Button>
          <Button variant="primary" className="min-h-11 sm:min-h-0" onClick={save} disabled={!changed || saving} data-testid="display-save">
            {saving ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <FormError message={error} testId="display-error" />
        <Choice name="interface-size" legend="Interface size" options={INTERFACE_SIZES} value={uiChoice} onChange={setUi} labels={INTERFACE_SIZE_LABEL} defaultKey={DEFAULT_INTERFACE_SIZE} testPrefix="display-interface" />
        <Choice name="text-size" legend="Text size" options={TEXT_SIZES} value={textChoice} onChange={setText} labels={TEXT_SIZE_LABEL} defaultKey={DEFAULT_TEXT_SIZE} testPrefix="display-text" />
        <div>
          <p className="mb-2 text-xs font-semibold text-ink">Preview</p>
          <AppearancePreview style={session.data?.user.surfaceStyle ?? DEFAULT_SURFACE_STYLE} uiSize={uiChoice} textSize={textChoice} />
        </div>
      </div>
    </SideSheet>
  );
}
