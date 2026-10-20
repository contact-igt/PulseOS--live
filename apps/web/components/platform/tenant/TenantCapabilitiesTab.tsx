"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Lock } from "lucide-react";
import { platformApi } from "@pulseos/api-client";
import { Badge, Button, Panel, Table, TableBody, TableHead, Td, Th, Tr } from "@pulseos/ui";
import { CAPABILITY_META, PLAN_META, type Capability, type Edition, type PlatformTenantDetail } from "@pulseos/types";
import { CONTROL, FormField } from "../../settings/FormBits";
import { ActionDialog, ErrorPanel, TableSkeleton, errorMessage } from "../ui";
import { usePlatformUser } from "../usePlatformUser";

/** Plan default + tenant override = effective access, side by side. The API enforces "effective" on every request. */
export function TenantCapabilitiesTab({ detail }: { detail: PlatformTenantDetail }) {
  const tenantId = detail.tenant.id;
  const queryClient = useQueryClient();
  const { can } = usePlatformUser();
  const canEdit = can("MANAGE_ENTITLEMENTS");
  const matrix = useQuery({ queryKey: ["platform", "tenant", tenantId, "capabilities"], queryFn: () => platformApi.tenantCapabilities(tenantId) });
  const [changingPlan, setChangingPlan] = useState(false);
  const [edition, setEdition] = useState<Edition>(detail.tenant.edition);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["platform"] });
  const toggle = useMutation({ mutationFn: ({ key, enabled }: { key: Capability; enabled: boolean | null }) => platformApi.setTenantCapability(tenantId, key, enabled), onSuccess: refresh });
  const plan = useMutation({
    mutationFn: (reason: string) => platformApi.changeTenantPlan(tenantId, { edition, version: matrix.data!.version, reason }),
    onSuccess: async () => {
      await refresh();
      setChangingPlan(false);
    },
  });

  if (matrix.isError) return <ErrorPanel error={matrix.error} onRetry={() => matrix.refetch()} />;
  if (!matrix.data) return <TableSkeleton rows={10} cols={4} />;
  const m = matrix.data;

  return (
    <div className="space-y-3" data-testid="tenant-capabilities">
      {toggle.isError && (
        <p role="alert" className="rounded-control bg-danger-100/50 px-3 py-2 text-xs text-danger-700" data-testid="capability-error">
          {errorMessage(toggle.error)}
        </p>
      )}
      <Panel
        title="Modules & Capabilities"
        subtitle={`Plan: ${m.plan}`}
        padded={false}
        action={
          canEdit && (
            <Button
              size="sm"
              onClick={() => {
                setEdition(m.edition === "BETA_V1_CORE" ? "BETA_V2_GROWTH" : "BETA_V1_CORE");
                plan.reset();
                setChangingPlan(true);
              }}
              data-testid="change-plan"
            >
              Change plan
            </Button>
          )
        }
      >
        <div className="overflow-x-auto">
          <Table className="min-w-[760px]">
            <TableHead>
              <tr>
                <Th leading>Capability</Th>
                <Th>Plan provides</Th>
                <Th>Tenant override</Th>
                <Th>Effective</Th>
                <Th>
                  <span className="sr-only">Actions</span>
                </Th>
              </tr>
            </TableHead>
            <TableBody>
              {m.capabilities.map((c) => (
                <Tr key={c.key} data-testid={`cap-${c.key}`}>
                  <Td leading nowrap={false}>
                    <span className="flex items-center gap-1.5 font-medium">
                      {c.label}
                      {c.locked && <Lock size={12} className="text-ink-2" aria-label="Always on" />}
                    </span>
                    {c.dependsOn.length > 0 && <span className="block text-[11px] text-ink-2">Needs {c.dependsOn.map((d) => CAPABILITY_META[d].label).join(", ")}</span>}
                  </Td>
                  <Td>{c.planDefault ? "On" : "Off"}</Td>
                  <Td>{c.override === null ? <span className="text-ink-2">None</span> : <Badge tone="warning">Forced {c.override ? "on" : "off"}</Badge>}</Td>
                  <Td>
                    <span data-effective={c.effective}>
                      <Badge tone={c.effective ? "success" : "neutral"}>{c.effective ? "On" : "Off"}</Badge>
                    </span>
                  </Td>
                  <Td>
                    {canEdit && !c.locked && (
                      <span className="flex gap-1">
                        <Button size="sm" disabled={toggle.isPending} onClick={() => toggle.mutate({ key: c.key, enabled: !c.effective })} data-testid={`cap-toggle-${c.key}`}>
                          Turn {c.effective ? "off" : "on"}
                        </Button>
                        {c.override !== null && (
                          <Button size="sm" variant="ghost" disabled={toggle.isPending} onClick={() => toggle.mutate({ key: c.key, enabled: null })}>
                            Use plan default
                          </Button>
                        )}
                      </span>
                    )}
                  </Td>
                </Tr>
              ))}
            </TableBody>
          </Table>
        </div>
      </Panel>
      <ActionDialog
        open={changingPlan}
        title={`Change plan for ${detail.tenant.name}`}
        description="The tenant's defaults change at once; its own overrides stay. A change that leaves an override without what it depends on is refused."
        confirmLabel="Change plan"
        requireReason
        pending={plan.isPending}
        error={plan.error}
        onConfirm={(reason) => plan.mutate(reason)}
        onCancel={() => setChangingPlan(false)}
      >
        <FormField label="New plan" htmlFor="new-plan">
          <select id="new-plan" className={CONTROL} value={edition} onChange={(e) => setEdition(e.target.value as Edition)}>
            {(Object.keys(PLAN_META) as Edition[]).map((e) => (
              <option key={e} value={e} disabled={e === m.edition}>
                {PLAN_META[e].name}
                {e === m.edition ? " (current)" : ""}
              </option>
            ))}
          </select>
        </FormField>
      </ActionDialog>
    </div>
  );
}
