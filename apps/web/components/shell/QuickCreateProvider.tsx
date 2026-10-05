"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@pulseos/api-client";
import { AddLeadDrawer, AddPatientDrawer, AddTaskDrawer, NewAppointmentDrawer } from "@pulseos/ui";
import type { Role, SourceChannel } from "@pulseos/types";
import { wallTimeToInstant } from "@/lib/hospitalTime";
import { useHospitalTimeZone } from "@/lib/useHospitalTimeZone";

interface PatientRef {
  id: string;
  name: string;
  phone: string;
}

interface QuickCreateContextValue {
  openAddLead: (opts?: { source?: SourceChannel }) => void;
  openAddPatient: () => void;
  openNewAppointment: (opts?: { patient?: PatientRef; journeyId?: string }) => void;
  openAddTask: (opts?: { patient?: PatientRef; journeyId?: string }) => void;
}

const QuickCreateContext = createContext<QuickCreateContextValue | null>(null);

export function useQuickCreate(): QuickCreateContextValue {
  const ctx = useContext(QuickCreateContext);
  if (!ctx) throw new Error("useQuickCreate must be used within QuickCreateProvider");
  return ctx;
}

type DrawerState =
  | { kind: "none" }
  | { kind: "lead"; source?: SourceChannel }
  | { kind: "patient" }
  | { kind: "appointment"; patient?: PatientRef; journeyId?: string }
  | { kind: "task"; patient?: PatientRef; journeyId?: string };

export function QuickCreateProvider({ role, children }: { role: Role; children: ReactNode }) {
  const queryClient = useQueryClient();
  const [drawer, setDrawer] = useState<DrawerState>({ kind: "none" });
  const timeZone = useHospitalTimeZone();

  const specialties = useQuery({ queryKey: ["specialties"], queryFn: () => api.specialties(), staleTime: 60_000 });
  const lookups = useQuery({ queryKey: ["lookups"], queryFn: api.lookups, staleTime: 60_000 });
  const leadSources = useQuery({ queryKey: ["lead-sources"], queryFn: () => api.leadSources(), staleTime: 60_000 });
  // The hospital's configured outcomes (Settings → Workflow Outcomes): offered on Add Lead as "What happened?".
  // Only for roles that can add leads: asking for it as a Doctor would be a 403.
  const outcomes = useQuery({ queryKey: ["crm-outcomes", "active"], queryFn: () => api.crmOutcomes(), staleTime: 60_000, enabled: role === "SUPER_ADMIN" || role === "HOSPITAL_ADMIN" || role === "FRONT_DESK" || role === "PATIENT_COORDINATOR" });

  function invalidateAfterCreate() {
    queryClient.invalidateQueries({ queryKey: ["leads"] });
    queryClient.invalidateQueries({ queryKey: ["leads-summary"] });
    queryClient.invalidateQueries({ queryKey: ["calls"] });
    queryClient.invalidateQueries({ queryKey: ["journeys"] });
    queryClient.invalidateQueries({ queryKey: ["journey"] });
    queryClient.invalidateQueries({ queryKey: ["patients"] });
    queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    queryClient.invalidateQueries({ queryKey: ["patient360"] });
    queryClient.invalidateQueries({ queryKey: ["tasks"] });
    queryClient.invalidateQueries({ queryKey: ["front-desk"] });
    queryClient.invalidateQueries({ queryKey: ["appointments"] });
  }

  const value: QuickCreateContextValue = {
    openAddLead: (opts) => setDrawer({ kind: "lead", source: opts?.source }),
    openAddPatient: () => setDrawer({ kind: "patient" }),
    openNewAppointment: (opts) => setDrawer({ kind: "appointment", patient: opts?.patient, journeyId: opts?.journeyId }),
    openAddTask: (opts) => setDrawer({ kind: "task", patient: opts?.patient, journeyId: opts?.journeyId }),
  };

  const canManageLeads = role === "SUPER_ADMIN" || role === "HOSPITAL_ADMIN" || role === "FRONT_DESK" || role === "PATIENT_COORDINATOR";
  const canManageAppointments = role !== "DOCTOR";
  const canManageTasks = role !== "DOCTOR";
  const canEditPatients = role !== "DOCTOR";

  return (
    <QuickCreateContext.Provider value={value}>
      {children}

      {specialties.data && lookups.data && leadSources.data && (
        <>
          {canManageLeads && drawer.kind === "lead" && (
            <AddLeadDrawer
              open
              onClose={() => setDrawer({ kind: "none" })}
              specialties={specialties.data}
              lookups={lookups.data}
              clinicHours={lookups.data.clinicHours}
              leadSources={leadSources.data}
              outcomes={outcomes.data ?? []}
              defaultSource={drawer.source}
              onPhoneLookup={api.leadPhoneLookup}
              onLoadCustomFields={api.specialtyFields}
              onCheckSlot={(doctorId, scheduledAt) => api.appointmentSlotCheck(doctorId, scheduledAt)}
              onSubmit={api.createLead}
              onCreated={invalidateAfterCreate}
            />
          )}

          {canEditPatients && drawer.kind === "patient" && (
            <AddPatientDrawer open onClose={() => setDrawer({ kind: "none" })} branches={lookups.data.branches} onSubmit={api.createPatient} onCreated={invalidateAfterCreate} />
          )}

          {canManageAppointments && drawer.kind === "appointment" && (
            <NewAppointmentDrawer
              open
              onClose={() => setDrawer({ kind: "none" })}
              branches={lookups.data.branches}
              doctors={lookups.data.doctors}
              clinicHours={lookups.data.clinicHours}
              initialPatient={drawer.patient}
              initialJourneyId={drawer.journeyId}
              toInstant={(local) => (wallTimeToInstant(local.slice(0, 10), local.slice(11, 16), timeZone) ?? new Date(local)).toISOString()}
              onSearchPatients={(q) => api.patients({ search: q })}
              onLoadPatientJourneys={async (patientId) => (await api.patient360(patientId)).journeys}
              onSubmit={api.createAppointment}
              onCheckSlot={(doctorId, instant) => api.appointmentSlotCheck(doctorId, instant)}
              onCreated={invalidateAfterCreate}
              onCreateLeadInstead={() => setDrawer({ kind: "lead" })}
            />
          )}

          {canManageTasks && drawer.kind === "task" && (
            <AddTaskDrawer
              open
              onClose={() => setDrawer({ kind: "none" })}
              owners={lookups.data.owners}
              initialPatient={drawer.patient}
              initialJourneyId={drawer.journeyId}
              onSearchPatients={(q) => api.patients({ search: q })}
              onSubmit={api.createTask}
              onCreated={invalidateAfterCreate}
            />
          )}
        </>
      )}
    </QuickCreateContext.Provider>
  );
}
