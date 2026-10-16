import { CalendarCheck, Clock, Route } from "lucide-react";
import { BrowserFrame, CONTAINER, Eyebrow, PrimaryCta, SecondaryCta } from "./ui";
import { Fragment, OwnerPerformance } from "./ProductPanels";

const delay = (ms: number) => ({ "--mk-d": `${ms}ms` }) as React.CSSProperties;

export function Hero() {
  return (
    <section aria-labelledby="hero-title" className="mk-hero-bg relative overflow-hidden">
      <div className={`${CONTAINER} pt-12 sm:pt-16 lg:pt-16`}>
        <div className="mx-auto max-w-[850px] text-center">
          <Eyebrow className="mk-rise">Built for hospital patient journeys</Eyebrow>
          <h1 id="hero-title" className="mk-rise mt-4 text-balance text-[42px] font-semibold leading-[1.04] tracking-[-0.035em] text-ink sm:text-[56px] lg:text-[66px]" style={delay(40)}>
            Know what happened after every patient enquiry.
          </h1>
          <p className="mk-rise mx-auto mt-5 max-w-[650px] text-pretty text-[18px] leading-relaxed text-ink-2 sm:text-[20px]" style={delay(100)}>
            From the first call to appointment, consultation, procedure and follow-up, PulseOS gives your team one connected operational view.
          </p>
          <div className="mk-rise mt-7 flex flex-col items-stretch justify-center gap-3 sm:flex-row sm:items-center" style={delay(160)}>
            <PrimaryCta />
            <SecondaryCta href="#journey">Watch a patient journey</SecondaryCta>
          </div>
          <p className="mk-rise mt-5 text-sm text-ink-2" style={delay(200)}>Works alongside your existing calling and hospital systems.</p>
        </div>

        <div className="relative mx-auto mt-14 w-full max-w-[1240px] lg:mt-16">
          <div className="mk-rise" style={delay(240)}>
            <div className="mk-crop max-h-[500px] overflow-hidden sm:max-h-[520px] lg:max-h-[600px]">
              <BrowserFrame screen="Command Centre" label="PulseOS Owner Performance screen: enquiries, appointments booked, visits attended and procedures, by source and service (synthetic demo data)">
                <OwnerPerformance variant="hero" />
              </BrowserFrame>
            </div>
          </div>

          {/* Pieces of the product: stacked under the canvas on small screens, anchored to its edges from lg. */}
          <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-3 lg:mt-0 lg:block">
            <div className="mk-rise lg:absolute lg:z-10 lg:-left-6 lg:-top-[40px] lg:w-[270px]" style={delay(420)}>
              <Fragment icon={<Route size={16} />} title="Patient Journey · Cataract enquiry" meta="Google → call → appointment" />
            </div>
            <div className="mk-rise lg:absolute lg:z-10 lg:-right-6 lg:-top-[40px] lg:w-[250px]" style={delay(480)}>
              <Fragment tone="success" icon={<CalendarCheck size={16} />} title="Appointment confirmed" meta="Tomorrow · 10:30 AM" />
            </div>
            <div className="mk-rise lg:absolute lg:z-10 lg:-right-6 lg:top-[440px] lg:w-[210px]" style={delay(540)}>
              <Fragment tone="warning" icon={<Clock size={16} />} title="Waiting" meta="8 min" />
            </div>
          </div>
        </div>
        <p className="pb-10 pt-6 text-center text-sm text-ink-2 lg:pb-14 lg:pt-8">Screens use synthetic demo data. No real patient or hospital information.</p>
      </div>
    </section>
  );
}
