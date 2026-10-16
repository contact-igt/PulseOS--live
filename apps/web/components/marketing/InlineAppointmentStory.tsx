import { BellRing, CalendarCheck, MonitorCheck } from "lucide-react";
import { CONTAINER, Eyebrow } from "./ui";
import { Fragment, LogCallPanel } from "./ProductPanels";

export function InlineAppointmentStory() {
  return (
    <section aria-labelledby="inline-title" className="bg-white py-20 sm:py-28">
      <div className={CONTAINER}>
        <div className="grid grid-cols-1 items-center gap-12 lg:grid-cols-[1.1fr_0.9fr] lg:gap-14">
          <div>
            <Eyebrow>One action, not three screens</Eyebrow>
            <h2 id="inline-title" className="mt-4 text-balance text-[36px] font-semibold leading-[1.05] tracking-[-0.03em] text-ink sm:text-[48px] lg:text-[52px]">
              Book the appointment while you&apos;re still on the call.
            </h2>
            <p className="mt-5 max-w-[560px] text-[18px] leading-relaxed text-ink-2">
              Set the next action to Book appointment, pick the date and time, confirm with the patient, save. The call, the appointment and the follow-up land on the same journey.
            </p>
            <div className="mt-8 max-w-[420px] space-y-3">
              <Fragment tone="success" icon={<CalendarCheck size={16} />} title="Appointment confirmed" meta="Tue · 10:30 AM" />
              <Fragment icon={<BellRing size={16} />} title="Reminder planned" meta="Goes out when your messaging provider is connected" />
              <Fragment icon={<MonitorCheck size={16} />} title="Front desk updated" meta="Tomorrow's queue already shows Priya" />
            </div>
          </div>
          <div className="mx-auto w-full max-w-[520px]" aria-label="PulseOS Log call drawer with synthetic data">
            <LogCallPanel large />
          </div>
        </div>
      </div>
    </section>
  );
}
