"use client";

import Link from "next/link";
import { Badge, Panel, Table, TableBody, TableHead, Td, Th, Tr } from "@pulseos/ui";
import type { PlatformTenantDetail } from "@pulseos/types";
import { ConfigurationBadge, CredentialBadge, EnabledBadge, HealthBadge, MODE_LABEL } from "../integrationLabels";
import { fmtAgo } from "../ui";

/** One hospital's integrations as the console sees them: state only. Credentials are never shown, only whether they are usable. */
export function TenantIntegrationsTab({ detail }: { detail: PlatformTenantDetail }) {
  return (
    <Panel
      title="Integrations"
      subtitle="Enabled, configured, credentials, activity and health are separate facts. To change configuration, use Support Mode with edits enabled — the hospital's own Integration Hub."
      padded={false}
      data-testid="tenant-integrations"
    >
      <div className="overflow-x-auto">
        <Table className="min-w-[900px]">
          <TableHead>
            <tr>
              <Th leading>Connector</Th>
              <Th>Enabled</Th>
              <Th>Configuration</Th>
              <Th>Credentials</Th>
              <Th>Mode</Th>
              <Th>Health</Th>
              <Th>Last event</Th>
              <Th>Lines</Th>
              <Th>Attention</Th>
            </tr>
          </TableHead>
          <TableBody>
            {detail.integrations.map((i) => (
              <Tr key={i.key} data-testid={`tenant-integration-${i.key}`}>
                <Td leading>
                  <Link href={`/platform/tenants/${detail.tenant.id}/integrations/${i.key}`} className="font-medium text-ink hover:text-primary-700">
                    {i.name}
                  </Link>
                  <span className="block text-[11px] text-ink-2">{i.category.toLowerCase()}</span>
                </Td>
                <Td>
                  <EnabledBadge enabled={i.enabled} />
                </Td>
                <Td>
                  <ConfigurationBadge state={i.configuration} />
                </Td>
                <Td>{i.blockedReason ? <span className="text-ink-2">—</span> : <CredentialBadge state={i.credentialState} />}</Td>
                <Td>{MODE_LABEL[i.mode]}</Td>
                <Td>
                  <HealthBadge health={i.health} />
                </Td>
                <Td>{i.lastEventAt ? fmtAgo(i.lastEventAt) : "Never"}</Td>
                <Td align="right">{i.endpointCount}</Td>
                <Td nowrap={false}>
                  {i.attention ? <Badge tone="warning">{i.attention}</Badge> : <span className="text-ink-2">—</span>}
                  {i.lastError && <span className="mt-0.5 block max-w-[260px] text-[11px] text-ink-2">{i.lastError}</span>}
                </Td>
              </Tr>
            ))}
          </TableBody>
        </Table>
      </div>
    </Panel>
  );
}
