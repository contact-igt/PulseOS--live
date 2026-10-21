import type {
  CreateTenantRequest,
  Capability,
  Edition,
  PlatformCapabilityMatrix,
  PlatformIntegrationDetail,
  PlatformSupportSession,
  PlatformAuditEvent,
  PlatformHealth,
  PlatformSettingsValues,
  PlatformIntegrationRow,
  PlatformPlan,
  PlatformInvitationRow,
  PlatformRole,
  PlatformStaffMember,
  PlatformTenantMember,
  PlatformUserDetail,
  PlatformUserQuery,
  PlatformUserRow,
  Role,
  Paged,
  PlatformOverview,
  PlatformSessionUser,
  PlatformTenant,
  PlatformTenantConfiguration,
  PlatformTenantDetail,
  PlatformTenantQuery,
  PlatformTenantRow,
  PlatformTenantUsage,
  SourceChannel,
  SurfaceStyle,
  TenantBrandingConfig,
  TenantEnvironment,
  TenantLifecycleAction,
} from "@pulseos/types";
import { apiRequest as request } from "./index";

/** Query string from defined, non-empty values only. */
function qs(params: object): string {
  const entries = (Object.entries(params) as [string, unknown][]).filter(([, v]) => v !== undefined && v !== null && v !== "");
  return entries.length ? "?" + new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString() : "";
}
const json = (method: string, body?: unknown): RequestInit => ({ method, body: body === undefined ? undefined : JSON.stringify(body) });

/**
 * The Platform Console API (company side). Separate cookie, separate identity: a tenant session gets 401 from every call.
 * Nothing here ever returns a password, a token, a credential or ciphertext.
 */
