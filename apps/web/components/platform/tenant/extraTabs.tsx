import type { ComponentType } from "react";
import type { PlatformTenantDetail } from "@pulseos/types";
import { TenantUsersTab } from "./TenantUsersTab";
import { TenantCapabilitiesTab } from "./TenantCapabilitiesTab";

/** Tenant detail tabs that belong to other console areas (users, capabilities, support, audit), registered in one place. */
export interface ExtraTenantTab {
  key: string;
  label: string;
  position: "afterOverview" | "afterConfiguration" | "end";
  Component: ComponentType<{ detail: PlatformTenantDetail }>;
}

export const TENANT_EXTRA_TABS: ExtraTenantTab[] = [{ key: "users", label: "Users", position: "afterOverview", Component: TenantUsersTab },
  { key: "capabilities", label: "Modules & Capabilities", position: "afterConfiguration", Component: TenantCapabilitiesTab },
];
