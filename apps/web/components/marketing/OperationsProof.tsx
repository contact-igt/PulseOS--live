import { ChevronDown } from "lucide-react";
import { CONTAINER, Eyebrow } from "./ui";
import { FAQ, PROOF, SECURITY_POINTS } from "./content";

export function OperationsProof() {
  return (
    <>
      <section aria-labelledby="ops-title" className="bg-white py-20 sm:py-28">
        <div className={CONTAINER}>
          <div className="max-w-[860px]">
            <Eyebrow>Built for hospital operations</Eyebrow>
            <h2 id="ops-title" className="mt-4 text-balance text-[36px] font-semibold leading-[1.05] tracking-[-0.03em] text-ink sm:text-[48px] lg:text-[60px]">
              Built around how Indian hospitals actually follow up.
            </h2>
            <p className="mt-5 max-w-[650px] text-[18px] leading-relaxed text-ink-2">Phone-first enquiries, WhatsApp, walk-ins, referrals and campaigns. A front desk, a coordinator, a doctor and an owner who all need the same patient story.</p>
          </div>
          <ul className="mt-10 grid grid-cols-1 gap-x-8 gap-y-5 sm:grid-cols-2 lg:grid-cols-5" data-testid="product-proof">
            {PROOF.map((p) => (
              <li key={p} className="border-l-2 border-brand pl-4 text-[17px] font-medium leading-snug text-ink">{p}</li>
            ))}
          </ul>

          <ul className="mt-16 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4" aria-label="Security and control">
            {SECURITY_POINTS.map((s) => (
              <li key={s.title} className="rounded-panel border border-line bg-surface-muted p-5">
                <h3 id={s.title === "Role-based access" ? "security-title" : undefined} className="text-[17px] font-semibold tracking-tight text-ink">{s.title}</h3>
                <p className="mt-2 text-[15px] leading-relaxed text-ink-2">{s.body}</p>
              </li>
            ))}
          </ul>

          <div id="evidence" className="mk-anchor mt-16 grid grid-cols-1 gap-6 rounded-panel border border-line bg-surface-info p-6 sm:p-8 lg:grid-cols-2">
            <div>
              <p className="text-[12px] font-semibold uppercase tracking-[0.12em] text-brand">Reminders matter</p>
              <p className="mt-3 text-[22px] font-semibold leading-snug tracking-tight text-ink">Published healthcare research has repeatedly found that reminders improve attendance.</p>
            </div>
            <div>
              <p className="text-[16px] leading-relaxed text-ink-2">
                One systematic review and meta-analysis found patients who received digital (text-message) notifications were 23% more likely to attend clinic and 25% less likely to no-show than those who received none.
              </p>
              <p className="mt-3 text-sm leading-relaxed text-ink-2">
                Independent research, not a PulseOS result. Source:{" "}
                <a className="font-medium text-brand underline underline-offset-2 hover:text-primary-800" href="https://pmc.ncbi.nlm.nih.gov/articles/PMC5093388/" target="_blank" rel="noopener noreferrer">
                  Robotham et al., &ldquo;Using digital notifications to improve attendance in clinic: systematic review and meta-analysis&rdquo;, BMJ Open, 2016
                </a>
                .
              </p>
            </div>
          </div>
        </div>
      </section>

      <section aria-labelledby="faq-title" className="mk-section-ice border-t border-line py-20 sm:py-24">
        <div className={`${CONTAINER} grid grid-cols-1 gap-10 lg:grid-cols-[0.7fr_1.3fr]`}>
          <h2 id="faq-title" className="text-balance text-[32px] font-semibold leading-[1.08] tracking-[-0.025em] text-ink sm:text-[44px]">Questions hospital owners ask.</h2>
          <div className="divide-y divide-line rounded-panel border border-line bg-white" data-testid="faq">
            {FAQ.map((f) => (
              <details key={f.q} className="group px-5 py-1">
                <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-4 text-[17px] font-semibold text-ink [&::-webkit-details-marker]:hidden">
                  {f.q}
                  <ChevronDown size={18} className="shrink-0 text-ink-2 transition-transform group-open:rotate-180" aria-hidden="true" />
                </summary>
                <p className="pb-4 text-[16px] leading-relaxed text-ink-2">{f.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}
