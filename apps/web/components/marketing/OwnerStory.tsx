import { BrowserFrame, CONTAINER, Eyebrow, PrimaryCta } from "./ui";
import { OwnerPerformance } from "./ProductPanels";

const QUESTIONS = [
  { q: "Which source brings patients who actually visit?", a: "Source → visit → consultation → procedure, side by side." },
  { q: "Where are patients dropping off?", a: "The funnel names the largest drop and the stage it happens at." },
  { q: "Which services turn into procedures?", a: "Enquiries and procedures advised, service by service." },
  { q: "Who is your hospital actually reaching?", a: "Patterns by age group, area and the fields your hospital chooses to record." },
] as const;

export function OwnerStory() {
  return (
    <section id="product" aria-labelledby="owner-title" className="mk-anchor bg-white py-20 sm:py-28">
      <div className={CONTAINER}>
        <div className="max-w-[860px]">
          <Eyebrow>For the owner</Eyebrow>
          <h2 id="owner-title" className="mt-4 text-balance text-[36px] font-semibold leading-[1.05] tracking-[-0.03em] text-ink sm:text-[48px] lg:text-[60px]">
            Stop asking, &ldquo;what happened to this lead?&rdquo;
          </h2>
          <p className="mt-5 max-w-[650px] text-[18px] leading-relaxed text-ink-2 sm:text-[20px]">See where enquiries become appointments, consultations and procedures.</p>
        </div>

        <div className="mt-12">
          <BrowserFrame screen="Performance" label="PulseOS Owner Performance: funnel, source, service, who is enquiring and team (synthetic demo data)">
            <OwnerPerformance variant="full" />
          </BrowserFrame>
          <p className="mt-4 text-sm text-ink-2">Illustrative numbers on synthetic data.</p>
        </div>

        <ul className="mt-14 grid grid-cols-1 gap-x-10 gap-y-8 md:grid-cols-2 lg:grid-cols-4" data-testid="owner-questions">
          {QUESTIONS.map((c) => (
            <li key={c.q} className="border-t-2 border-brand pt-4">
              <h3 className="text-balance text-[22px] font-semibold leading-snug tracking-tight text-ink">{c.q}</h3>
              <p className="mt-2 text-[16px] leading-relaxed text-ink-2">{c.a}</p>
            </li>
          ))}
        </ul>
        <div className="mt-12">
          <PrimaryCta />
        </div>
      </div>
    </section>
  );
}
