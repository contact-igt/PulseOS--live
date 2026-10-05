import type { TodayStrip } from "@pulseos/types";
import { MetricStrip } from "./MetricStrip";
import { formatInrCompact } from "./format";

interface KpiDef {
  key: keyof TodayStrip;
  label: string;
  format?: (n: number) => string;
}

const KPIS: KpiDef[] = [
  { key: "newEnquiries", label: "New enquiries" },
  { key: "appointmentsToday", label: "Appointments today" },
  { key: "waitingNow", label: "Waiting now" },
  { key: "consultationsCompleted", label: "Consultations" },
  { key: "treatmentDecisionsPending", label: "Treatment decisions" },
  { key: "attributedRevenue", label: "Attributed revenue", format: formatInrCompact },
];

export function KpiStripSection({ data, onSegmentClick }: { data: TodayStrip; onSegmentClick?: (key: keyof TodayStrip) => void }) {
  return (
    <MetricStrip
      testId="kpi-strip"
      anchorKey={data.attributedRevenue === null ? undefined : "attributedRevenue"}
      // Revenue tracking off: the revenue cell is simply absent (never a 0).
      cells={KPIS.filter((kpi) => data[kpi.key] !== null).map((kpi) => ({
        key: String(kpi.key),
        label: kpi.label,
        value: kpi.format ? kpi.format(data[kpi.key] as number) : (data[kpi.key] as number),
        onClick: onSegmentClick ? () => onSegmentClick(kpi.key) : undefined,
        testId: `kpi-${String(kpi.key)}`,
      }))}
    />
  );
}
