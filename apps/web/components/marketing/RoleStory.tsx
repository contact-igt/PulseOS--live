"use client";

import { useState, type ReactNode } from "react";
import { Check } from "lucide-react";
import { BrowserFrame, CONTAINER } from "./ui";
import { ROLES } from "./content";
import { useTabKeys } from "./useTabKeys";
import { DemographicsPanel, FrontDeskPanel, MyWorkPanel, PlannerPanel, ServicePanel, SourceTable, TimelineList } from "./ProductPanels";
import { LogCallPanel } from "./ProductPanels";
import { eventsAt } from "./journeyStory";

const SCREEN: Record<string, { name: string; node: ReactNode }> = {
  owner: {
    name: "Performance",
    node: (
      <div className="grid grid-cols-1 items-start gap-3 p-3 sm:p-4 md:grid-cols-2" style={{ backgroundColor: "var(--color-canvas-base)" }}>
        <SourceTable />
        <ServicePanel />
        <div className="md:col-span-2"><DemographicsPanel /></div>
      </div>
    ),
  },
  frontdesk: { name: "Front Desk", node: <FrontDeskPanel /> },
  coordinator: {
    name: "My Work",
    node: (
      <div className="grid grid-cols-1 items-start gap-3 p-3 sm:p-4 md:grid-cols-2" style={{ backgroundColor: "var(--color-canvas-base)" }}>
        <div className="space-y-3">
          <MyWorkPanel />
          <div className="rounded-card border border-line bg-white p-3.5">
            <p className="mb-3 text-[13px] font-semibold text-ink">Journey timeline</p>
            <TimelineList events={eventsAt(2)} />
          </div>
        </div>
        <LogCallPanel />
      </div>
    ),
  },
  doctor: { name: "Doctor Planner", node: <PlannerPanel /> },
};

export function RoleStory() {
  const [active, setActive] = useState(0);
  const { onKeyDown, setRef } = useTabKeys(ROLES.length, active, setActive);
  const role = ROLES[active]!;
  const screen = SCREEN[role.key]!;

  return (
    <section id="roles" aria-labelledby="roles-title" className="mk-anchor mk-section-ice border-y border-line py-20 sm:py-28">
      <div className={CONTAINER}>
        <h2 id="roles-title" className="max-w-[860px] text-balance text-[36px] font-semibold leading-[1.05] tracking-[-0.03em] text-ink sm:text-[48px] lg:text-[60px]">
          One journey. A different view for every team.
        </h2>

        <div className="mk-scroll-x mt-8 overflow-x-auto">
          <div role="tablist" aria-label="Choose a role" onKeyDown={onKeyDown} className="flex w-max gap-1 rounded-control border border-line-strong bg-white p-1" data-testid="role-tabs">
            {ROLES.map((r, i) => (
              <button
                key={r.key}
                ref={setRef(i)}
                role="tab"
                id={`role-tab-${r.key}`}
                aria-selected={active === i}
                aria-controls="role-panel"
                tabIndex={active === i ? 0 : -1}
                type="button"
                onClick={() => setActive(i)}
                className={`min-h-11 whitespace-nowrap rounded-[8px] px-5 text-[15px] font-semibold transition sm:px-7 ${active === i ? "bg-brand text-white" : "text-ink-2 hover:text-ink"}`}
              >
                {r.tab}
              </button>
            ))}
          </div>
        </div>

        <div id="role-panel" role="tabpanel" aria-labelledby={`role-tab-${role.key}`} tabIndex={0} className="mt-10 grid grid-cols-1 gap-8 lg:grid-cols-[0.8fr_1.2fr] lg:items-center" data-testid="role-panel">
          <div key={role.key} className="mk-swap">
            <h3 className="text-balance text-[28px] font-semibold leading-[1.1] tracking-[-0.02em] text-ink sm:text-[36px]" data-testid="role-headline">{role.headline}</h3>
            <p className="mt-4 text-[17px] leading-relaxed text-ink-2">{role.body}</p>
            <ul className="mt-6 space-y-3">
              {role.points.map((b) => (
                <li key={b} className="flex gap-3 text-[16px] leading-snug text-ink">
                  <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary-100 text-primary-700" aria-hidden="true"><Check size={12} strokeWidth={3} /></span>
                  {b}
                </li>
              ))}
            </ul>
          </div>
          <div key={`${role.key}-visual`} className="mk-swap min-w-0">
            <BrowserFrame screen={screen.name} label={`PulseOS ${screen.name} screen (synthetic demo data)`}>{screen.node}</BrowserFrame>
          </div>
        </div>
      </div>
    </section>
  );
}
