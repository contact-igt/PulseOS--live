import type { ReactNode } from "react";
import { CalendarCheck, Check, ClipboardList, Clock, ListChecks, PhoneCall, Stethoscope, UserRound, Zap } from "lucide-react";
import { FunnelClient } from "./FunnelClient";
import { Pill, UiCard } from "./ui";
import { DEMOGRAPHICS, FRONT_DESK_FLOW, FRONT_DESK_ROWS, FUNNEL_STAGES, PLANNER_ROWS, SERVICE_ROWS, SOURCE_ROWS, TEAM_ROWS } from "./content";
import type { StoryEvent } from "./journeyStory";

// Marketing renditions of real PulseOS screens: the same Card, Badge and JourneyFunnel components, tokens and layout as the
// app, filled with synthetic data. No API calls, no auth, no production data.

const CANVAS = { backgroundColor: "var(--color-canvas-base)" } as const;

export function Funnel() {
  return <FunnelClient stages={FUNNEL_STAGES.map((s) => ({ key: s.key, label: s.label, count: s.count }))} />;
}

export function KpiStrip() {
  const items = [
    ["143", "Enquiries"],
    ["91", "Appointments booked"],
    ["72", "Visits attended"],
    ["68", "Consultations"],
    ["14", "Procedures done"],
  ] as const;
  return (
    <dl className="grid grid-cols-2 overflow-hidden rounded-card border border-line bg-white sm:grid-cols-5">
      {items.map(([n, l], i) => (
        <div key={l} className={`px-4 py-3 ${i % 2 === 1 ? "border-l border-line sm:border-l" : ""} ${i > 0 && i < 2 ? "" : ""} ${i >= 2 ? "border-t border-line sm:border-t-0" : ""} ${i > 0 ? "sm:border-l sm:border-line" : ""} ${i === 4 ? "col-span-2 sm:col-span-1" : ""}`}>
          <dd className="text-2xl font-semibold tabular-nums text-ink">{n}</dd>
          <dt className="text-xs text-ink-2">{l}</dt>
        </div>
      ))}
    </dl>
  );
}

