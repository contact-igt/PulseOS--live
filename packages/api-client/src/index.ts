import type {
  ClinicHours,
  DisplayPreferences,
  SetupStatus,
  DevEnvironment,
  SignupInput,
  ActivityEntry,
  AdsAnalytics,
  AdsSyncRunVm,
  MessageTemplateVm,
  NotificationRuleVm,
  WhatsAppPreview,
  Capability,
  Edition,
  IntegrationCard,
  IntegrationDetail,
  IntegrationLogRow,
  OutboundWebhookVm,
  WebhookCondition,
  WebhookEventType,
  WebhookHeader,
  WebhookPayloadMapping,
  WebhookHttpMethod,
  WebhookCategory,
  TestWebhookInput,
  TestWebhookResult,
  AnalyticsCampaigns,
  AnalyticsFilterOptions,
  AnalyticsFlow,
  AnalyticsFunnel,
  AnalyticsQuery,
  OperationsReport,
  ReportExportKind,
  ReportFilterOptions,
  ReportQuery,
  AnalyticsRevenue,
  AnalyticsServices,
  AnalyticsSummary,
  AnalyticsTeam,
  LeadsBySourceResponse,
  SourceConversionResponse,
  AppointmentAction,
  AppointmentActionResult,
  AppointmentReasonCode,
  AppointmentRow,
  AppointmentStatus,
  CompleteAppointmentInput,
  CompleteAppointmentResult,
  CreateScheduleResourceInput,
  RescheduleAppointmentInput,
  ScheduleResourceVm,
  ScheduleSurgeryInput,
  UpdateScheduleResourceInput,
  AttentionItem,
  Branch,
  BranchDoctorRow,
  ServiceMixRow,
  PerformanceDashboard,
  CampaignFilters,
  CampaignPerformanceRow,
  FrontDeskDashboard,
  CommunicationEndpointVm,
  ConnectorDetail,
  CallFeedbackInput,
  CreateFollowUpInput,
  CreateFollowUpTypeInput,
  FollowUpTypeVm,
  UpdateFollowUpTypeInput,
  CallTranscriptVm,
  CreateLeadSourceInput,
  LogCallInput,
  LogCallResult,
  DepartmentTemplateVm,
  DepartmentVm,
  LeadSourceVm,
  UpdateDepartmentInput,
  UpdateLeadSourceInput,
  ConnectorRow,
  RecordOutcomeInput,
  ConversationAutomationMode,
  ConversationAutomationPreference,
  ConversationChannel,
  ConversationDetail,
  ConversationRow,
  ConversionStage,
  CreateAppointmentInput,
  CreateCommunicationEndpointInput,
  CreateCustomFieldInput,
  CreateLeadInput,
  CreateLeadResult,
  CreatePatientInput,
  CreatePatientResult,
  CreateTaskInput,
  AllocationRuleVm,
  CreateAllocationRuleInput,
  CreateCrmFieldInput,
  CreateCrmOutcomeInput,
  CrmFieldVm,
  CrmOutcomeVm,
  LogInteractionInput,
  LogInteractionResult,
  UpdateAllocationRuleInput,
  UpdateCrmOutcomeInput,
  CustomFieldDefinitionVm,
  FieldGroupKey,
  FieldPlacement,
  UpdateCrmFieldInput,
  DoctorDashboard,
  ExecutiveStrip,
  BulkAssignJourneyOwnerResult,
  JourneyDetailVm,
  JourneyHealth,
  JourneyListRow,
  JourneysSummary,
  LeadPhoneLookupResult,
  LeadRow,
  LeadStatus,
  LeadsSummary,
  LeadsWorkspace,
  LeadsWorkspaceQuery,
  Lookups,
  MarketingEfficiencySummary,
  MarketingSourceRow,
  OwnershipState,
  Patient360,
  TimelineEventVm,
  PatientFlowCount,
  PatientListRow,
  PatientSearchRow,
  Role,
  SessionUser,
  SurfaceStyle,
  SourcePerformanceRow,
  SpecialtyDetailVm,
  SpecialtyTemplateVm,
  SpendAtRisk,
  SpendAtRiskSummary,
  TaskCounts,
  TaskReason,
  TaskRow,
  TaskView,
  TeamWorkloadRow,
  TodayStrip,
  TreatmentDefinitionVm,
  TreatmentFilters,
  TreatmentRow,
  TreatmentStatus,
  UpdateCommunicationEndpointInput,
  UpdateCustomFieldInput,
  UpdateSpecialtyInput,
} from "@pulseos/types";

function resolveApiBase(raw: string | undefined): string {
  if (!raw) return "http://localhost:4310";
  const trimmed = raw.trim().replace(/\/+$/, "");
  return trimmed.startsWith("http://") || trimmed.startsWith("https://") ? trimmed : `https://${trimmed}`;
}

// Defaults to the API's own default port (apps/api PORT=4310); override with NEXT_PUBLIC_API_URL (apps/web/.env.local).
const API_BASE = resolveApiBase(process.env.NEXT_PUBLIC_API_URL);

