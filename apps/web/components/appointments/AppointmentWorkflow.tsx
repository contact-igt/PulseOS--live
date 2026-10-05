"use client";

import { useCallback, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@pulseos/api-client";
import { AppointmentDrawer } from "@pulseos/ui";
import { hasPermission, type AppointmentRow } from "@pulseos/types";
import { useHospitalTimeZone } from "@/lib/useHospitalTimeZone";
import { useAppointmentActions } from "./hooks";
import { CompleteConsultationSheet, invalidateAppointmentQueries } from "./CompleteConsultationSheet";

/**
 * Everything an appointment can be taken through, wherever it is shown (Appointments, Front Desk, a Journey): the
 * detail drawer with its one next step, reasons for reschedule / cancel / no-show, and the "What happens next?"
 * completion sheet. Same drawer, same actions, same server rules everywhere — views never keep a state of their own.
 */
export function useAppointmentWorkflow(opts: { onDone?: () => void } = {}) {
  const queryClient = useQueryClient();
  const timeZone = useHospitalTimeZone();
  const [selected, setSelected] = useState<AppointmentRow | null>(null);
  const session = useQuery({ queryKey: ["session"], queryFn: api.session });
  // Mirrors the server's MANAGE_APPOINTMENTS — only to avoid dead controls, never the authorization boundary.
  const canManage = !!session.data && hasPermission(session.data.user.role, "MANAGE_APPOINTMENTS");
  const lookups = useQuery({ queryKey: ["lookups"], queryFn: api.lookups, staleTime: 60_000 });
  const timeline = useQuery({ queryKey: ["timeline", selected?.patientId, selected?.journeyId], queryFn: () => api.patientTimeline(selected!.patientId, selected!.journeyId), enabled: !!selected });

  const refresh = useCallback(() => {
    invalidateAppointmentQueries(queryClient);
    opts.onDone?.();
  }, [queryClient, opts]);
  const close = useCallback(() => setSelected(null), []);
  const actions = useAppointmentActions({ refresh, onDone: close });

  const element = (
    <>
      <AppointmentDrawer
        appointment={selected}
        recentEvents={timeline.data}
        timeZone={timeZone}
        clinicHours={lookups.data?.clinicHours}
        onClose={() => {
          actions.clearDrawerError();
          close();
        }}
        onAction={actions.handleAction}
        onComplete={actions.handleComplete}
        onReschedule={actions.handleReschedule}
        readOnly={!canManage}
        error={actions.drawerErrorFor(selected?.id)}
      />
      {actions.completing && <CompleteConsultationSheet appointment={actions.completing} onClose={actions.closeCompleting} onDone={actions.completed} />}
    </>
  );

  return { selected, select: setSelected, canManage, element, ...actions };
}
