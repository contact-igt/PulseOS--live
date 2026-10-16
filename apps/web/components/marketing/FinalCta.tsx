import { CONTAINER } from "./ui";
import { DemoRequestForm } from "./DemoRequestForm";

export function FinalCta() {
  return (
    <section id="demo" aria-labelledby="demo-title" className="mk-anchor mk-hero-bg py-20 sm:py-28">
      <div className={CONTAINER}>
        <div className="grid grid-cols-1 gap-10 lg:grid-cols-2 lg:items-center lg:gap-16">
          <div>
            <h2 id="demo-title" className="text-balance text-[38px] font-semibold leading-[1.04] tracking-[-0.03em] text-ink sm:text-[54px] lg:text-[64px]">
              See what happens after the enquiry.
            </h2>
            <p className="mt-6 max-w-[560px] text-[18px] leading-relaxed text-ink-2 sm:text-[20px]">
              Walk us through how your hospital handles enquiries, follow-ups and appointments. We&apos;ll show you how PulseOS fits.
            </p>
          </div>
          <div className="rounded-panel border border-line bg-white p-5 shadow-glass sm:p-7">
            <h3 className="mb-4 text-lg font-semibold text-ink">Book a live demo</h3>
            <DemoRequestForm />
          </div>
        </div>
      </div>
    </section>
  );
}
