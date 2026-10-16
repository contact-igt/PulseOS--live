import { ArrowRight } from "lucide-react";
import { CONTAINER, Eyebrow, Pill } from "./ui";
import { ARRIVAL, CORE, EXISTING_STACK, INTEGRATIONS, SYSTEM_ROLES } from "./content";

export function SystemMap() {
  return (
    <section id="integrations" aria-labelledby="map-title" className="mk-anchor bg-white py-20 sm:py-28">
      <div className={CONTAINER}>
        <div className="max-w-[900px]">
          <Eyebrow>Where PulseOS fits</Eyebrow>
          <h2 id="map-title" className="mt-4 text-balance text-[36px] font-semibold leading-[1.05] tracking-[-0.03em] text-ink sm:text-[48px] lg:text-[60px]">
            PulseOS connects the space between acquisition and clinical care.
          </h2>
        </div>

        <div className="mt-12 grid grid-cols-1 items-stretch gap-4 lg:grid-cols-[1fr_auto_1.2fr_auto_1fr]" data-testid="system-map">
          <div className="rounded-panel border border-line bg-surface-muted p-5">
            <p className="text-[12px] font-semibold uppercase tracking-[0.12em] text-ink-2">Patient arrival</p>
            <ul className="mt-4 flex flex-wrap gap-2">
              {ARRIVAL.map((s) => <li key={s} className="rounded-card border border-line bg-white px-3 py-2 text-[15px] font-medium text-ink">{s}</li>)}
            </ul>
          </div>
          <ArrowRight className="mx-auto self-center rotate-90 text-brand lg:rotate-0" aria-hidden="true" />
          <div className="rounded-panel border-2 border-primary-300 bg-primary-50 p-5 shadow-glass">
            <p className="text-[12px] font-semibold uppercase tracking-[0.12em] text-brand">PulseOS</p>
            <ul className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
              {CORE.map((c) => <li key={c} className="rounded-card border border-line bg-white px-3 py-2 text-[15px] font-medium text-ink">{c}</li>)}
            </ul>
          </div>
          <ArrowRight className="mx-auto self-center rotate-90 text-brand lg:rotate-0" aria-hidden="true" />
          <div className="rounded-panel border border-line bg-surface-muted p-5">
            <p className="text-[12px] font-semibold uppercase tracking-[0.12em] text-ink-2">Your existing stack</p>
            <ul className="mt-4 flex flex-wrap gap-2">
              {EXISTING_STACK.map((s) => <li key={s} className="rounded-card border border-line bg-white px-3 py-2 text-[15px] font-medium text-ink">{s}</li>)}
            </ul>
            <p className="mt-4 text-sm text-ink-2">Clinical charting, prescriptions and billing stay where they belong.</p>
          </div>
        </div>

        <ul className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-3" data-testid="system-roles">
          {SYSTEM_ROLES.map((r) => (
            <li key={r.name} className="rounded-panel border border-line bg-white p-5">
              <h3 className="text-[18px] font-semibold tracking-tight text-ink">{r.name}</h3>
              <p className="mt-3 text-[12px] font-semibold uppercase tracking-wide text-ink-2">Great at</p>
              <p className="text-[16px] text-ink">{r.great}</p>
              <p className="mt-3 text-[12px] font-semibold uppercase tracking-wide text-brand">PulseOS adds</p>
              <p className="text-[16px] font-medium text-ink">{r.adds}</p>
            </li>
          ))}
        </ul>

        <div className="mt-20 max-w-[860px]">
          <h3 className="text-balance text-[28px] font-semibold leading-[1.1] tracking-[-0.02em] text-ink sm:text-[38px]">Designed to fit the systems your hospital already uses.</h3>
        </div>
        <ul className="mt-8 grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3" data-testid="integration-states">
          {INTEGRATIONS.map((i) => (
            <li key={i.category} className="flex flex-col rounded-card border border-line bg-white p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-[16px] font-semibold text-ink">{i.category}</p>
                  <p className="text-sm text-ink-2">{i.items}</p>
                </div>
                <Pill tone={i.state === "Works today" ? "success" : i.state === "Integration-ready" ? "primary" : "neutral"}>{i.state}</Pill>
              </div>
              <p className="mt-3 text-[14px] leading-relaxed text-ink-2">{i.note}</p>
            </li>
          ))}
        </ul>
        <p className="mt-5 text-sm text-ink-2">Integration-ready means the capability is built; your hospital connects its own account. Nothing is connected on your behalf.</p>
      </div>
    </section>
  );
}
