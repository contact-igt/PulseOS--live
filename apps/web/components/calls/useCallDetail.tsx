"use client";

import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@pulseos/api-client";
import { hasPermission, type CallVm, type TimelineEventVm } from "@pulseos/types";
import { CallCard } from "./CallCard";
import { LogCallSheet } from "./LogCallSheet";

/** Role → what a call card may offer. The API enforces every one of these; this only avoids dead buttons. */
export function useCallPermissions() {
  const session = useQuery({ queryKey: ["session"], queryFn: api.session, retry: false });
  const role = session.data?.user.role;
  return {
    canLog: !!role && hasPermission(role, "LOG_CALL"),
    canPlay: !!role && hasPermission(role, "VIEW_CALL_RECORDING"),
    canDownload: !!role && hasPermission(role, "DOWNLOAD_CALL_RECORDING"),
    canTranscript: !!role && hasPermission(role, "VIEW_CALL_TRANSCRIPT"),
  };
}

/**
 * Timeline call cards + the "Add feedback" sheet they open, for any page that shows a Timeline.
 * Pass `renderEventDetail` to <Timeline/> and render `sheet` once anywhere on the page.
 */
export function useCallDetail(patientName: string): { renderEventDetail: (event: TimelineEventVm) => ReactNode; sheet: ReactNode } {
  const perms = useCallPermissions();
  const [feedbackFor, setFeedbackFor] = useState<CallVm | null>(null);
  return {
    renderEventDetail: (event) => (event.call ? <CallCard call={event.call} perms={perms} onAddFeedback={setFeedbackFor} /> : null),
    sheet: feedbackFor ? (
      <LogCallSheet
        target={{ kind: "feedback", callId: feedbackFor.id, hasCallback: !!feedbackFor.callback, existingFeedback: feedbackFor.staffFeedback }}
        patientName={patientName}
        onClose={() => setFeedbackFor(null)}
      />
    ) : null,
  };
}
