"use client";

import { useCallback, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "@pulseos/api-client";
import { localDayKey } from "@pulseos/ui";
import { useHospitalTimeZone } from "@/lib/useHospitalTimeZone";
import type { AppointmentAction, AppointmentReasonCode, AppointmentRow } from "@pulseos/types";
import { wallTimeToInstant } from "@/lib/hospitalTime";

/** The hospital's timezone (session) and its local "today" (server clock once loaded; never the browser's zone). */
export function useCalendarContext() {
  const timeZone = useHospitalTimeZone();
  const q = useQuery({ queryKey: ["calendar-context"], queryFn: api.appointmentCalendarContext, staleTime: 5 * 60_000 });
  return { timeZone, today: q.data?.today ?? localDayKey(new Date(), timeZone), ready: q.isSuccess };
}

// Mistakes in what was typed: the drawer stays open, keeps the input, and says what to fix.
const INPUT_ERROR: Record<string, string> = {
  reason_required: "Choose a reason first.",
  reason_invalid: "Choose one of the listed reasons.",
  scheduled_in_past: "That time has already passed — choose a time in the future.",
  resource_unavailable: "This doctor already has another appointment at this time. Choose a different time or doctor.",
  invalid_request: "Check the date, time and reason, then try again.",
};

const ACTION_ERROR: Record<string, string> = {
  invalid_transition: "That step is not allowed from the appointment's current status - it may have just changed. The list has been refreshed.",
  appointment_closed: "This appointment is already closed (completed or cancelled). The list has been refreshed.",
  not_with_doctor: "Only a patient who is with the doctor can be marked complete. The list has been refreshed.",
  appointment_not_found: "This appointment could not be found. The list has been refreshed.",
};

/**
 * The page's existing appointment actions (action / complete / reschedule),
 * unchanged on success. A server rejection (e.g. a stale status -> 409) no
 * longer escapes as an unhandled rejection: it becomes an inline message and
 * the data is refetched so the view shows the server's truth.
 */
export function useAppointmentActions({ refresh, onDone }: { refresh: () => void; onDone: () => void }) {
  const timeZone = useHospitalTimeZone();
  // "Consultation done" opens the "What happens next?" sheet instead of completing outright.
  const [completing, setCompleting] = useState<AppointmentRow | null>(null);
  // The appointment changed on the server: the drawer closes and this notice explains why.
  const [error, setError] = useState<string | null>(null);
  // A recoverable failure (network, 5xx): the drawer stays open with what was typed in it, and the
  // message belongs to THAT appointment only — it never shows on another one's drawer.
  const [drawerError, setDrawerError] = useState<{ id: string; message: string } | null>(null);

  const run = useCallback(
    async (rowId: string, fn: () => Promise<unknown>) => {
      setError(null);
      setDrawerError(null);
      try {
        await fn();
        onDone();
      } catch (err) {
        const code = err instanceof ApiError ? err.message : "";
        const changed = ACTION_ERROR[code];
        if (INPUT_ERROR[code]) {
          setDrawerError({ id: rowId, message: INPUT_ERROR[code]! });
        } else if (changed) {
          setError(changed);
          onDone();
        } else {
          setDrawerError({ id: rowId, message: "Could not update the appointment. Please try again." });
        }
      } finally {
        refresh();
      }
    },
    [refresh, onDone],
  );

  return {
    error,
    clearError: useCallback(() => setError(null), []),
    drawerErrorFor: useCallback((id: string | undefined) => (id && drawerError?.id === id ? drawerError.message : null), [drawerError]),
    clearDrawerError: useCallback(() => setDrawerError(null), []),
    handleAction: useCallback((row: AppointmentRow, action: AppointmentAction, reason?: { reasonCode?: string; note?: string }) => run(row.id, () => api.appointmentAction(row.id, action, { ...(reason as { reasonCode?: AppointmentReasonCode; note?: string } | undefined), ...(action === "check_in" ? { queue: true } : {}) })), [run]),
    completing,
    handleComplete: useCallback((row: AppointmentRow) => setCompleting(row), []),
    closeCompleting: useCallback(() => setCompleting(null), []),
    /** The completion sheet saved: close it, refresh, and close the drawer behind it. */
    completed: useCallback(() => {
      setCompleting(null);
      refresh();
      onDone();
    }, [refresh, onDone]),
    /** The new time is typed in the hospital's clock; it becomes an instant here, never in the browser's zone. */
    handleReschedule: useCallback(
      (row: AppointmentRow, choice: { date: string; time: string; reasonCode: AppointmentReasonCode; note?: string }) => {
        const at = wallTimeToInstant(choice.date, choice.time, timeZone);
        if (!at) {
          setDrawerError({ id: row.id, message: INPUT_ERROR.invalid_request! });
          return Promise.resolve();
        }
        return run(row.id, () => api.rescheduleAppointment(row.id, { scheduledAt: at.toISOString(), reasonCode: choice.reasonCode, ...(choice.note ? { note: choice.note } : {}) }));
      },
      [run, timeZone],
    ),
  };
}