class ApiError extends Error {
  status: number;
  /** Field-level problems the API reported (validation errors), when it sent any. */
  issues: { path: string; message: string }[];
  constructor(status: number, message: string, issues: { path: string; message: string }[] = []) {
    super(message);
    this.status = status;
    this.issues = issues;
  }
}

export interface CapabilityState {
  key: Capability;
  label: string;
  description: string;
  enabled: boolean;
  editionDefault: boolean;
  overridden: boolean;
  dependsOn: Capability[];
  provider: string | null;
  growth: boolean;
  editable: boolean;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  // JSON content-type only when there is a string (JSON) body: Fastify
  // rejects a bodyless request that claims application/json with 400
  // (FST_ERR_CTP_EMPTY_JSON_BODY). FormData gets no header so the browser can
  // add the multipart boundary; a caller-provided content-type is kept.
  if (typeof init?.body === "string" && !headers.has("content-type")) headers.set("content-type", "application/json");

  const res = await fetch(`${API_BASE}${path}`, { ...init, credentials: "include", headers });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string; issues?: { path: string; message: string }[] } | null;
    throw new ApiError(res.status, body?.error ?? res.statusText, Array.isArray(body?.issues) ? body.issues : []);
  }
  // 204, or a 200 with no body (e.g. a bare acknowledgement): nothing to parse.
  const text = res.status === 204 ? "" : await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export { request as apiRequest };

/**
 * Downloads a report workbook (.xlsx) with the session cookie. Returns the bytes and the server's filename so the caller
 * can hand the file to the browser; a refusal or failure is an ApiError like any other call (never a broken file).
 */
async function downloadReport(kind: ReportExportKind, q: ReportQuery): Promise<{ blob: Blob; filename: string }> {
  const params = new URLSearchParams({ kind });
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== "") params.set(k, String(v));
  const res = await fetch(`${API_BASE}/reports/export?${params.toString()}`, { credentials: "include" });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
    throw new ApiError(res.status, body?.message ?? body?.error ?? res.statusText);
  }
  const filename = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? `pulseos-${kind}.xlsx`;
  return { blob: await res.blob(), filename };
}

export type { TimelineEventVm };

export interface PatientListFilters {
  search?: string;
  branchId?: string;
  source?: string;
  stage?: string;
}

export interface JourneyFilters {
  source?: string;
  campaignId?: string;
  branchId?: string;
  stage?: string;
  ownerId?: string;
  /** Server-side owner filter: "mine" (session user), "unassigned", or a user id. */
  owner?: "mine" | "unassigned" | (string & {});
  doctorId?: string;
}

function toQuery(params: object): string {
  const entries = (Object.entries(params) as [string, string | undefined | null][]).filter(([, v]) => v !== undefined && v !== null && v !== "");
  if (entries.length === 0) return "";
  return "?" + new URLSearchParams(entries as [string, string][]).toString();
}

/** Same as toQuery, kept under the flagship checkpoint's original name for its own call sites below. */
const qs = toQuery;

export interface DashboardQuery {
  branchId?: string;
  journeyType?: string;
  /** Shared date preset (hospital timezone); omit for all time. `from`/`to` accompany range "custom". */
  range?: string;
  from?: string;
  to?: string;
}

