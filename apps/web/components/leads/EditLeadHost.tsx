"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@pulseos/api-client";
import { Button, EditLeadDrawer, ErrorState, SideSheet, Skeleton } from "@pulseos/ui";
import type { LeadSourceVm, Lookups, SpecialtyTemplateVm } from "@pulseos/types";
import { invalidateJourneyQueries } from "@/components/journey/invalidate";
import { LeadInsights } from "./LeadInsights";

/**
 * Loads one lead's edit model fresh every time it opens (a copy kept from earlier would carry old versions and be refused
 * on save), then shows the Edit Lead drawer. Loading and failure are shown in the same sheet, never a blank screen.
 */
export function EditLeadHost({
  journeyId,
  lookups,
  specialties,
  leadSources,
  onClose,
}: {
  journeyId: string;
  lookups: Lookups;
  specialties: SpecialtyTemplateVm[];
  leadSources: LeadSourceVm[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const edit = useQuery({ queryKey: ["lead-edit", journeyId], queryFn: () => api.leadEditModel(journeyId), staleTime: 0, gcTime: 0, retry: false });

  if (edit.data) {
    return (
      <EditLeadDrawer
        model={edit.data}
        lookups={lookups}
        specialties={specialties}
        leadSources={leadSources}
        insights={<LeadInsights journeyId={journeyId} />}
        onClose={onClose}
        onSubmit={(input) => api.updateLead(journeyId, input)}
        onSaved={() => {
          invalidateJourneyQueries(queryClient);
          queryClient.invalidateQueries({ queryKey: ["lead-edit", journeyId] });
        }}
      />
    );
  }

  return (
    <SideSheet title="Edit lead" onClose={onClose} testId="edit-lead-drawer" footer={<Button onClick={onClose}>Close</Button>}>
      {edit.isError ? <ErrorState message="Could not open this lead. It may have been removed, or you may not have access." /> : <div className="space-y-3">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-9" />)}</div>}
    </SideSheet>
  );
}