export function SourceTable() {
  return (
    <UiCard title="By source" meta="Last 30 days">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[300px] text-left text-[13px]">
          <thead>
            <tr className="text-[11px] uppercase tracking-wide text-ink-2">
              <th className="px-3.5 py-2 font-medium">Source</th>
              <th className="px-2 py-2 text-right font-medium">Enq.</th>
              <th className="px-2 py-2 text-right font-medium">Visits</th>
              <th className="px-2 py-2 text-right font-medium">Consults</th>
              <th className="px-3.5 py-2 text-right font-medium" title="Procedures done">Done</th>
            </tr>
          </thead>
          <tbody>
            {SOURCE_ROWS.map((r) => (
              <tr key={r.source} className="border-t border-line">
                <td className="px-3.5 py-2 font-medium text-ink">{r.source}</td>
                <td className="px-2 py-2 text-right tabular-nums">{r.enquiries}</td>
                <td className="px-2 py-2 text-right tabular-nums">{r.visits}</td>
                <td className="px-2 py-2 text-right tabular-nums">{r.consultations}</td>
                <td className="px-3.5 py-2 text-right font-semibold tabular-nums text-ink">{r.procedures}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </UiCard>
  );
}

export function ServicePanel() {
  const max = Math.max(...SERVICE_ROWS.map((s) => s.enquiries));
  return (
    <UiCard title="By service" meta="Enquiries → advised">
      <ul className="space-y-2.5 p-3.5">
        {SERVICE_ROWS.map((s) => (
          <li key={s.service}>
            <div className="flex items-baseline justify-between text-[13px]">
              <span className="text-ink">{s.service}</span>
              <span className="tabular-nums text-ink-2">
                {s.enquiries} → <span className="font-semibold text-ink">{s.advised}</span>
              </span>
            </div>
            <span className="mt-1 block h-2 overflow-hidden rounded-full bg-primary-100" aria-hidden="true">
              <span className="block h-full rounded-full bg-primary-500" style={{ width: `${(s.enquiries / max) * 100}%` }} />
            </span>
          </li>
        ))}
      </ul>
    </UiCard>
  );
}

export function DemographicsPanel() {
  return (
    <UiCard title="Who is enquiring" meta="From what was recorded">
      <div className="grid grid-cols-1 gap-x-6 gap-y-4 p-3.5 sm:grid-cols-3">
        {DEMOGRAPHICS.map((d) => {
          const max = Math.max(...d.rows.map((r) => r[1] as number));
          return (
            <div key={d.dimension}>
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-2">{d.dimension}</p>
              <ul className="space-y-1.5">
                {d.rows.map(([label, n]) => (
                  <li key={label} className="text-[13px]">
                    <div className="flex justify-between text-ink">
                      <span>{label}</span>
                      <span className="tabular-nums text-ink-2">{n}</span>
                    </div>
                    <span className="mt-0.5 block h-1.5 overflow-hidden rounded-full bg-primary-100" aria-hidden="true">
                      <span className="block h-full rounded-full bg-primary-500" style={{ width: `${((n as number) / max) * 100}%` }} />
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </UiCard>
  );
}

export function TeamPanel() {
  return (
    <UiCard title="Team" meta="Who is following up">
      <ul>
        {TEAM_ROWS.map((t) => (
          <li key={t.name} className="flex items-center justify-between gap-3 border-t border-line px-3.5 py-2.5 text-[13px] first:border-t-0">
            <span className="flex items-center gap-2 text-ink">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary-100 text-[11px] font-semibold text-primary-800" aria-hidden="true">{t.name[0]}</span>
              {t.name}
            </span>
            <span className="tabular-nums text-ink-2">{t.enquiries} enquiries</span>
            <Pill tone={t.followUps === "Up to date" ? "success" : "warning"}>{t.followUps}</Pill>
          </li>
        ))}
      </ul>
    </UiCard>
  );
}

/** Owner Performance. `hero` is the cropped top of the screen; `full` is the whole thing. */
export function OwnerPerformance({ variant }: { variant: "hero" | "full" }) {
  return (
    <div className="space-y-3 p-3 sm:p-4" style={CANVAS}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div>
          <p className="text-sm font-semibold text-ink">Hospital performance</p>
          <p className="text-xs text-ink-2">Last 30 days · all branches · all services</p>
        </div>
        {variant === "full" && <Pill>Synthetic demo data</Pill>}
      </div>
      <div className={variant === "hero" ? "hidden sm:block" : ""}><KpiStrip /></div>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[1.2fr_1fr]">
        <Funnel />
        <div className="space-y-3">
          <SourceTable />
          {variant === "full" && <ServicePanel />}
          {variant === "hero" && <div className="hidden lg:block"><ServicePanel /></div>}
        </div>
      </div>
      {variant === "full" && (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-[1.4fr_1fr]">
          <DemographicsPanel />
          <TeamPanel />
        </div>
      )}
    </div>
  );
}

export function FrontDeskPanel() {
  const counters = [["2", "Confirmed"], ["1", "Checked in"], ["1", "Waiting · 8 min"], ["1", "With doctor"], ["3", "Completed"]] as const;
  return (
    <div className="space-y-3 p-3 sm:p-4" style={CANVAS}>
      <dl className="grid grid-cols-2 overflow-hidden rounded-card border border-line bg-white sm:grid-cols-5">
        {counters.map(([n, l], i) => (
          <div key={l} className={`px-3 py-2.5 ${l.startsWith("Waiting") ? "bg-brand text-white" : ""} ${i > 0 ? "sm:border-l sm:border-line" : ""} ${i % 2 === 1 ? "border-l border-line sm:border-l" : ""} ${i >= 2 ? "border-t border-line sm:border-t-0" : ""} ${i === 4 ? "col-span-2 sm:col-span-1" : ""}`}>
            <dd className="text-lg font-semibold tabular-nums">{n}</dd>
            <dt className={`text-[11px] ${l.startsWith("Waiting") ? "text-white/90" : "text-ink-2"}`}>{l}</dt>
          </div>
        ))}
      </dl>
      <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-ink" aria-label="Front desk flow">
        {FRONT_DESK_FLOW.map((s, i) => (
          <li key={s} className="flex items-center gap-2">
            <span className="rounded-chip bg-white px-2.5 py-1 font-medium ring-1 ring-inset ring-primary-200">{s}</span>
            {i < FRONT_DESK_FLOW.length - 1 && <span className="text-ink-2" aria-hidden="true">→</span>}
          </li>
        ))}
      </ol>
      <UiCard title="Today's appointments" meta="Same status for everyone">
        <ul>
          {FRONT_DESK_ROWS.map((r) => (
            <li key={r.patient} className="grid grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-1 border-t border-line px-3.5 py-2.5 first:border-t-0 sm:grid-cols-[52px_1.1fr_1fr_auto_auto]">
              <span className="text-xs tabular-nums text-ink-2">{r.time}</span>
              <span className="min-w-0">
                <span className="block truncate text-[13px] font-medium text-ink">{r.patient}</span>
                <span className="block truncate text-xs text-ink-2 sm:hidden">{r.service}</span>
              </span>
              <span className="hidden truncate text-xs text-ink-2 sm:block">{r.service}</span>
              <Pill tone={r.tone}>{r.status}</Pill>
              <span className="hidden sm:block">{r.next && <span className="rounded-control border border-line-strong px-2.5 py-1 text-xs font-medium text-ink">{r.next}</span>}</span>
            </li>
          ))}
        </ul>
      </UiCard>
    </div>
  );
}

export function PlannerPanel() {
  return (
    <div className="space-y-3 p-3 sm:p-4" style={CANVAS}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-ink">Today · Dr. Menon</p>
          <p className="text-xs text-ink-2">5 patients · 1 waiting</p>
        </div>
        <Pill tone="warning">Waiting · 8 min</Pill>
      </div>
      <UiCard>
        <ul>
          {PLANNER_ROWS.map((r) => (
            <li key={r.patient} className="grid grid-cols-[72px_1fr_auto] items-center gap-x-3 border-t border-line px-3.5 py-3 first:border-t-0">
              <span className="text-xs font-medium tabular-nums text-ink-2">{r.time}</span>
              <span className="min-w-0">
                <span className="block truncate text-[13px] font-medium text-ink">{r.patient}</span>
                <span className="block truncate text-xs text-ink-2">{r.service}</span>
              </span>
              <Pill tone={r.tone}>{r.status}</Pill>
            </li>
          ))}
        </ul>
      </UiCard>
    </div>
  );
}

export function MyWorkPanel() {
  const tasks = [
    ["Call Priya · Cataract", "Today · 5:00 PM", "primary", "Due today"],
    ["Call Ravi K. · No answer yesterday", "Tomorrow · 11:00 AM", "warning", "Retry"],
    ["Follow up on procedure decision", "Tomorrow · 11:00 AM", "neutral", "Scheduled"],
  ] as const;
  return (
    <UiCard title="My Work" meta="Shivani · 3 follow-ups">
      <ul>
        {tasks.map(([t, d, tone, s]) => (
          <li key={t} className="flex items-center gap-3 border-t border-line px-3.5 py-2.5 first:border-t-0">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-control bg-primary-100 text-primary-700"><ListChecks size={14} /></span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium text-ink">{t}</span>
              <span className="block text-xs text-ink-2">{d}</span>
            </span>
            <Pill tone={tone}>{s}</Pill>
          </li>
        ))}
      </ul>
    </UiCard>
  );
}

function Field({ label, value, active = false }: { label: string; value: string; active?: boolean }) {
  return (
    <div>
      <p className="mb-1 text-[11px] font-medium text-ink-2">{label}</p>
      <p className={`rounded-control border bg-white px-3 py-2.5 text-[14px] text-ink ${active ? "border-primary-400 ring-2 ring-primary-500/20" : "border-line-strong"}`}>{value}</p>
    </div>
  );
}

/** The Log Call drawer, enlarged. */
export function LogCallPanel({ large = false }: { large?: boolean }) {
  return (
    <UiCard title="Log call" meta="Priya · Cataract" className="shadow-glass">
      <div className={`space-y-3 px-4 ${large ? "py-5" : "py-4"}`}>
        <Field label="Outcome" value="Patient interested" />
        <Field label="Feedback" value="Asked about surgery and timings" />
        <Field label="Next action" value="Book appointment" active />
        <div className="grid grid-cols-2 gap-3">
          <Field label="Date" value="Tue, 10 Oct" />
          <Field label="Time" value="10:30 AM" />
        </div>
        <label className="flex items-center gap-2 text-[14px] text-ink">
          <span className="flex h-[18px] w-[18px] items-center justify-center rounded border border-brand bg-brand text-white" aria-hidden="true"><Check size={12} strokeWidth={3} /></span>
          Confirmed with patient
        </label>
        <div className="rounded-control bg-brand px-4 py-3 text-center text-[14px] font-semibold text-white">Save call &amp; confirm appointment</div>
      </div>
    </UiCard>
  );
}

const KIND_ICON: Record<StoryEvent["kind"], ReactNode> = {
  lead: <UserRound size={13} />,
  call: <PhoneCall size={13} />,
  appt: <CalendarCheck size={13} />,
  visit: <Clock size={13} />,
  consult: <Stethoscope size={13} />,
  proc: <Zap size={13} />,
  task: <ClipboardList size={13} />,
};

/** Journey timeline in the app's own construction: day groups, a rail, icon dots, time on the right. */
export function TimelineList({ events, newestId }: { events: readonly StoryEvent[]; newestId?: string }) {
  const days: { day: string; items: StoryEvent[] }[] = [];
  for (const e of events) {
    const last = days[days.length - 1];
    if (last && last.day === e.day) last.items.push(e);
    else days.push({ day: e.day, items: [e] });
  }
  return (
    <div className="space-y-4">
      {days.map((g) => (
        <section key={g.day}>
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-2">{g.day}</p>
          <ol className="relative space-y-3.5 border-l border-line pl-7">
            {g.items.map((e) => (
              <li key={e.id} className={`relative ${e.id === newestId ? "mk-rise" : ""}`}>
                <span className="absolute -left-[38px] top-0 flex h-6 w-6 items-center justify-center rounded-full border-2 border-white bg-primary-100 text-primary-700">{KIND_ICON[e.kind]}</span>
                <div className="flex items-start justify-between gap-x-3">
                  <span className="min-w-0 text-sm font-medium leading-5 text-ink">{e.title}</span>
                  <span className="shrink-0 pt-0.5 text-[11px] tabular-nums text-ink-2">{e.time}</span>
                </div>
                <p className="mt-0.5 text-xs leading-5 text-ink-2">{e.detail}</p>
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}

/** Small status fragment used in the hero: a piece of PulseOS, not a decorative card. */
export function Fragment({ icon, title, meta, tone = "primary" }: { icon: ReactNode; title: string; meta: string; tone?: "primary" | "success" | "warning" }) {
  const t = tone === "success" ? "bg-accent-100 text-accent-700" : tone === "warning" ? "bg-warning-100 text-warning-700" : "bg-primary-100 text-primary-700";
  return (
    <div className="flex items-start gap-3 rounded-card border border-line bg-white p-3 shadow-glass">
      <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-control ${t}`}>{icon}</span>
      <div className="min-w-0">
        <p className="text-[13px] font-semibold text-ink">{title}</p>
        <p className="text-xs text-ink-2">{meta}</p>
      </div>
    </div>
  );
}