export const api = {
  login: (email: string, password: string, remember = false) =>
    request<{ user: SessionUser }>("/auth/login", { method: "POST", body: JSON.stringify({ email, password, remember }) }),
  /** A hospital's dedicated sign-in page: the hospital is fixed by the slug; the body can name nothing else. */
  tenantBranding: (slug: string) => request<{ slug: string; name: string }>(`/auth/tenants/${encodeURIComponent(slug)}`),
  tenantLogin: (slug: string, email: string, password: string, remember = false) =>
    request<{ user: SessionUser }>(`/auth/login/tenant/${encodeURIComponent(slug)}`, { method: "POST", body: JSON.stringify({ email, password, remember }) }),
  logout: () => request<{ ok: true }>("/auth/logout", { method: "POST" }),
  session: () => request<{ user: SessionUser }>("/auth/session"),
  /** Settings > Appearance: the hospital's interface style (admin only; one of three named styles). */
  /** My display: the signed-in person's own interface size / text size (never a hospital setting). */
  setMyPreferences: (prefs: Partial<DisplayPreferences>) => request<DisplayPreferences>("/me/preferences", { method: "PUT", body: JSON.stringify(prefs) }),
  setAppearance: (surfaceStyle: SurfaceStyle) => request<{ surfaceStyle: SurfaceStyle }>("/appearance", { method: "PUT", body: JSON.stringify({ surfaceStyle }) }),
  capabilities: () => request<{ edition: Edition; capabilities: CapabilityState[] }>("/capabilities"),
  setCapability: (key: string, enabled: boolean | null) =>
    request<{ ok: true; capabilities: Record<string, boolean> }>(`/capabilities/${key}`, { method: "PUT", body: JSON.stringify({ enabled }) }),
  /** 404s (thrown as ApiError) whenever Dev Login isn't enabled — the route
   * doesn't exist at all outside local development, see
   * apps/api/src/domain/auth/auth.routes.ts::devLoginEnabled. Callers treat
   * that 404 as "feature unavailable here", not an error to surface. */
  devLoginRoles: () => request<{ role: Role; label: string }[]>("/auth/dev-login/roles"),
  /** Hospitals listed in Developer Access (development only), each with the roles that exist in it. */
  devLoginEnvironments: () => request<DevEnvironment[]>("/auth/dev-login/environments"),
  /** Public hospital sign-up: the server creates the workspace and signs the owner in. */
  signup: (input: SignupInput) => request<{ user: SessionUser; workspace: { template: "installed" | "none" | "failed" } }>("/auth/signup", { method: "POST", body: JSON.stringify(input) }),
  devLogin: (role: Role, environment?: string) =>
    request<{ user: SessionUser }>("/auth/dev-login", { method: "POST", body: JSON.stringify({ role, environment }) }),
  branches: () => request<Branch[]>("/branches"),
  journeyTypes: () => request<string[]>("/journey-types"),
  today: (f: DashboardQuery = {}) => request<TodayStrip>(`/dashboard/today${qs(f)}`),
  setupStatus: () => request<SetupStatus>("/dashboard/setup-status"),
  executive: (f: DashboardQuery = {}) => request<ExecutiveStrip>(`/dashboard/executive${qs(f)}`),
  conversion: (f: DashboardQuery = {}) => request<ConversionStage[]>(`/dashboard/conversion${qs(f)}`),
  journeyHealth: (f: DashboardQuery = {}) => request<JourneyHealth>(`/dashboard/journey-health${qs(f)}`),
  patientFlow: (f: DashboardQuery = {}) => request<PatientFlowCount[]>(`/dashboard/patient-flow${qs(f)}`),
  attention: (f: DashboardQuery = {}) => request<AttentionItem[]>(`/dashboard/attention${qs(f)}`),
  spendAtRisk: () => request<SpendAtRiskSummary>("/dashboard/spend-at-risk"),
  spendAtRiskByReason: (f: DashboardQuery = {}) => request<SpendAtRisk>(`/dashboard/spend-at-risk-by-reason${qs(f)}`),
  sourcePerformance: (f: DashboardQuery = {}) => request<SourcePerformanceRow[]>(`/dashboard/source-performance${qs(f)}`),
  marketing: () => request<MarketingSourceRow[]>("/dashboard/marketing"),
  team: (f: DashboardQuery = {}) => request<TeamWorkloadRow[]>(`/dashboard/team${qs(f)}`),
  branchDoctor: (f: DashboardQuery = {}) => request<BranchDoctorRow[]>(`/dashboard/branch-doctor${qs(f)}`),
  serviceMix: (f: DashboardQuery = {}) => request<ServiceMixRow[]>(`/dashboard/service-mix${qs(f)}`),
  /** The owner's Performance view: funnel, rule-based findings, source / service / team breakdowns (no revenue). */
  performance: (f: DashboardQuery = {}) => request<PerformanceDashboard>(`/dashboard/performance${qs(f)}`),
  doctorDashboard: (date?: string) => request<DoctorDashboard>(`/dashboard/doctor${toQuery({ date })}`),
  patients: (filters: PatientListFilters = {}) => request<PatientListRow[]>(`/patients${toQuery({ ...filters })}`),
  searchPatients: (q: string) => request<PatientSearchRow[]>(`/patients/search${toQuery({ q })}`),
  createPatient: (input: CreatePatientInput) => request<CreatePatientResult>("/patients", { method: "POST", body: JSON.stringify(input) }),
  patient360: (id: string) => request<Patient360>(`/patients/${id}/360`),
  patientTimeline: (id: string, journeyId?: string) => request<TimelineEventVm[]>(`/patients/${id}/timeline${toQuery({ journeyId })}`),
  // --- P2 view additions ---
  /** Patient 360 "Upcoming": open appointments, open tasks, scheduled treatments for one patient (permission-trimmed server-side). */
  patientUpcoming: (id: string) => request<import("@pulseos/types").PatientUpcoming>(`/patients/${id}/upcoming`),
  // --- end P2 view additions ---
  journeys: (filters: JourneyFilters = {}) => request<JourneyListRow[]>(`/journeys${toQuery({ ...filters })}`),
  journeysSummary: () => request<JourneysSummary>("/journeys/summary"),
  journeyDetail: (id: string) => request<JourneyDetailVm>(`/journeys/${id}`),
  /** null unassigns. 403 without MANAGE_JOURNEYS; 404 unknown/other-tenant journey; 422 assignee not in this tenant. Returns the updated detail. */
  assignJourneyOwner: (id: string, ownerUserId: string | null) =>
    request<JourneyDetailVm>(`/journeys/${id}/owner`, { method: "PATCH", body: JSON.stringify({ ownerUserId }) }),
  /** 1..100 journeys, all-or-nothing (any out-of-tenant id rejects the whole request). */
  assignJourneyOwnerBulk: (journeyIds: string[], ownerUserId: string | null) =>
    request<BulkAssignJourneyOwnerResult>("/journeys/owner", { method: "POST", body: JSON.stringify({ journeyIds, ownerUserId }) }),
  recordOutcome: (appointmentId: string, input: Omit<RecordOutcomeInput, "appointmentId">) =>
    request<{ ok: true }>(`/appointments/${appointmentId}/outcome`, { method: "POST", body: JSON.stringify(input) }),
  lookups: () => request<Lookups>("/lookups"),
  updateClinicHours: (clinicHours: ClinicHours) => request<{ clinicHours: ClinicHours }>("/clinic-hours", { method: "PUT", body: JSON.stringify({ clinicHours }) }),
  tasks: (filters: { view?: TaskView; assignedTo?: string; patientId?: string; reason?: TaskReason; followUpTypeKey?: string; completedFrom?: string; completedTo?: string } = {}) =>
    request<TaskRow[]>(`/tasks${toQuery({ ...filters })}`),
  /** `window` bounds the Completed count to the days tasks were completed on (hospital days), matching the Completed list. */
  taskCounts: (window: { completedFrom?: string; completedTo?: string } = {}) => request<TaskCounts>(`/tasks/counts${toQuery({ ...window })}`),
  createTask: (input: CreateTaskInput) => request<TaskRow>("/tasks", { method: "POST", body: JSON.stringify(input) }),
  addTaskNote: (id: string, notes: string) => request<TaskRow>(`/tasks/${id}/note`, { method: "PATCH", body: JSON.stringify({ notes }) }),
  rescheduleTask: (id: string, dueAt: string, note?: string) => request<TaskRow>(`/tasks/${id}/reschedule`, { method: "PATCH", body: JSON.stringify({ dueAt, ...(note ? { note } : {}) }) }),
  followUpTypes: (opts: { includeInactive?: boolean; journeyId?: string } = {}) => request<FollowUpTypeVm[]>(`/followup-types${toQuery({ includeInactive: opts.includeInactive ? "true" : undefined, journeyId: opts.journeyId })}`),
  createFollowUpType: (input: CreateFollowUpTypeInput) => request<FollowUpTypeVm>("/followup-types", { method: "POST", body: JSON.stringify(input) }),
  updateFollowUpType: (id: string, input: UpdateFollowUpTypeInput) => request<FollowUpTypeVm>(`/followup-types/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  reorderFollowUpTypes: (orderedIds: string[]) => request<{ ok: true }>("/followup-types/reorder", { method: "POST", body: JSON.stringify({ orderedIds }) }),
  createFollowUp: (journeyId: string, input: CreateFollowUpInput) => request<TaskRow>(`/journeys/${journeyId}/follow-ups`, { method: "POST", body: JSON.stringify(input) }),
  reassignTask: (id: string, assignedTo: string) => request<TaskRow>(`/tasks/${id}/reassign`, { method: "PATCH", body: JSON.stringify({ assignedTo }) }),
  completeTask: (id: string) => request<TaskRow>(`/tasks/${id}/complete`, { method: "PATCH", body: JSON.stringify({}) }),
  appointments: (filters: { branchId?: string; doctorId?: string; status?: AppointmentStatus; date?: string; search?: string } = {}) =>
    request<AppointmentRow[]>(`/appointments${toQuery({ ...filters })}`),
  frontDesk: (opts: { branchId?: string; date?: string } = {}) => request<FrontDeskDashboard>(`/front-desk${toQuery({ ...opts })}`),
  appointmentAction: (id: string, action: AppointmentAction, reason?: { reasonCode?: AppointmentReasonCode; note?: string; queue?: boolean }) =>
    request<AppointmentActionResult>(`/appointments/${id}/action`, { method: "PATCH", body: JSON.stringify({ action, ...reason }) }),
  completeAppointment: (id: string, input: CompleteAppointmentInput = {}) => request<CompleteAppointmentResult>(`/appointments/${id}/complete`, { method: "PATCH", body: JSON.stringify(input) }),
  rescheduleAppointment: (id: string, input: RescheduleAppointmentInput) =>
    request<{ ok: true; alreadyApplied?: boolean }>(`/appointments/${id}/reschedule`, { method: "PATCH", body: JSON.stringify(input) }),
  /** Doctors / resources appointments and surgeries are scheduled with (a login is optional). */
  resources: (opts: { includeInactive?: boolean } = {}) => request<ScheduleResourceVm[]>(`/resources${toQuery({ includeInactive: opts.includeInactive ? "true" : undefined })}`),
  createResource: (input: CreateScheduleResourceInput) => request<ScheduleResourceVm>("/resources", { method: "POST", body: JSON.stringify(input) }),
  updateResource: (id: string, input: UpdateScheduleResourceInput) => request<ScheduleResourceVm>(`/resources/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  /** Schedule a procedure for a Journey (the same record the Treatments views show). */
  scheduleSurgery: (journeyId: string, input: ScheduleSurgeryInput) => request<{ ok: true; treatmentId: string }>(`/journeys/${journeyId}/surgery`, { method: "POST", body: JSON.stringify(input) }),
  rescheduleSurgery: (treatmentId: string, input: Partial<ScheduleSurgeryInput> & { scheduledAt: string }) =>
    request<{ ok: true; alreadyApplied?: boolean }>(`/treatments/${treatmentId}/schedule`, { method: "PATCH", body: JSON.stringify(input) }),
  // --- P1 view additions ---
  /** Same endpoint/rows as `appointments`, plus the from/to local-day range the calendar views use. */
  appointmentsInRange: (filters: import("@pulseos/types").AppointmentRangeFilters) => request<AppointmentRow[]>(`/appointments${toQuery({ ...filters })}`),
  appointmentCalendarContext: () => request<import("@pulseos/types").AppointmentCalendarContext>("/appointments/calendar-context"),
  // --- end P1 view additions ---
  treatments: (filters: TreatmentFilters = {}) => request<TreatmentRow[]>(`/treatments${toQuery({ ...filters })}`),
  treatmentCatalog: (specialtyKey?: string) => request<TreatmentDefinitionVm[]>(`/treatment-catalog${toQuery({ specialtyKey })}`),
  updateTreatmentStatus: (id: string, status: TreatmentStatus, plannedDate?: string) =>
    request<{ ok: true }>(`/treatments/${id}/status`, { method: "PATCH", body: JSON.stringify({ status, plannedDate }) }),
  conversations: (filters: { channel?: ConversationChannel; ownershipState?: OwnershipState; search?: string; communicationEndpointId?: string } = {}) =>
    request<ConversationRow[]>(`/conversations${toQuery({ ...filters })}`),
  conversation: (id: string) => request<ConversationDetail>(`/conversations/${id}`),
  sendConversationMessage: (id: string, body: string) =>
    request<{ ok: true }>(`/conversations/${id}/messages`, { method: "POST", body: JSON.stringify({ body }) }),
  claimConversation: (id: string) => request<{ ok: true }>(`/conversations/${id}/claim`, { method: "PATCH", body: JSON.stringify({}) }),
  assignConversation: (id: string, assignedTo: string) =>
    request<{ ok: true }>(`/conversations/${id}/assign`, { method: "PATCH", body: JSON.stringify({ assignedTo }) }),
  returnConversationToAi: (id: string) => request<{ ok: true }>(`/conversations/${id}/return-to-ai`, { method: "PATCH", body: JSON.stringify({}) }),
  closeConversation: (id: string) => request<{ ok: true }>(`/conversations/${id}/close`, { method: "PATCH", body: JSON.stringify({}) }),
  conversationAutomation: (id: string) => request<ConversationAutomationPreference>(`/conversations/${id}/automation`),
  setConversationAutomation: (id: string, input: { mode: ConversationAutomationMode; scheduledStart?: string; scheduledEnd?: string; timezone?: string }) =>
    request<ConversationAutomationPreference>(`/conversations/${id}/automation`, { method: "PATCH", body: JSON.stringify(input) }),
  leadSources: (opts: { includeArchived?: boolean } = {}) => request<LeadSourceVm[]>(`/lead-sources${opts.includeArchived ? "?includeArchived=true" : ""}`),
  createLeadSource: (input: CreateLeadSourceInput) => request<LeadSourceVm>("/lead-sources", { method: "POST", body: JSON.stringify(input) }),
  reorderLeadSources: (orderedIds: string[]) => request<{ ok: true }>("/lead-sources/reorder", { method: "POST", body: JSON.stringify({ orderedIds }) }),
  updateLeadSource: (id: string, input: UpdateLeadSourceInput) => request<LeadSourceVm>(`/lead-sources/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  departments: () => request<DepartmentVm[]>("/departments"),
  departmentTemplates: () => request<DepartmentTemplateVm[]>("/department-templates"),
  installDepartment: (templateKey: string) => request<{ departmentId: string; created: boolean }>("/departments/install", { method: "POST", body: JSON.stringify({ templateKey }) }),
  updateDepartment: (id: string, input: UpdateDepartmentInput) => request<{ ok: true }>(`/departments/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  logCall: (journeyId: string, input: LogCallInput) => request<LogCallResult>(`/journeys/${journeyId}/calls`, { method: "POST", body: JSON.stringify(input) }),
  callFeedback: (callId: string, input: CallFeedbackInput) => request<{ ok: true; callbackTaskId: string | null }>(`/calls/${callId}/feedback`, { method: "POST", body: JSON.stringify(input) }),
  callTranscript: (callId: string) => request<CallTranscriptVm>(`/calls/${callId}/transcript`),
  retryCallIntelligence: (callId: string) => request<{ queued: boolean }>(`/calls/${callId}/intelligence/retry`, { method: "POST", body: JSON.stringify({}) }),
  /** URL of the authenticated recording stream (play in an <audio> tag, or download). The provider URL is never exposed. */
  callRecordingUrl: (callId: string, opts: { download?: boolean } = {}) => `${API_BASE}/calls/${callId}/recording${opts.download ? "?download=1" : ""}`,
  integrationHub: () => request<IntegrationCard[]>("/integrations/hub"),
  integrationDetail: (key: string) => request<IntegrationDetail>(`/integrations/hub/${key}`),
  configureIntegration: (key: string, body: { configuration?: Record<string, string>; secrets?: Record<string, string>; mode?: "FIXTURE" | "SANDBOX" | "LIVE" }) =>
    request<IntegrationDetail>(`/integrations/hub/${key}/configuration`, { method: "PUT", body: JSON.stringify(body) }),
  integrationLogs: (filters: { provider?: string; status?: string; from?: string; to?: string }) => {
    const qs = new URLSearchParams(Object.entries(filters).filter(([, v]) => !!v) as [string, string][]).toString();
    return request<IntegrationLogRow[]>(`/integrations/logs${qs ? `?${qs}` : ""}`);
  },
  checkIntegrationStatus: (key: string) =>
    request<{ ok: boolean; health: string; status: string; message: string; checkedAt: string; details?: Record<string, unknown> }>(`/integrations/hub/${key}/status`, { method: "POST" }),
  testIntegrationEvent: (key: string) =>
    request<{ ok: boolean; message: string; callId?: string }>(`/integrations/hub/${key}/test-event`, { method: "POST" }),
  webhooks: () => request<OutboundWebhookVm[]>("/integrations/webhooks"),
  createWebhook: (body: {
    name: string;
    url: string;
    endpointPath?: string | null;
    httpMethod?: WebhookHttpMethod;
    headers?: WebhookHeader[];
    payloadMapping?: WebhookPayloadMapping[];
    webhookCategory?: WebhookCategory;
    events: WebhookEventType[];
    conditions?: WebhookCondition[];
    enabled?: boolean;
  }) =>
    request<{ webhook: OutboundWebhookVm; signingSecret: string }>("/integrations/webhooks", { method: "POST", body: JSON.stringify(body) }),
  updateWebhook: (
    id: string,
    body: Partial<{
      name: string;
      url: string;
      endpointPath: string | null;
      httpMethod: WebhookHttpMethod;
      headers: WebhookHeader[];
      payloadMapping: WebhookPayloadMapping[];
      webhookCategory: WebhookCategory;
      events: WebhookEventType[];
      conditions: WebhookCondition[];
      enabled: boolean;
    }>
  ) =>
    request<OutboundWebhookVm>(`/integrations/webhooks/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteWebhook: (id: string) => request<void>(`/integrations/webhooks/${id}`, { method: "DELETE" }),
  testWebhook: (body: TestWebhookInput) =>
    request<TestWebhookResult>("/integrations/webhooks/test", { method: "POST", body: JSON.stringify(body) }),
  activityLog: (f: { action?: string; entityType?: string; from?: string; to?: string } = {}) => request<ActivityEntry[]>(`/activity-log${toQuery({ ...f })}`),
  notificationRules: () => request<NotificationRuleVm[]>("/notifications/rules"),
  updateNotificationRule: (id: string, body: Partial<Pick<NotificationRuleVm, "enabled" | "offsetValue" | "offsetUnit" | "templateId" | "minGapMinutes">>) =>
    request<NotificationRuleVm>(`/notifications/rules/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  messageTemplates: () => request<MessageTemplateVm[]>("/notifications/templates"),
  updateMessageTemplate: (id: string, body: Partial<Pick<MessageTemplateVm, "name" | "providerTemplateName" | "language" | "body" | "enabled">>) =>
    request<MessageTemplateVm>(`/notifications/templates/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  whatsappPreview: (journeyId: string) => request<WhatsAppPreview>(`/journeys/${journeyId}/whatsapp/preview`),
  sendWhatsApp: (journeyId: string, idempotencyKey: string) =>
    request<{ notificationId: string; status: string; duplicate: boolean }>(`/journeys/${journeyId}/whatsapp`, { method: "POST", body: JSON.stringify({ idempotencyKey }) }),
  connectors: () => request<ConnectorRow[]>("/connectors"),
  connector: (id: string) => request<ConnectorDetail>(`/connectors/${id}`),
  updateConnector: (id: string, input: { displayName?: string; configuration?: Record<string, unknown>; secrets?: Record<string, unknown> }) =>
    request<{ ok: true }>(`/connectors/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  syncConnectorCampaigns: (id: string) =>
    request<{ ok: true; syncedCount: number } | { ok: false; reason: string; message?: string }>(`/connectors/${id}/sync-campaigns`, { method: "POST", body: JSON.stringify({}) }),
  syncConnectorPerformance: (id: string) =>
    request<{ ok: true; syncedCount: number } | { ok: false; reason: string; message?: string }>(`/connectors/${id}/sync-performance`, { method: "POST", body: JSON.stringify({}) }),
  /** Advisory only: is this doctor free at this instant? The booking itself is the authoritative check. */
  appointmentSlotCheck: (doctorId: string, scheduledAt: string, excludeId?: string) =>
    request<{ available: boolean; inPast: boolean; outsideHours: boolean }>(`/appointments/slot-check${toQuery({ doctorId, scheduledAt, excludeId })}`),
  createAppointment: (input: CreateAppointmentInput) => request<AppointmentRow>("/appointments", { method: "POST", body: JSON.stringify(input) }),

  // Communication endpoints (multi-hospital-number layer over a Connector)
  communicationEndpoints: (connectorId?: string) =>
    request<CommunicationEndpointVm[]>(connectorId ? `/connectors/${connectorId}/endpoints` : "/communication-endpoints"),
  createCommunicationEndpoint: (connectorId: string, input: CreateCommunicationEndpointInput) =>
    request<CommunicationEndpointVm>(`/connectors/${connectorId}/endpoints`, { method: "POST", body: JSON.stringify(input) }),
  updateCommunicationEndpoint: (connectorId: string, endpointId: string, input: UpdateCommunicationEndpointInput) =>
    request<CommunicationEndpointVm>(`/connectors/${connectorId}/endpoints/${endpointId}`, { method: "PATCH", body: JSON.stringify(input) }),

  // Leads (CRM-2/3/4)
  leads: (filters: { status?: LeadStatus; specialtyKey?: string; source?: string; owner?: "mine" | "unassigned" | (string & {}) } = {}) => request<LeadRow[]>(`/leads${toQuery({ ...filters })}`),
  leadsSummary: () => request<LeadsSummary>("/leads/summary"),
  leadsWorkspace: (q: LeadsWorkspaceQuery = {}) => request<LeadsWorkspace>(`/leads/workspace${toQuery({ ...q })}`),
  leadPhoneLookup: (phone: string) => request<LeadPhoneLookupResult>("/leads/lookup", { method: "POST", body: JSON.stringify({ phone }) }),
  createLead: (input: CreateLeadInput) => request<CreateLeadResult>("/leads", { method: "POST", body: JSON.stringify(input) }),

  // Specialties & custom fields (CRM-7/8)
  specialties: (includeDisabled = false) => request<SpecialtyTemplateVm[]>(`/specialties${toQuery({ includeDisabled: includeDisabled ? "true" : undefined })}`),
  specialtyFields: (key: string) => request<CustomFieldDefinitionVm[]>(`/specialties/${key}/fields`),
  specialtyDetail: (key: string) => request<SpecialtyDetailVm>(`/specialties/${key}`),
  createSpecialty: (input: { displayName: string; defaultJourneyType?: string }) => request<SpecialtyTemplateVm>("/specialties", { method: "POST", body: JSON.stringify(input) }),
  updateSpecialty: (key: string, input: UpdateSpecialtyInput) => request<SpecialtyDetailVm>(`/specialties/${key}`, { method: "PATCH", body: JSON.stringify(input) }),
  // CRM field configuration (Settings → CRM Fields) and the fields an entry form should show.
  crmFields: (opts: { specialtyKey?: string; includeArchived?: boolean } = {}) => request<CrmFieldVm[]>(`/crm/fields${toQuery({ specialtyKey: opts.specialtyKey, includeArchived: opts.includeArchived ? "true" : undefined })}`),
  crmFieldsFor: (placement: FieldPlacement, specialtyKey: string) => request<CrmFieldVm[]>(`/crm/fields/for${toQuery({ placement, specialtyKey })}`),
  fieldPrefill: (journeyId: string, placement: FieldPlacement) => request<Record<string, unknown>>(`/journeys/${journeyId}/field-prefill${toQuery({ placement })}`),
  crmFieldsForJourney: (placement: FieldPlacement, journeyId: string) => request<CrmFieldVm[]>(`/crm/fields/for${toQuery({ placement, journeyId })}`),
  // Configurable outcomes (Settings → Workflow Outcomes) and logging one on a Journey.
  crmOutcomes: (opts: { includeArchived?: boolean } = {}) => request<CrmOutcomeVm[]>(`/crm/outcomes${toQuery({ includeArchived: opts.includeArchived ? "true" : undefined })}`),
  createCrmOutcome: (input: CreateCrmOutcomeInput) => request<CrmOutcomeVm>("/crm/outcomes", { method: "POST", body: JSON.stringify(input) }),
  updateCrmOutcome: (id: string, input: UpdateCrmOutcomeInput) => request<CrmOutcomeVm>(`/crm/outcomes/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  reorderCrmOutcomes: (orderedIds: string[]) => request<{ ok: true }>("/crm/outcomes/reorder", { method: "POST", body: JSON.stringify({ orderedIds }) }),
  logInteraction: (journeyId: string, input: LogInteractionInput) => request<LogInteractionResult>(`/journeys/${journeyId}/interactions`, { method: "POST", body: JSON.stringify(input) }),
  // Allocation rules (Settings → Allocation Rules).
  allocationRules: () => request<AllocationRuleVm[]>("/crm/allocation-rules"),
  createAllocationRule: (input: CreateAllocationRuleInput) => request<AllocationRuleVm>("/crm/allocation-rules", { method: "POST", body: JSON.stringify(input) }),
  updateAllocationRule: (id: string, input: UpdateAllocationRuleInput) => request<AllocationRuleVm>(`/crm/allocation-rules/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteAllocationRule: (id: string) => request<{ ok: true }>(`/crm/allocation-rules/${id}`, { method: "DELETE" }),
  reorderAllocationRules: (orderedIds: string[]) => request<{ ok: true }>("/crm/allocation-rules/reorder", { method: "POST", body: JSON.stringify({ orderedIds }) }),
  createCrmField: (input: CreateCrmFieldInput) => request<CrmFieldVm>("/crm/fields", { method: "POST", body: JSON.stringify(input) }),
  updateCrmField: (id: string, input: UpdateCrmFieldInput) => request<CrmFieldVm>(`/crm/fields/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  reorderCrmFields: (input: { specialtyKey: string; groupKey: FieldGroupKey; orderedIds: string[] }) => request<{ ok: true }>("/crm/fields/reorder", { method: "POST", body: JSON.stringify(input) }),
  createCustomField: (key: string, input: CreateCustomFieldInput) => request<CustomFieldDefinitionVm>(`/specialties/${key}/fields`, { method: "POST", body: JSON.stringify(input) }),
  updateCustomField: (fieldId: string, input: UpdateCustomFieldInput) => request<{ ok: true }>(`/specialties/fields/${fieldId}`, { method: "PATCH", body: JSON.stringify(input) }),

  // Campaigns / marketing efficiency (CRM-9/10)
  campaignPerformance: (filters: CampaignFilters = {}) => request<CampaignPerformanceRow[]>(`/campaigns/performance${toQuery({ ...filters })}`),
  marketingEfficiency: (filters: CampaignFilters = {}) => request<MarketingEfficiencySummary>(`/campaigns/marketing-efficiency${toQuery({ ...filters })}`),
  campaignSpendAtRisk: () => request<SpendAtRisk>("/campaigns/spend-at-risk"),
  // --- P3 view additions ---
  /** Same endpoint and rows as campaignPerformance, typed with the run window (startDate / endDate|null / status) the Calendar and Timeline views need. */
  campaignViewRows: (filters: CampaignFilters = {}) => request<import("@pulseos/types").CampaignViewRow[]>(`/campaigns/performance${toQuery({ ...filters })}`),
  // --- end P3 view additions ---

  // Analytics workspace — every call takes the same AnalyticsQuery so all panels agree.
  analyticsSummary: (q: AnalyticsQuery = {}) => request<AnalyticsSummary>(`/analytics/summary${toQuery({ ...q })}`),
  operationsReport: (q: ReportQuery = {}) => request<OperationsReport>(`/reports/operations${toQuery({ ...q })}`),
  reportFilterOptions: () => request<ReportFilterOptions>("/reports/filter-options"),
  downloadReport,
  analyticsLeads: (q: AnalyticsQuery = {}) => request<LeadsBySourceResponse>(`/analytics/leads${toQuery({ ...q })}`),
  analyticsFunnel: (q: AnalyticsQuery = {}) => request<AnalyticsFunnel>(`/analytics/funnel${toQuery({ ...q })}`),
  analyticsSourceConversion: (q: AnalyticsQuery = {}) => request<SourceConversionResponse>(`/analytics/source-conversion${toQuery({ ...q })}`),
  analyticsRevenue: (q: AnalyticsQuery = {}) => request<AnalyticsRevenue>(`/analytics/revenue${toQuery({ ...q })}`),
  analyticsAds: (q: AnalyticsQuery = {}) => request<AdsAnalytics>(`/analytics/ads${toQuery({ ...q })}`),
  syncAds: (key: "google_ads" | "meta_ads") => request<AdsSyncRunVm>(`/integrations/hub/${key}/sync`, { method: "POST" }),
  analyticsCampaigns: (q: AnalyticsQuery = {}) => request<AnalyticsCampaigns>(`/analytics/campaigns${toQuery({ ...q })}`),
  analyticsServices: (q: AnalyticsQuery = {}) => request<AnalyticsServices>(`/analytics/services${toQuery({ ...q })}`),
  analyticsFlow: (q: AnalyticsQuery = {}) => request<AnalyticsFlow>(`/analytics/flow${toQuery({ ...q })}`),
  analyticsTeam: (q: AnalyticsQuery = {}) => request<AnalyticsTeam>(`/analytics/team${toQuery({ ...q })}`),
  analyticsFilterOptions: () => request<AnalyticsFilterOptions>("/analytics/filter-options"),
};

export { ApiError };
export type { SessionUser };
