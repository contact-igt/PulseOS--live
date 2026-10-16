"use client";

import { JourneyFunnel, type JourneyFunnelStage } from "@pulseos/ui/src/JourneyFunnel";

/** The app's own funnel card. It carries a button handler prop, so it must render on the client. */
export function FunnelClient({ stages }: { stages: JourneyFunnelStage[] }) {
  return <JourneyFunnel stages={stages} testId="mk-funnel" />;
}
