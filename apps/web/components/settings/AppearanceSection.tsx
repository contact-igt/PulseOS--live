"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@pulseos/api-client";
import { MetricStrip } from "@pulseos/ui";
import { DEFAULT_SURFACE_STYLE, SURFACE_STYLES, SURFACE_STYLE_LABEL, type InterfaceSize, type SurfaceStyle, type TextSize } from "@pulseos/types";
import { ChevronDown, Plus } from "lucide-react";

/**
 * Settings > Appearance: ONE controlled preference per hospital - how solid the interface surfaces look. Three named styles
 * (never an opacity number or a CSS value). Changing the choice updates the preview at once; the hospital's real interface
 * changes only on Save (which the server stores per hospital), and Cancel puts the saved style back. A failed save keeps what
 * was chosen and says so.
 */
export function AppearanceSection() {
  const queryClient = useQueryClient();
  const session = useQuery({ queryKey: ["session"], queryFn: api.session, staleTime: 60_000 });
  const saved: SurfaceStyle = session.data?.user.surfaceStyle ?? DEFAULT_SURFACE_STYLE;
  const [picked, setPicked] = useState<SurfaceStyle | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const choice = picked ?? saved;
  const changed = choice !== saved;

  async function save() {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await api.setAppearance(choice);
      await queryClient.invalidateQueries({ queryKey: ["session"] });
      setPicked(null);
      setNotice("Saved. Everyone in this hospital now sees this style.");
    } catch {
      // The selection stays exactly as chosen so it can be retried.
      setError("Could not save the interface style. Your choice is still selected - try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="grid gap-5 p-4 lg:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]" data-testid="appearance-section">
      <fieldset>
        <legend className="text-xs font-semibold text-ink">Interface style</legend>
        <p className="mt-0.5 text-[11px] text-ink-2">Applies to everyone in this hospital. Menus and tables always stay clearly readable.</p>
        <div className="mt-3 space-y-2" role="radiogroup" aria-label="Interface style">
          {SURFACE_STYLES.map((key) => (
            <label
              key={key}
              className={`relative flex min-h-11 cursor-pointer items-start gap-2.5 rounded-card border px-3 py-2 text-xs transition focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-focus-ring ${choice === key ? "border-primary-500 bg-primary-50" : "border-line bg-surface hover:bg-primary-50"}`}
            >
              {/* The real input fills the whole row (a 44px+ tap target, keyboard and screen-reader native); the dot is only its picture. */}
              <input
                type="radio"
                name="surface-style"
                value={key}
                checked={choice === key}
                onChange={() => {
                  setPicked(key);
                  setError(null);
                  setNotice(null);
                }}
                className="peer absolute inset-0 h-full w-full cursor-pointer opacity-0"
                data-testid={`appearance-option-${key}`}
              />
              <span aria-hidden="true" className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-line-strong bg-surface peer-checked:border-primary-600 peer-checked:*:opacity-100">
                <span className="h-2 w-2 rounded-full bg-primary-600 opacity-0" />
              </span>
              <span>
                <span className="block font-semibold text-ink">
                  {SURFACE_STYLE_LABEL[key].label}
                  {key === DEFAULT_SURFACE_STYLE ? <span className="ml-1.5 font-normal text-ink-2">(recommended)</span> : null}
                </span>
                <span className="block text-ink-2">{SURFACE_STYLE_LABEL[key].hint}</span>
              </span>
            </label>
          ))}
        </div>

        {error && (
          <p role="alert" className="mt-3 rounded-control border border-danger-100 bg-danger-100/60 px-2.5 py-1.5 text-xs text-danger-700" data-testid="appearance-error">
            {error}
          </p>
        )}
        {notice && !changed && (
          <p role="status" className="mt-3 text-xs text-success-700" data-testid="appearance-notice">
            {notice}
          </p>
        )}
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={save}
            disabled={!changed || saving}
            aria-busy={saving}
            className="min-h-11 rounded-control bg-primary-600 px-4 text-xs font-semibold text-white transition hover:bg-primary-700 disabled:cursor-not-allowed disabled:bg-primary-200 sm:min-h-9"
            data-testid="appearance-save"
          >
            {saving ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            onClick={() => {
              setPicked(null);
              setError(null);
            }}
            disabled={!changed || saving}
            className="min-h-11 rounded-control border border-line-strong bg-surface px-4 text-xs font-medium text-ink transition hover:bg-primary-50 disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-9"
            data-testid="appearance-cancel"
          >
            Cancel
          </button>
        </div>
      </fieldset>

      <div>
        <p className="mb-2 text-xs font-semibold text-ink">Preview</p>
        <p className="sr-only">A small preview of the top bar, an open menu, a summary strip, a list row and a panel in the selected style.</p>
        <AppearancePreview style={choice} />
      </div>
    </div>
  );
}

/**
 * A compact PulseOS workspace, not a fake dashboard. It carries the chosen style on its own element (the surface tokens are
 * scoped by that attribute), so it shows the real classes - top bar, floating menu, summary strip, control, list row, sheet -
 * without changing the page around it. It is inert: no tab stops, hidden from assistive technology (the paragraph above
 * describes it).
 */
export function AppearancePreview({ style, uiSize, textSize }: { style: SurfaceStyle; uiSize?: InterfaceSize; textSize?: TextSize }) {
  return (
    <div
      data-surface={style}
      {...(uiSize ? { "data-ui-size": uiSize } : {})}
      {...(textSize ? { "data-text-size": textSize } : {})}
      data-testid="appearance-preview"
      aria-hidden="true"
      inert
      className="relative overflow-hidden rounded-panel border border-line p-3 pb-4"
      style={{ background: "var(--ambient)" }}
    >
      {/* Text the open menu sits on top of: a see-through menu would show it. */}
      <div className="glass-strong flex items-center justify-between gap-2 rounded-card px-3 py-2" data-testid="preview-topbar">
        <span className="text-xs font-semibold text-ink">PulseOS Preview</span>
        <div className="flex items-center gap-2">
          <span className="glass-control inline-flex h-8 items-center gap-1 rounded-control px-2 text-[11px] font-medium text-ink" data-testid="preview-select">
            Team Member <ChevronDown size={12} />
          </span>
          <span className="inline-flex h-8 items-center gap-1 rounded-control bg-primary-600 px-2.5 text-[11px] font-semibold text-white" data-testid="preview-create">
            <Plus size={12} /> Create
          </span>
        </div>
      </div>

      <div className="relative mt-2.5">
        <div className="floating absolute right-0 top-0 z-10 w-36 rounded-card py-1 text-[11px]" data-testid="preview-menu">
          {["Add Lead", "Add Appointment", "Add Task"].map((l, i) => (
            <span key={l} className={`block px-3 py-1.5 font-medium text-ink ${i === 0 ? "bg-primary-50" : ""}`}>{l}</span>
          ))}
        </div>
        <div className="max-w-[70%]">
          <MetricStrip
            layout="inline"
            cells={[
              { key: "a", label: "Appointments today", value: 9 },
              { key: "n", label: "New leads", value: 4 },
            ]}
          />
        </div>
      </div>

      <div className="surface-content mt-2.5 flex items-center justify-between gap-2 rounded-card border border-line px-3 py-2 text-[11px]" data-testid="preview-row">
        <span className="font-semibold text-ink">Shilpa Joshi</span>
        <span className="text-ink-2">Cataract · Callback due 3 pm</span>
      </div>

      <div className="dialog-panel mt-2.5 rounded-card px-3 py-2 text-[11px]" style={{ animation: "none" }} data-testid="preview-sheet">
        <span className="block font-semibold text-ink">Log call</span>
        <span className="block text-ink-2">A sheet or dialog keeps its body clear of the page behind it.</span>
      </div>
    </div>
  );
}
