"use client";

import { useMemo } from "react";
import { GanttTimeline, shiftDate } from "@pulseos/ui";
import type { DayKey } from "@pulseos/ui";
import type { CampaignViewRow } from "@pulseos/types";
import { campaignGanttItems, timelineWindow } from "./runs";
import { useHospitalTimeZone } from "@/lib/useHospitalTimeZone";

/**
 * Campaign runs on a Gantt timeline (selected month ± one month). Ongoing
 * campaigns have no end date: their bar runs to the edge, fades, and reads
 * "Ongoing" — an end is never invented. Below 640px it becomes a list.
 */
export function CampaignTimeline({
  rows,
  date,
  onDateChange,
  onOpen,
}: {
  rows: CampaignViewRow[];
  date: DayKey;
  onDateChange: (date: DayKey) => void;
  onOpen: (row: CampaignViewRow) => void;
}) {
  const timeZone = useHospitalTimeZone();
  const items = useMemo(() => campaignGanttItems(rows), [rows]);
  const { rangeStart, rangeEnd } = timelineWindow(date);
  return (
    <div className="min-w-0 space-y-2 p-4">
      <GanttTimeline<CampaignViewRow>
        ariaLabel="Campaign timeline"
        items={items}
        rangeStart={rangeStart}
        rangeEnd={rangeEnd}
        timeZone={timeZone}
        labelWidth={240}
        onItemClick={(item) => item.data && onOpen(item.data)}
        onRangeShift={(dir) => onDateChange(shiftDate(date, "month", dir))}
        emptyMessage="No campaigns run in this range."
      />
      <p className="text-[11px] text-ink-2">A bar that fades out and reads “Ongoing” has no end date yet.</p>
    </div>
  );
}
