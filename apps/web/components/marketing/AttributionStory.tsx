import { CONTAINER, Eyebrow } from "./ui";
import { ATTRIBUTION } from "./content";

export function AttributionStory() {
  return (
    <section aria-labelledby="attr-title" className="mk-section-ice border-y border-line py-20 sm:py-28">
      <div className={CONTAINER}>
        <div className="max-w-[900px]">
          <Eyebrow>Beyond leads</Eyebrow>
          <h2 id="attr-title" className="mt-4 text-balance text-[36px] font-semibold leading-[1.05] tracking-[-0.03em] text-ink sm:text-[48px] lg:text-[60px]">
            A lead count tells you who enquired. PulseOS tells you what happened next.
          </h2>
        </div>
        <div className="mt-12 grid grid-cols-1 gap-5 lg:grid-cols-[0.8fr_1.2fr]">
          <div className="rounded-panel border border-line bg-white p-6">
            <p className="text-[12px] font-semibold uppercase tracking-[0.12em] text-ink-2">A typical marketing report</p>
            <ul className="mt-5 space-y-3">
              {ATTRIBUTION.map((r) => (
                <li key={r.source} className="flex items-center justify-between rounded-card border border-line bg-surface-muted px-4 py-4 text-[18px]">
                  <span className="font-medium text-ink">{r.source}</span>
                  <span className="tabular-nums text-ink-2">{r.leads} leads</span>
                </li>
              ))}
            </ul>
            <p className="mt-5 text-[15px] text-ink-2">Which of them actually came? The report can&apos;t say.</p>
          </div>
          <div className="rounded-panel border border-primary-300 bg-white p-6 shadow-glass">
            <p className="text-[12px] font-semibold uppercase tracking-[0.12em] text-brand">PulseOS</p>
            <ul className="mt-5 space-y-3">
              {ATTRIBUTION.map((r) => (
                <li key={r.source} className="rounded-card border border-line bg-surface-muted px-4 py-4">
                  <p className="text-[18px] font-semibold text-ink">{r.source}</p>
                  <dl className="mt-3 grid grid-cols-4 gap-2">
                    {([["Enquiries", r.leads], ["Appointments", r.appointments], ["Consultations", r.consultations], ["Procedures done", r.procedures]] as const).map(([l, v]) => (
                      <div key={l}>
                        <dd className="text-[26px] font-semibold leading-none tabular-nums tracking-tight text-ink">{v}</dd>
                        <dt className="mt-1 text-[11px] leading-tight text-ink-2 sm:text-xs">{l}</dt>
                      </div>
                    ))}
                  </dl>
                </li>
              ))}
            </ul>
            <p className="mt-5 text-[15px] text-ink-2">Same enquiries, very different outcomes.</p>
          </div>
        </div>
        <p className="mt-5 text-sm text-ink-2">Illustrative data. Not customer results.</p>
      </div>
    </section>
  );
}