export const platformApi = {
  login: (email: string, password: string) => request<{ user: PlatformSessionUser }>("/platform/auth/login", json("POST", { email, password })),
  logout: () => request<{ ok: true }>("/platform/auth/logout", { method: "POST" }),
  session: () => request<{ user: PlatformSessionUser }>("/platform/auth/session"),
  overview: () => request<PlatformOverview>("/platform/overview"),

  // Tenants
  tenants: (q: PlatformTenantQuery = {}) => request<Paged<PlatformTenantRow>>(`/platform/tenants${qs(q)}`),
  departmentTemplates: () => request<{ templates: { key: string; displayName: string; description: string }[] }>("/platform/department-templates"),
  tenantIndustries: () => request<{ industries: string[] }>("/platform/tenants/industries"),
  createTenant: (body: CreateTenantRequest) => request<{ tenant: PlatformTenant; invitation: { id: string; deliveryStatus: "SENT" | "NOT_DELIVERED" } | null; created: boolean }>("/platform/tenants", json("POST", body)),
  tenant: (id: string) => request<PlatformTenantDetail>(`/platform/tenants/${encodeURIComponent(id)}`),
  editTenant: (id: string, body: { version: number; name?: string; loginSlug?: string; industry?: string; country?: string; timezone?: string; locale?: string; environment?: TenantEnvironment }) =>
    request<{ tenant: PlatformTenant }>(`/platform/tenants/${encodeURIComponent(id)}`, json("PATCH", body)),
  tenantLifecycle: (id: string, body: { action: TenantLifecycleAction; version: number; reason: string }) => request<{ tenant: PlatformTenant }>(`/platform/tenants/${encodeURIComponent(id)}/lifecycle`, json("POST", body)),
  saveTenantBranding: (id: string, body: Partial<TenantBrandingConfig>) => request<{ ok: true }>(`/platform/tenants/${encodeURIComponent(id)}/branding`, json("PUT", body)),
  saveTenantAppearance: (id: string, surfaceStyle: SurfaceStyle) => request<{ ok: true }>(`/platform/tenants/${encodeURIComponent(id)}/appearance`, json("PUT", { surfaceStyle })),
  setPrimaryAdmin: (id: string, userId: string) => request<{ ok: true }>(`/platform/tenants/${encodeURIComponent(id)}/primary-admin`, json("PUT", { userId })),
  tenantConfiguration: (id: string) => request<PlatformTenantConfiguration>(`/platform/tenants/${encodeURIComponent(id)}/configuration`),
  tenantUsage: (id: string) => request<PlatformTenantUsage>(`/platform/tenants/${encodeURIComponent(id)}/usage`),
  addBranch: (id: string, body: { name: string; city: string }) => request<{ ok: true }>(`/platform/tenants/${encodeURIComponent(id)}/branches`, json("POST", body)),
  updateBranch: (id: string, branchId: string, body: { name: string; city: string }) => request<{ ok: true }>(`/platform/tenants/${encodeURIComponent(id)}/branches/${encodeURIComponent(branchId)}`, json("PATCH", body)),
  installDepartment: (id: string, templateKey: string) => request<{ ok: true }>(`/platform/tenants/${encodeURIComponent(id)}/departments`, json("POST", { templateKey })),
  updateDepartment: (id: string, departmentId: string, body: { displayName?: string; archived?: boolean }) => request<{ ok: true }>(`/platform/tenants/${encodeURIComponent(id)}/departments/${encodeURIComponent(departmentId)}`, json("PATCH", body)),
  addLeadSource: (id: string, body: { label: string; bucket: SourceChannel }) => request<{ ok: true }>(`/platform/tenants/${encodeURIComponent(id)}/lead-sources`, json("POST", body)),
  updateLeadSource: (id: string, sourceId: string, body: { label?: string; bucket?: SourceChannel; archived?: boolean }) => request<{ ok: true }>(`/platform/tenants/${encodeURIComponent(id)}/lead-sources/${encodeURIComponent(sourceId)}`, json("PATCH", body)),

  // Users, memberships and account access (never a password, a token or a hash)
  users: (q: PlatformUserQuery = {}) => request<Paged<PlatformUserRow>>(`/platform/users${qs(q)}`),
  user: (accountId: string) => request<PlatformUserDetail>(`/platform/users/${encodeURIComponent(accountId)}`),
  tenantMembers: (tenantId: string) => request<{ members: PlatformTenantMember[] }>(`/platform/tenants/${encodeURIComponent(tenantId)}/members`),
  addMember: (tenantId: string, body: { name: string; email: string; role: Role }) => request<{ userId: string; invitation: { id: string; deliveryStatus: "SENT" | "NOT_DELIVERED" } }>(`/platform/tenants/${encodeURIComponent(tenantId)}/members`, json("POST", body)),
  changeMemberRole: (userId: string, body: { role: Role; version: number; confirmNoAdmin?: boolean }) => request<{ ok: true }>(`/platform/memberships/${encodeURIComponent(userId)}`, json("PATCH", body)),
  membershipAction: (userId: string, action: "suspend" | "reactivate" | "remove", body: { reason: string; confirmNoAdmin?: boolean }) => request<{ ok: true }>(`/platform/memberships/${encodeURIComponent(userId)}/${action}`, json("POST", body)),
  sendPasswordReset: (userId: string) => request<{ deliveryStatus: "SENT" | "NOT_DELIVERED" }>(`/platform/memberships/${encodeURIComponent(userId)}/password-reset`, { method: "POST" }),
  revokeMemberSessions: (userId: string) => request<{ revoked: number }>(`/platform/memberships/${encodeURIComponent(userId)}/revoke-sessions`, { method: "POST" }),
  revokeSession: (sessionId: string) => request<{ ok: true }>(`/platform/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" }),
  identityAction: (accountId: string, action: "suspend" | "reactivate", body: { reason: string; confirmNoAdmin?: boolean }) => request<{ affected: number }>(`/platform/users/${encodeURIComponent(accountId)}/${action}`, json("POST", body)),

  // Invitations
  invitations: (q: { status?: "pending" | "accepted" | "expired" | "revoked"; tenantId?: string; kind?: "tenant" | "platform"; q?: string; page?: number; pageSize?: number } = {}) =>
    request<Paged<PlatformInvitationRow> & { summary: { pending: number; expired: number; accepted: number; revoked: number } }>(`/platform/invitations${qs(q)}`),
  resendInvitation: (id: string) => request<{ invitation: { id: string; deliveryStatus: "SENT" | "NOT_DELIVERED" } }>(`/platform/invitations/${encodeURIComponent(id)}/resend`, { method: "POST" }),
  revokeInvitation: (id: string, reason: string) => request<{ ok: true }>(`/platform/invitations/${encodeURIComponent(id)}/revoke`, json("POST", { reason })),

  // Plans & capabilities (entitlements only - no billing)
  plans: () => request<{ plans: PlatformPlan[] }>("/platform/plans"),
  tenantCapabilities: (tenantId: string) => request<PlatformCapabilityMatrix>(`/platform/tenants/${encodeURIComponent(tenantId)}/capabilities`),
  setTenantCapability: (tenantId: string, key: Capability, enabled: boolean | null) => request<{ effective: Record<string, boolean> }>(`/platform/tenants/${encodeURIComponent(tenantId)}/capabilities/${key}`, json("PUT", { enabled })),
  changeTenantPlan: (tenantId: string, body: { edition: Edition; version: number; reason: string }) => request<{ ok: true }>(`/platform/tenants/${encodeURIComponent(tenantId)}/plan`, json("PUT", body)),

  // Integrations (state only: never a credential, ciphertext, payload or recording link)
  integrations: (q: { connector?: string; tenantId?: string; bucket?: "healthy" | "attention" | "not_configured"; page?: number; pageSize?: number } = {}) =>
    request<Paged<PlatformIntegrationRow> & { totals: { all: number; healthy: number; attention: number; not_configured: number }; connectors: { key: string; name: string }[] }>(`/platform/integrations${qs(q)}`),
  tenantIntegration: (tenantId: string, key: string) => request<PlatformIntegrationDetail>(`/platform/tenants/${encodeURIComponent(tenantId)}/integrations/${encodeURIComponent(key)}`),

  // Support Mode (time-limited, reasoned, audited; read-only unless edits are enabled)
  supportSessions: (q: { tenantId?: string; active?: "true" | "false"; mine?: "true" | "false"; page?: number; pageSize?: number } = {}) => request<Paged<PlatformSupportSession>>(`/platform/support-sessions${qs(q)}`),
  startSupport: (tenantId: string, body: { reason: string; minutes?: number }) => request<{ session: PlatformSupportSession }>(`/platform/tenants/${encodeURIComponent(tenantId)}/support-sessions`, json("POST", body)),
  enableSupportEdits: (id: string, body: { reason: string; minutes: number }) => request<{ session: PlatformSupportSession }>(`/platform/support-sessions/${encodeURIComponent(id)}/enable-edits`, json("POST", body)),
  disableSupportEdits: (id: string) => request<{ ok: true }>(`/platform/support-sessions/${encodeURIComponent(id)}/disable-edits`, { method: "POST" }),
  endSupport: (id: string) => request<{ ok: true }>(`/platform/support-sessions/${encodeURIComponent(id)}/end`, { method: "POST" }),

  // Audit & security, health, settings
  audit: (q: { q?: string; action?: string; outcome?: "SUCCESS" | "DENIED" | "FAILURE"; tenantId?: string; context?: "PLATFORM" | "SUPPORT_MODE" | "SYSTEM"; security?: "true"; from?: string; to?: string; page?: number; pageSize?: number } = {}) =>
    request<Paged<PlatformAuditEvent>>(`/platform/audit${qs(q)}`),
  tenantAudit: (tenantId: string) =>
    request<{ platform: { id: string; at: string; actor: string; action: string; outcome: string; context: string; summary: string; reason: string | null }[]; tenantActivity: { id: string; at: string; actor: string; action: string; entityType: string; entityKey: string | null }[] }>(`/platform/tenants/${encodeURIComponent(tenantId)}/audit`),
  health: () => request<PlatformHealth>("/platform/health"),
  settings: () => request<{ settings: PlatformSettingsValues; defaults: PlatformSettingsValues; emailProvider: string }>("/platform/settings"),
  saveSettings: (body: PlatformSettingsValues) => request<{ settings: PlatformSettingsValues; changed: string[] }>("/platform/settings", json("PUT", body)),

  // Platform staff
  staff: () => request<{ staff: PlatformStaffMember[] }>("/platform/staff"),
  inviteStaff: (body: { name: string; email: string; role: PlatformRole }) => request<{ id: string; invitation: { id: string; deliveryStatus: "SENT" | "NOT_DELIVERED" } }>("/platform/staff", json("POST", body)),
  changeStaffRole: (id: string, body: { role: PlatformRole; version: number }) => request<{ ok: true }>(`/platform/staff/${encodeURIComponent(id)}`, json("PATCH", body)),
  staffAction: (id: string, action: "suspend" | "reactivate", reason: string) => request<{ ok: true }>(`/platform/staff/${encodeURIComponent(id)}/${action}`, json("POST", { reason })),
  revokeStaffSessions: (id: string, sessionId?: string) => request<{ revoked: number }>(`/platform/staff/${encodeURIComponent(id)}/revoke-sessions`, json("POST", sessionId ? { sessionId } : {})),
};

/** Public account links (invitation / password reset). The token is read from the URL fragment and sent only in a body. */
export const accountApi = {
  inspect: (token: string) => request<{ purpose: "INVITE" | "PASSWORD_RESET"; email: string; name: string; workspace: string | null; signInPath: string }>("/auth/account-token/inspect", json("POST", { token })),
  accept: (token: string, password: string) => request<{ ok: true; signInPath: string }>("/auth/account-token/accept", json("POST", { token, password })),
};

export { qs as platformQuery, json as platformJson };
export type { Paged };
