"use client";

import { useState } from "react";
import { Card } from "@pulseos/ui/src/primitives";
import { CONTAINER, Eyebrow, Pill } from "./ui";
import { CRM_FIELDS, FIRST_ENQUIRY_FIELDS, LATER_FIELDS } from "./content";

function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className="inline-flex h-11 w-14 shrink-0 items-center justify-center rounded-control"
    >
      <span className={`relative inline-flex h-7 w-12 items-center rounded-full transition ${on ? "bg-brand" : "bg-neutral-300"}`} aria-hidden="true">
        <span className={`inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${on ? "translate-x-6" : "translate-x-1"}`} />
      </span>
      <span className="sr-only">{on ? "On" : "Off"}</span>
    </button>
  );
}

const CHIPS: Record<string, string[]> = {
  Services: ["Cataract", "Oculoplasty", "Squint", "Laser vision correction"],
  "Lead sources": ["Google", "Meta", "Website", "Walk-in", "Referral"],
  "Clinic hours": ["Mon–Sat 9:00–18:00", "Sun closed"],
};

export function WorkflowConfigurator() {
  const [on, setOn] = useState<Record<string, boolean>>(() => Object.fromEntries(CRM_FIELDS.map((f) => [f.key, f.on])));

  return (
    <section aria-labelledby="config-title" className="mk-section-ice border-y border-line py-20 sm:py-28">
      <div className={CONTAINER}>
        <div className="max-w-[860px]">
          <Eyebrow>Configure</Eyebrow>
          <h2 id="config-title" className="mt-4 text-balance text-[36px] font-semibold leading-[1.05] tracking-[-0.03em] text-ink sm:text-[48px] lg:text-[60px]">
            Your workflow shouldn&apos;t be hard-coded.
          </h2>
          <p className="mt-5 max-w-[650px] text-[18px] leading-relaxed text-ink-2">Choose what you collect, where it appears and what&apos;s required. Try the switches.</p>
        </div>

        <div className="mt-12 grid grid-cols-1 gap-5 lg:grid-cols-2">
          <Card>
            <div className="border-b border-line px-4 py-3">
              <h3 className="text-[14px] font-semibold text-ink">Settings · CRM fields</h3>
              <p className="text-xs text-ink-2">Show on Add Lead</p>
            </div>
            <ul>
              {CRM_FIELDS.map((f) => (
                <li key={f.key} className="flex items-center justify-between gap-4 border-t border-line px-4 py-3.5 first:border-t-0">
                  <span>
                    <span className="block text-[15px] font-medium text-ink">{f.name}</span>
                    <span className="block text-xs text-ink-2">{f.detail}</span>
                  </span>
                  <span className="flex items-center gap-3">
                    <Pill tone={on[f.key] ? "primary" : "neutral"}>{on[f.key] ? "ON" : "OFF"}</Pill>
                    <Switch on={!!on[f.key]} label={`Show ${f.name} on Add Lead`} onChange={(v) => setOn((s) => ({ ...s, [f.key]: v }))} />
                  </span>
                </li>
              ))}
            </ul>
          </Card>

          <Card className="shadow-glass">
            <div className="border-b border-line px-4 py-3">
              <h3 className="text-[14px] font-semibold text-ink">Add Lead</h3>
              <p className="text-xs text-ink-2">What your front desk sees</p>
            </div>
            <div className="grid grid-cols-1 gap-3 px-4 py-4 sm:grid-cols-2" data-testid="add-lead-preview">
              {[...FIRST_ENQUIRY_FIELDS.filter((f) => f !== "New / existing"), ...CRM_FIELDS.filter((f) => on[f.key]).map((f) => f.name)].map((label) => (
                <div key={label}>
                  <p className="mb-1 text-[11px] font-medium text-ink-2">{label}{label === "Phone" ? " *" : ""}</p>
                  <p className="h-10 rounded-control border border-line-strong bg-white" />
                </div>
              ))}
            </div>
          </Card>
        </div>

        <ul className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-3" aria-label="Also configurable">
          {Object.entries(CHIPS).map(([title, items]) => (
            <li key={title} className="rounded-card border border-line bg-white p-4">
              <p className="text-[14px] font-semibold text-ink">{title}</p>
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {items.map((i) => (
                  <li key={i} className="rounded-chip bg-primary-50 px-2 py-1 text-xs text-primary-800 ring-1 ring-inset ring-primary-200">{i}</li>
                ))}
              </ul>
            </li>
          ))}
        </ul>

        <div className="mt-20 max-w-[860px]">
          <h3 className="text-balance text-[30px] font-semibold leading-[1.1] tracking-[-0.025em] text-ink sm:text-[40px]">An enquiry is not a registration form.</h3>
          <p className="mt-4 max-w-[650px] text-[18px] leading-relaxed text-ink-2">Collect what matters at the right moment. Your front desk shouldn&apos;t fill 15 fields just to save a phone enquiry.</p>
        </div>
        <div className="mt-8 grid grid-cols-1 gap-4 md:grid-cols-2" data-testid="intake-states">
          <div className="rounded-panel border border-primary-300 bg-white p-5 shadow-glass">
            <p className="text-[12px] font-semibold uppercase tracking-[0.12em] text-brand">First enquiry</p>
            <ul className="mt-4 flex flex-wrap gap-2">
              {FIRST_ENQUIRY_FIELDS.map((f) => <li key={f} className="rounded-control border border-line-strong bg-white px-3 py-2 text-[15px] text-ink">{f}</li>)}
            </ul>
          </div>
          <div className="rounded-panel border border-line bg-white p-5">
            <p className="text-[12px] font-semibold uppercase tracking-[0.12em] text-ink-2">Later, when needed</p>
            <ul className="mt-4 flex flex-wrap gap-2">
              {LATER_FIELDS.map((f) => <li key={f} className="rounded-control border border-dashed border-line-strong bg-surface-muted px-3 py-2 text-[15px] text-ink-2">{f}</li>)}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}
