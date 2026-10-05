export type Role = "SUPER_ADMIN" | "HOSPITAL_ADMIN" | "FRONT_DESK" | "PATIENT_COORDINATOR" | "DOCTOR";

// ---------------------------------------------------------------------------
// Editions — one codebase, one schema. A tenant's edition (tenants.edition) is the single source of truth
// for which growth capabilities it has; the API enforces it per route and the UI mirrors it for navigation.
// ---------------------------------------------------------------------------

export type Edition = "BETA_V1_CORE" | "BETA_V2_GROWTH";
export const EDITIONS: { key: Edition; label: string }[] = [
  { key: "BETA_V1_CORE", label: "Beta V1 · Core Hospital CRM" },
  { key: "BETA_V2_GROWTH", label: "Beta V2 · Growth / Engagement" },
];
export const DEFAULT_EDITION: Edition = "BETA_V2_GROWTH";

// ---------------------------------------------------------------------------
// Capabilities. An edition is only a DEFAULT BUNDLE of capabilities; a tenant's own settings (tenant_capabilities)
// are the runtime authority. Nothing in the product asks "is this V1?" — it asks "does this tenant have X?".
// Enabled, configured and healthy are three different facts: a capability being ON never implies a provider is connected.
// ---------------------------------------------------------------------------

export const CAPABILITIES = [
  "ANALYTICS_CORE",
  "MARKETING_ANALYTICS",
  "GOOGLE_ADS",
  "META_ADS",
  "RUNO_CALLING",
  "CCS_IVR",
  "WHATSAPP_NOTIFICATIONS",
  "WHATSAPP_INBOX",
  "CONVERSATION_INTELLIGENCE",
  "SMS_NOTIFICATIONS",
  "CAMPAIGNS",
  "SPEND_ATTRIBUTION",
  /** Revenue figures, payments and revenue-based ROAS. A hospital that does not run a revenue workflow switches it off. */
  "REVENUE_TRACKING",
] as const;
export type Capability = (typeof CAPABILITIES)[number];
/** Kept for existing call sites: a capability name. */
export type EditionCapability = Capability;
export type CapabilityMap = Record<Capability, boolean>;

/** What each edition switches on by default. Super Admin may override any of them per tenant. */
export const EDITION_CAPABILITIES: Record<Edition, Capability[]> = {
  BETA_V1_CORE: ["ANALYTICS_CORE", "RUNO_CALLING", "WHATSAPP_NOTIFICATIONS", "REVENUE_TRACKING"],
  BETA_V2_GROWTH: ["ANALYTICS_CORE", "MARKETING_ANALYTICS", "GOOGLE_ADS", "META_ADS", "RUNO_CALLING", "WHATSAPP_NOTIFICATIONS", "WHATSAPP_INBOX", "CONVERSATION_INTELLIGENCE", "CAMPAIGNS", "SPEND_ATTRIBUTION", "REVENUE_TRACKING"],
};

/** A capability that needs another one on. Explicit and small; nothing else is implied. */
export const CAPABILITY_DEPENDENCIES: Partial<Record<Capability, Capability[]>> = {
  CONVERSATION_INTELLIGENCE: ["WHATSAPP_INBOX"],
  SPEND_ATTRIBUTION: ["MARKETING_ANALYTICS"],
  // Revenue attribution and ROAS are computed from revenue, so a hospital without revenue tracking cannot have them.
  MARKETING_ANALYTICS: ["REVENUE_TRACKING"],
  CAMPAIGNS: ["MARKETING_ANALYTICS"],
  // Their only read surface is Marketing Analytics; syncing spend nobody can see would be silent cost.
  GOOGLE_ADS: ["MARKETING_ANALYTICS"],
  META_ADS: ["MARKETING_ANALYTICS"],
};

/** Capabilities nobody can switch off (the core product). */
export const LOCKED_CAPABILITIES: Capability[] = ["ANALYTICS_CORE"];

/** Operational switches a Hospital Admin may flip; everything else is a commercial entitlement (Super Admin). */
export const OPERATIONAL_CAPABILITIES: Capability[] = ["WHATSAPP_NOTIFICATIONS", "SMS_NOTIFICATIONS"];

export interface CapabilityMeta {
  label: string;
  description: string;
  /** The integration provider that makes this capability do anything (its configured / healthy facts), when there is one. */
  provider?: string;
  /** Shown as "Beta V2" while off. */
  growth?: boolean;
}

export const CAPABILITY_META: Record<Capability, CapabilityMeta> = {
  ANALYTICS_CORE: { label: "Core Analytics", description: "Leads, follow-ups, appointments, treatments and team performance." },
  MARKETING_ANALYTICS: { label: "Advanced Marketing Analytics", description: "Spend, campaigns, cost per lead / appointment / treatment, ROAS.", growth: true },
  GOOGLE_ADS: { label: "Google Ads", description: "Read-only campaign reporting from Google Ads.", provider: "google_ads", growth: true },
  META_ADS: { label: "Meta Ads", description: "Read-only campaign reporting from Meta Ads.", provider: "meta_ads", growth: true },
  RUNO_CALLING: { label: "Runo Calling", description: "Call events, recordings and dispositions from Runo.", provider: "runo" },
  CCS_IVR: { label: "CCS IVR", description: "IVR call events from CCS (provider documentation required).", provider: "ccs_ivr" },
  WHATSAPP_NOTIFICATIONS: { label: "WhatsApp Notifications", description: "Appointment and surgery confirmations and reminders, and staff follow-up messages.", provider: "whatsapp_meta_cloud" },
  WHATSAPP_INBOX: { label: "WhatsApp Inbox", description: "Two-way conversations with patients.", provider: "whatsapp_meta_cloud", growth: true },
  CONVERSATION_INTELLIGENCE: { label: "Conversation Intelligence", description: "Conversation summaries and context. Needs the WhatsApp Inbox.", growth: true },
  SMS_NOTIFICATIONS: { label: "SMS Notifications", description: "Text-message reminders (provider required).", provider: "sms" },
  CAMPAIGNS: { label: "Campaigns & Sources", description: "Campaign and source management.", growth: true },
  SPEND_ATTRIBUTION: { label: "Spend & Attribution", description: "Spend at risk and source performance on the Command Centre.", growth: true },
  REVENUE_TRACKING: { label: "Revenue Tracking", description: "Revenue figures, treatment payments and revenue-based ROAS. Off for hospitals that do not run a revenue workflow." },
};

export function isEdition(value: unknown): value is Edition {
  return value === "BETA_V1_CORE" || value === "BETA_V2_GROWTH";
}

/** The tenant's effective capabilities: the edition's defaults, then the tenant's own overrides on top. */
export function resolveCapabilities(edition: Edition, overrides: Partial<Record<Capability, boolean>>): CapabilityMap {
  const defaults = new Set(EDITION_CAPABILITIES[edition]);
  return Object.fromEntries(CAPABILITIES.map((c) => [c, overrides[c] ?? defaults.has(c)])) as CapabilityMap;
}

/** A capability's DEFAULT for an edition (no tenant overrides) — used only where no session map exists (tests, defaults). */
export function editionHasCapability(edition: Edition, capability: Capability): boolean {
  return EDITION_CAPABILITIES[edition].includes(capability);
}

/** True for an edition (its defaults) or for a tenant's resolved map (the runtime truth). */
export function capabilityEnabled(source: Edition | CapabilityMap, capability: Capability): boolean {
  return typeof source === "string" ? editionHasCapability(source, capability) : source[capability] === true;
}

export type CapabilityChangeResult = { ok: true } | { ok: false; reason: "requires" | "required_by" | "locked"; capabilities: Capability[] };

/** Is this switch allowed given what is on right now? Refuses invalid combinations and says what is in the way. */
export function validateCapabilityChange(current: CapabilityMap, capability: Capability, enabled: boolean): CapabilityChangeResult {
  if (!enabled && LOCKED_CAPABILITIES.includes(capability)) return { ok: false, reason: "locked", capabilities: [capability] };
  if (enabled) {
    const missing = (CAPABILITY_DEPENDENCIES[capability] ?? []).filter((d) => !current[d]);
    if (missing.length > 0) return { ok: false, reason: "requires", capabilities: missing };
  } else {
    const blocking = CAPABILITIES.filter((c) => current[c] && (CAPABILITY_DEPENDENCIES[c] ?? []).includes(capability));
    if (blocking.length > 0) return { ok: false, reason: "required_by", capabilities: blocking };
  }
  return { ok: true };
}

/** The Beta V1 UX names for the five stored roles. Doctor stays a role (and a resource) but has no V1 label. */
export type RoleGroup = "SUPER_ADMIN" | "ADMIN" | "STAFF" | "DOCTOR";
export const ROLE_GROUP: Record<Role, RoleGroup> = {
  SUPER_ADMIN: "SUPER_ADMIN",
  HOSPITAL_ADMIN: "ADMIN",
  FRONT_DESK: "STAFF",
  PATIENT_COORDINATOR: "STAFF",
  DOCTOR: "DOCTOR",
};
export const ROLE_GROUP_LABEL: Record<RoleGroup, string> = { SUPER_ADMIN: "Super Admin", ADMIN: "Admin", STAFF: "Staff", DOCTOR: "Doctor" };
export const roleGroupLabel = (role: Role): string => ROLE_GROUP_LABEL[ROLE_GROUP[role]];

/** How solid the interface surfaces are. One bounded per-hospital preference (Settings > Appearance); never free-form values. */
export const SURFACE_STYLES = ["airy", "balanced", "solid"] as const;
export type SurfaceStyle = (typeof SURFACE_STYLES)[number];
export const DEFAULT_SURFACE_STYLE: SurfaceStyle = "balanced";
export const SURFACE_STYLE_LABEL: Record<SurfaceStyle, { label: string; hint: string }> = {
  airy: { label: "Airy Glass", hint: "Softer, lighter panels. Menus stay clearly readable." },
  balanced: { label: "Balanced", hint: "The recommended mix of depth and clarity." },
  solid: { label: "Solid", hint: "Crisp, almost opaque surfaces everywhere." },
};

/**
 * Personal readability, chosen by each signed-in person for themselves (never a hospital setting, never shared). Two independent,
 * bounded choices: how roomy the interface is (control heights, row density, spacing) and how large the text is.
 */
export const INTERFACE_SIZES = ["compact", "comfortable", "large"] as const;
export type InterfaceSize = (typeof INTERFACE_SIZES)[number];
export const DEFAULT_INTERFACE_SIZE: InterfaceSize = "comfortable";
export const INTERFACE_SIZE_LABEL: Record<InterfaceSize, { label: string; hint: string }> = {
  compact: { label: "Compact", hint: "Tighter spacing, more on screen. Phones keep full-size touch targets." },
  comfortable: { label: "Comfortable", hint: "The standard size." },
  large: { label: "Large", hint: "Roomier controls and spacing." },
};
export const TEXT_SIZES = ["small", "default", "large", "xlarge"] as const;
export type TextSize = (typeof TEXT_SIZES)[number];
export const DEFAULT_TEXT_SIZE: TextSize = "default";
export const TEXT_SIZE_LABEL: Record<TextSize, { label: string; hint: string }> = {
  small: { label: "Small", hint: "A little smaller than standard." },
  default: { label: "Default", hint: "The standard text size." },
  large: { label: "Large", hint: "Easier to read." },
  xlarge: { label: "Extra large", hint: "The largest, for the easiest reading." },
};
/** A person's saved display preferences (users.interface_size / users.text_size); null = never chosen = the standard. */
export interface DisplayPreferences {
  interfaceSize: InterfaceSize;
  textSize: TextSize;
}

export interface SessionUser {
  /** The hospital's interface style (tenants.surface_style); hospitals that never chose one read as Balanced. */
  surfaceStyle?: SurfaceStyle;
  /** THIS person's interface size (users.interface_size): personal, not the hospital's. Never chosen reads as Comfortable. */
  interfaceSize?: InterfaceSize;
  /** THIS person's text size (users.text_size): personal, independent of the interface size. Never chosen reads as Default. */
  textSize?: TextSize;
  id: string;
  tenantId: string;
  /** The hospital's name (tenants.name). */
  tenantName?: string;
  /** The hospital's own sign-in page (/login/<slug>), when it has one - where signing out returns to. */
  loginSlug?: string | null;
  name: string;
  email: string;
  role: Role;
  branchId: string | null;
  branchName: string | null;
  /** Hospital IANA timezone (tenants.timezone) — every "today" and day boundary uses it. */
  timezone: string;
  /** The tenant's edition (tenants.edition) — gates growth capabilities server-side. */
  edition: Edition;
  /** What this tenant can actually do: the edition's defaults with the tenant's own overrides applied. */
  capabilities: CapabilityMap;
}

export interface Branch {
  id: string;
  name: string;
  city: string;
}

// ---------------------------------------------------------------------------
// Permissions — the single source of truth for what each role may do.
// Enforced server-side (Fastify preHandler); the UI uses the same map only to
// avoid showing dead navigation, never as the actual authorization boundary.
// ---------------------------------------------------------------------------

export type Permission =
  | "VIEW_ADMIN_COMMAND_CENTRE"
  | "VIEW_DOCTOR_COMMAND_CENTRE"
  | "VIEW_PATIENTS"
  | "EDIT_PATIENTS"
  | "VIEW_JOURNEYS"
  | "MANAGE_JOURNEYS"
  | "VIEW_APPOINTMENTS"
  | "MANAGE_APPOINTMENTS"
  | "RECORD_CONSULTATION_OUTCOME"
  /** Finish the consultation of a visit that is with THIS doctor (everyone else completes visits through MANAGE_APPOINTMENTS). */
  | "COMPLETE_CONSULTATION"
  | "VIEW_TREATMENT"
  | "MANAGE_TREATMENT"
  | "VIEW_REVENUE"
  | "VIEW_MARKETING"
  | "VIEW_INBOX"
  | "MANAGE_INBOX"
  | "VIEW_TASKS"
  | "MANAGE_TASKS"
  | "VIEW_INTEGRATIONS"
  | "MANAGE_INTEGRATION_CONFIG"
  | "MANAGE_INTEGRATION_SECRETS"
  | "VIEW_CALL_RECORDING"
  | "DOWNLOAD_CALL_RECORDING"
  | "VIEW_CALL_TRANSCRIPT"
  | "LOG_CALL"
  | "VIEW_COMMUNICATION_ENDPOINTS"
  | "MANAGE_LEADS"
  | "MANAGE_SPECIALTIES"
  /** Download report / row-level Excel workbooks (patient names and phones leave the system). */
  | "EXPORT_REPORTS";

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  SUPER_ADMIN: [
    "VIEW_ADMIN_COMMAND_CENTRE", "VIEW_PATIENTS", "EDIT_PATIENTS", "VIEW_JOURNEYS", "MANAGE_JOURNEYS",
    "VIEW_APPOINTMENTS", "MANAGE_APPOINTMENTS", "RECORD_CONSULTATION_OUTCOME", "VIEW_TREATMENT", "MANAGE_TREATMENT",
    "VIEW_REVENUE", "VIEW_MARKETING", "VIEW_INBOX", "MANAGE_INBOX", "VIEW_TASKS", "MANAGE_TASKS",
    "VIEW_INTEGRATIONS", "MANAGE_INTEGRATION_CONFIG", "MANAGE_INTEGRATION_SECRETS", "VIEW_CALL_RECORDING", "DOWNLOAD_CALL_RECORDING", "VIEW_CALL_TRANSCRIPT", "LOG_CALL", "VIEW_COMMUNICATION_ENDPOINTS", "MANAGE_LEADS", "MANAGE_SPECIALTIES", "EXPORT_REPORTS",
  ],
  HOSPITAL_ADMIN: [
    "VIEW_ADMIN_COMMAND_CENTRE", "VIEW_PATIENTS", "EDIT_PATIENTS", "VIEW_JOURNEYS", "MANAGE_JOURNEYS",
    "VIEW_APPOINTMENTS", "MANAGE_APPOINTMENTS", "VIEW_TREATMENT", "MANAGE_TREATMENT",
    "VIEW_REVENUE", "VIEW_MARKETING", "VIEW_INBOX", "MANAGE_INBOX", "VIEW_TASKS", "MANAGE_TASKS",
    "VIEW_INTEGRATIONS", "MANAGE_INTEGRATION_CONFIG", "VIEW_CALL_RECORDING", "DOWNLOAD_CALL_RECORDING", "VIEW_CALL_TRANSCRIPT", "LOG_CALL", "VIEW_COMMUNICATION_ENDPOINTS", "MANAGE_LEADS", "MANAGE_SPECIALTIES", "EXPORT_REPORTS",
  ],
  FRONT_DESK: [
    "VIEW_PATIENTS", "EDIT_PATIENTS", "VIEW_JOURNEYS", "VIEW_APPOINTMENTS", "MANAGE_APPOINTMENTS",
    "VIEW_INBOX", "MANAGE_INBOX", "VIEW_TASKS", "MANAGE_TASKS", "LOG_CALL", "VIEW_COMMUNICATION_ENDPOINTS", "MANAGE_LEADS",
  ],
  PATIENT_COORDINATOR: [
    "VIEW_PATIENTS", "EDIT_PATIENTS", "VIEW_JOURNEYS", "MANAGE_JOURNEYS", "VIEW_APPOINTMENTS", "MANAGE_APPOINTMENTS",
    "VIEW_TREATMENT", "MANAGE_TREATMENT", "VIEW_REVENUE", "VIEW_INBOX", "MANAGE_INBOX", "VIEW_TASKS", "MANAGE_TASKS", "LOG_CALL", "VIEW_COMMUNICATION_ENDPOINTS", "MANAGE_LEADS",
  ],
  DOCTOR: [
    "VIEW_DOCTOR_COMMAND_CENTRE", "VIEW_PATIENTS", "VIEW_JOURNEYS", "VIEW_APPOINTMENTS",
    "RECORD_CONSULTATION_OUTCOME", "COMPLETE_CONSULTATION", "VIEW_TREATMENT", "VIEW_TASKS",
  ],
};

export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export interface TodayStrip {
  newEnquiries: number;
  appointmentsToday: number;
  waitingNow: number;
  consultationsCompleted: number;
  treatmentDecisionsPending: number;
  /** null when the hospital has revenue tracking off - never a fake 0. */
  attributedRevenue: number | null;
}

export type JourneyHealthKey = "contacted" | "booked" | "attended" | "consulted" | "treatment_advised";

export interface JourneyHealthSegment {
  key: JourneyHealthKey;
  label: string;
  count: number;
  pct: number;
}

/** The hospital-timezone period a Command Centre widget was computed for. Absent when no period was requested (all time). */
export interface DashboardPeriod {
  preset: AnalyticsRangePreset;
  /** Inclusive first / last local day, YYYY-MM-DD, in `timezone`. */
  from: string;
  to: string;
  days: number;
  timezone: string;
  today: string;
}

export interface JourneyHealth {
  segments: JourneyHealthSegment[];
  totalJourneys: number;
  overallPct: number;
  period?: DashboardPeriod | null;
}

export type ConversionStageKey =
  | "enquiry"
  | "contacted"
  | "booked"
  | "attended"
  | "consulted"
  | "treatment_advised"
  | "scheduled"
  | "completed";

export interface ConversionStage {
  key: ConversionStageKey;
  label: string;
  count: number;
  /** total attributed campaign spend / count, only computed for stages where it's meaningful; null elsewhere or on zero count */
  costPerOutcome: number | null;
}

export type PatientFlowBucket = "confirmed" | "checked_in" | "waiting" | "with_doctor" | "completed";

export interface PatientFlowCount {
  bucket: PatientFlowBucket;
  count: number;
}

export type AttentionReason =
  | "overdue_callback"
  | "missed_follow_up"
  | "no_show"
  | "high_intent_uncontacted"
  | "treatment_decision_pending";

export interface AttentionItem {
  /** The task id — not a patient id. Link through patientId/journeyId. */
  id: string;
  patientId: string;
  journeyId: string | null;
  patientName: string;
  journeyType: string;
  reason: AttentionReason;
  dueAt: string;
  ownerName: string | null;
}

export type SourceChannel = "meta" | "google" | "website" | "whatsapp" | "phone" | "walk_in" | "referral" | "organic" | "other";

export interface SourcePerformanceRow {
  campaignId: string | null;
  campaignName: string;
  source: SourceChannel;
  spend: number;
  enquiries: number;
  appointments: number;
  consultations: number;
  treatments: number;
  revenue: number;
  roas: number | null;
  // A synced campaign's spend/performance numbers are only as real as the
  // connector that produced them — null for a manually-created campaign
  // that was never synced from a provider (the question doesn't apply).
  connectorMode: ConnectorMode | null;
}

export interface ExecutiveStrip {
  marketingSpend: number;
  enquiries: number;
  consultations: number;
  treatmentsCompleted: number;
  attributedRevenue: number;
  roas: number | null;
  spendAtRisk: number;
  period?: DashboardPeriod | null;
}

export type SpendAtRiskCategoryKey =
  | "uncontacted"
  | "overdue_follow_up"
  | "no_show_recovery"
  | "treatment_decision_pending"
  | "post_consultation_follow_up_overdue";

export interface SpendAtRiskCategory {
  key: SpendAtRiskCategoryKey;
  label: string;
  journeyCount: number;
  allocatedSpend: number;
  oldestAgeDays: number;
}

export interface SpendAtRiskSummary {
  total: number;
  categories: SpendAtRiskCategory[];
}

// MarketingSourceRow is the flatter, non-campaign-scoped sibling of
// SourcePerformanceRow used by the Command Centre's Source Performance
// table; SpendAtRisk/SpendAtRiskReasonRow is the reason-bucketed sibling
// of SpendAtRiskSummary/SpendAtRiskCategory used by that same dashboard.
// Both pairs are kept — Group Q reconciles which one each surface uses.
export interface MarketingSourceRow {
  source: SourceChannel;
  volume: number;
  appointments: number;
  consultations: number;
  treatmentConversion: number;
  revenue: number;
  spend: number;
  roas: number | null;
}

export interface SpendAtRiskReasonRow {
  reason: AttentionReason;
  count: number;
  estimatedValue: number;
}

export interface SpendAtRisk {
  totalAtRisk: number;
  byReason: SpendAtRiskReasonRow[];
}

export interface TeamWorkloadRow {
  userId: string;
  name: string;
  role: Role;
  openTasks: number;
  overdueTasks: number;
}

export interface BranchDoctorRow {
  id: string;
  name: string;
  kind: "branch" | "doctor";
  appointments: number;
  waitingLoad: number;
  consultations: number;
}

/** One service line (journey type) — journeys, pipeline and revenue together. */
export interface ServiceMixRow {
  service: string;
  journeys: number;
  /** Not yet completed or lost. */
  activeJourneys: number;
  /** Advised, decision pending, accepted or scheduled. */
  treatmentsInPipeline: number;
  treatmentsCompleted: number;
  /** null when the hospital has revenue tracking off. */
  revenue: number | null;
}

export interface DoctorNextPatient {
  appointmentId: string;
  patientName: string;
  journeyType: string;
  appointmentTime: string;
  reason: string | null;
  /** For Patient 360 / Journey links. Always set by GET /dashboard/doctor. */
  patientId?: string;
  journeyId?: string;
}

export type AppointmentStatus =
  | "requested"
  | "scheduled" // DB-level synonym for BOOKED
  | "confirmed"
  | "checked_in"
  | "waiting"
  | "with_doctor"
  | "completed"
  | "no_show"
  | "cancelled";

export interface DoctorTodayItem {
  appointmentId: string;
  patientName: string;
  time: string;
  status: AppointmentStatus;
  /** Always set by GET /dashboard/doctor; optional so hand-built fixtures stay valid. */
  patientId?: string;
  journeyId?: string;
  /** Service line of the appointment's journey (e.g. "Laser Vision Correction"). */
  journeyType?: string;
  /** Journey specialty key — matches TreatmentDefinitionVm.specialtyKey, so a row can be offered only its own service's catalog procedures. */
  specialtyKey?: string | null;
}

export interface DoctorRecentPatient {
  appointmentId: string;
  patientName: string;
  /** For Patient 360 links. Always set by GET /dashboard/doctor. */
  patientId?: string;
  journeyType: string;
  time: string;
}

export interface DoctorDashboard {
  /** The hospital day the schedule is for (YYYY-MM-DD). Today unless another day was asked for. */
  date: string;
  /** Visits on that day (named todayCount for history; it is the selected day's count). */
  todayCount: number;
  checkedInCount: number;
  waitingNow: number;
  withMeCount: number;
  completionPct: number;
  nextPatient: DoctorNextPatient | null;
  today: DoctorTodayItem[];
  awaitingOutcome: DoctorTodayItem[];
  treatmentFollowUps: DoctorTodayItem[];
  postCare: DoctorTodayItem[];
  recentPatients: DoctorRecentPatient[];
}

export type ConsultationOutcomeValue =
  | "CONSULTED"
  | "TREATMENT_ADVISED"
  | "NO_TREATMENT_REQUIRED"
  | "DECISION_PENDING"
  | "FOLLOW_UP_REQUIRED"
  | "REFERRED"
  | "OTHER"
  | "TREATMENT_DECLINED";

export interface RecordOutcomeInput {
  appointmentId: string;
  outcome: ConsultationOutcomeValue;
  notes?: string;
  /** Free-text fallback; ignored (replaced by the catalog label) when treatmentDefinitionId is sent. */
  treatmentLabel?: string;
  /** Catalog procedure (must be an active entry of the caller's tenant, else 422 invalid_treatment_definition). */
  treatmentDefinitionId?: string;
  estimatedValue?: number;
}

export type JourneyStage = ConversionStageKey | "lost";

/** The canonical journey stages, in lifecycle order. PulseOS-owned: no hospital renames, removes or reorders them. */
export const JOURNEY_STAGES: readonly JourneyStage[] = ["enquiry", "contacted", "booked", "attended", "consulted", "treatment_advised", "scheduled", "completed", "lost"];

export interface PatientListRow {
  id: string;
  name: string;
  phone: string;
  branchName: string | null;
  activeJourneyCount: number;
  currentJourneyType: string | null;
  currentStage: JourneyStage | null;
  source: SourceChannel | null;
  lastInteractionAt: string | null;
  nextActionDueAt: string | null;
  ownerName: string | null;
  appointmentStatus: string | null;
}

// Deliberately minimal — the global-search typeahead's own lightweight query,
// not a reuse of PatientListRow (which joins journeys/tasks/timeline tenant-wide
// for the Patients table and would be a full-directory fetch on every keystroke).
export interface PatientSearchRow {
  id: string;
  name: string;
  phone: string;
  currentJourneyType: string | null;
  currentStage: JourneyStage | null;
}

export interface JourneyCustomFieldVm {
  label: string;
  value: string;
  /** Field definition key and group, so pages can render values in the configured groups. */
  fieldKey?: string;
  groupKey?: FieldGroupKey;
}

export interface JourneyCardVm {
  id: string;
  journeyType: string;
  stage: JourneyStage;
  /** Where the patient is right now (derived, never stored); null before any visit. */
  operationalStatus: OperationalStatusKey | null;
  source: SourceChannel;
  ownerName: string | null;
  nextActionDueAt: string | null;
  appointmentTime: string | null;
  appointmentStatus: string | null;
  doctorName: string | null;
  treatmentStatus: string | null;
  treatmentLabel: string | null;
  lastInteractionAt: string | null;
  /** Specialty custom field values captured for this journey (e.g. "Eye
   * Concern: Cataract" for Ophthalmology) — includes values whose field
   * definition has since been archived, so a historical record is never
   * lost from view just because Settings later retired that field. */
  customFields: JourneyCustomFieldVm[];
}

export type CallDirection = "inbound" | "outbound";
export type CallStatus = "completed" | "missed" | "no_answer" | "busy" | "failed";

// A telephony connector (Runo today) has been writing real call records
// since its webhook was built, but until now nothing ever read them back —
// no API route existed at all. Deliberately a flat read-model, not the
// `calls` table's raw shape: no tenantId/connectorId (irrelevant once
// scoped to a patient), no raw provider metadata (that stays server-side).
export type CallOrigin = "IVR" | "MANUAL";
export type CallIntelStatus = "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED" | "NOT_CONFIGURED";

/**
 * What PulseOS derived from a call's recording — kept apart from the call and from staff feedback. The summary is
 * labelled by how it was made (mode); the transcript text itself is only served through a permission-checked endpoint.
 */
export interface CallIntelligenceVm {
  transcriptStatus: CallIntelStatus;
  /** The transcript exists and the viewer may fetch it (GET /calls/:id/transcript). */
  hasTranscript: boolean;
  transcriptMode: "PROVIDER" | "FIXTURE" | null;
  summaryStatus: CallIntelStatus;
  summary: {
    text: string;
    patientIntent: string | null;
    serviceInterest: string | null;
    questions: string[];
    agreedAction: string | null;
    nextAction: string | null;
    mode: SummaryMode;
    generatedAt: string;
  } | null;
  /** Only ever a short, non-technical reason ("failed after 3 tries"). Provider diagnostics stay server-side. */
  failed: boolean;
}

export interface CallVm {
  id: string;
  journeyId: string | null;
  origin: CallOrigin;
  provider: string;
  connectorMode: ConnectorMode | null;
  direction: CallDirection;
  phone: string;
  status: CallStatus;
  /** Derived from status: the patient and the hospital actually spoke. */
  connected: boolean;
  durationSeconds: number | null;
  /** A recording exists. The provider URL itself is never sent to the browser — GET /calls/:id/recording streams it for permitted roles. */
  hasRecording: boolean;
  disposition: string | null;
  /** IVR: the provider's agent. Manual: the staff member who logged it. */
  agentName: string | null;
  /** HUMAN-authored feedback — never AI text. */
  staffFeedback: string | null;
  staffFeedbackBy: string | null;
  outcomeLabel: string | null;
  callback: { taskId: string; dueAt: string; status: TaskStatus } | null;
  intelligence: CallIntelligenceVm | null;
  startedAt: string | null;
  endedAt: string | null;
  // Best-effort only: Runo's real API never tells you which hospital line a
  // call used (confirmed against their live OpenAPI spec) — this resolves
  // only when the connector has exactly one configured CommunicationEndpoint
  // (an unambiguous default), never guessed among several. Null otherwise.
  endpointLabel: string | null;
}

/** Derived from the Journey's Call records — never stored as counters. */
export interface CallStatsVm {
  total: number;
  incoming: number;
  outgoing: number;
  connected: number;
  /** Missed (incoming) or no answer / busy / failed (outgoing). */
  notConnected: number;
  lastCallAt: string | null;
}

export interface LogCallInput {
  direction: CallDirection;
  connected: boolean;
  /** ISO instant the call happened; defaults to now, never in the future. */
  occurredAt?: string;
  durationSeconds?: number;
  staffFeedback?: string;
  /** A configured CRM outcome key (Settings → Workflow Outcomes). */
  outcomeKey?: string;
  /** Ask for a callback: due ISO instant, optional note and owner (defaults to the Journey owner, else the person logging). */
  callback?: { dueAt: string; note?: string; assignedTo?: string };
  /**
   * Book the visit in the same save (instead of a callback). Doctor and branch may be left out when the hospital has
   * only one of each. `confirmed`: the patient agreed to this slot during the call → the visit is CONFIRMED (and the
   * confirmation + reminder messages are planned); otherwise it is only BOOKED and no message goes out.
   */
  appointment?: LogCallAppointmentInput;
  /** Client-generated id so a double-tapped Save returns the first call. */
  idempotencyKey?: string;
}

export interface LogCallAppointmentInput {
  /** Hospital wall time (no offset) or an ISO instant. */
  scheduledAt: string;
  confirmed?: boolean;
  doctorId?: string;
  branchId?: string;
  reason?: string;
}

export interface LogCallResult {
  callId: string;
  callbackTaskId: string | null;
  /** The visit booked from this call, when one was asked for. */
  appointmentId?: string | null;
  /** "confirmed" only when it was asked for and the confirmation went through; otherwise "scheduled" (booked). */
  appointmentStatus?: "scheduled" | "confirmed" | null;
  /** True when the idempotency key had already been used and the original call is returned. */
  duplicate: boolean;
}

/** Staff feedback / outcome / callback on a call that already exists (e.g. an IVR call). */
export interface CallFeedbackInput {
  staffFeedback?: string;
  outcomeKey?: string;
  callback?: { dueAt: string; note?: string; assignedTo?: string };
}

export interface CallTranscriptVm {
  status: CallIntelStatus;
  mode: "PROVIDER" | "FIXTURE" | null;
  text: string | null;
}

// Previously defined three times (apps/api/src/domain/timeline/timeline.service.ts,
// packages/api-client, packages/ui/src/Timeline.tsx) — genuinely identical
// copies that had already drifted once (relatedEntityType/relatedEntityId
// existed on the DB row and were set by treatment/call event writers, but
// none of the three copies exposed them, so a Timeline event could point at
// its own source row and nothing could ever follow that pointer).
export interface TimelineEventVm {
  id: string;
  eventType: string;
  title: string;
  description: string | null;
  sourceChannel: string | null;
  occurredAt: string;
  category: "communication" | "appointments" | "clinical" | "tasks" | "other";
  relatedEntityType: string | null;
  relatedEntityId: string | null;
  // Which hospital phone/WhatsApp line this communication event happened on
  // — resolved from the same communicationEndpointId already stamped on the
  // related `calls`/`conversations` row (see CallVm.endpointLabel), never a
  // fresh guess. Null whenever that row has no resolved endpoint, or the
  // event isn't a call/conversation at all.
  endpointLabel: string | null;
  /** How this interaction happened (call, WhatsApp, walk-in…). Independent of the patient's original source. */
  channel: InteractionChannel | null;
  /** For a call event: the call itself (IVR and manual alike), trimmed to what the viewer may see. */
  call: CallVm | null;
  /** How the summary on a whatsapp_conversation line was produced (FIXTURE/AI/…); null for every other event. */
  summaryMode: SummaryMode | null;
}

export interface Patient360 {
  patient: {
    id: string;
    name: string;
    /** Whole years: from the date of birth when known, otherwise the age the patient reported. */
    age: number | null;
    dateOfBirth: string | null;
    phone: string;
    preferredLanguage: string;
    branchName: string | null;
  };
  journeys: JourneyCardVm[];
  calls: CallVm[];
  acquisition: {
    source: SourceChannel | null;
    campaignName: string | null;
    firstTouchAt: string | null;
    allocatedAcquisitionCost: number | null;
    /** null when the hospital has revenue tracking off. */
    estimatedTreatmentValue: number | null;
    attributedRevenue: number | null;
    // Full multi-touch context — lastTouch is null when the journey has
    // only ever had the one (first) touch.
    touchpointCount: number;
    lastTouch: { source: SourceChannel | null; campaignName: string | null; occurredAt: string } | null;
  };
}

// --- P2 view additions ---
// Patient 360 "Upcoming": a read-only projection of EXISTING records for one
// patient (no new data concept). Items span every journey the patient has.
export type PatientUpcomingKind = "appointment" | "task" | "treatment";

export interface PatientUpcomingItem {
  kind: PatientUpcomingKind;
  /** The source record's id (appointment / task / treatment opportunity). */
  id: string;
  /** ISO instant: appointment scheduledAt, task dueAt, treatment plannedDate. */
  at: string;
  /** appointment: its reason (may be null); task: its TaskType; treatment: its label. */
  label: string | null;
  /** AppointmentStatus / TaskStatus / TreatmentStatus of the source record. */
  status: string;
  /** Only an open task can be overdue (its due time has passed). */
  overdue: boolean;
  journeyId: string | null;
  journeyType: string | null;
  /** appointment: doctor; task: assignee; treatment: owner. */
  personName: string | null;
}

export interface PatientUpcoming {
  /** Hospital (tenant) IANA timezone the UI must group days in. */
  timezone: string;
  items: PatientUpcomingItem[];
}
// --- end P2 view additions ---

export interface JourneyListRow {
  id: string;
  patientId: string;
  patientName: string;
  journeyType: string;
  source: SourceChannel;
  campaignName: string | null;
  stage: JourneyStage;
  branchName: string | null;
  doctorName: string | null;
  ownerName: string | null;
  lastActivityAt: string;
  nextActionDueAt: string | null;
  acquisitionCost: number | null;
  treatmentValue: number;
}

export interface RevenueEventVm {
  id: string;
  amount: number;
  currency: string;
  type: "consultation_fee" | "treatment_payment" | "other";
  occurredAt: string;
  treatmentOpportunityId: string | null;
}

/**
 * Journey Detail read-model (GET /journeys/:id). Journey-scoped: one Journey
 * of a Patient, never the Patient's whole record (Patient != Journey).
 *
 * Visibility rules (all enforced server-side, see journey.routes.ts):
 *  - `tasks` for a caller WITHOUT MANAGE_TASKS contains only tasks assigned to
 *    that caller (task notes are PHI-adjacent).
 *  - `treatments` is `null` without VIEW_TREATMENT; `revenue` is `null`
 *    without VIEW_REVENUE. `null` means "not permitted", an empty result means
 *    "none exist".
 */
export interface JourneyDetailVm {
  patient: { id: string; name: string; age: number | null; phone: string; branchName: string | null };
  journey: {
    id: string;
    journeyType: string;
    stage: JourneyStage;
    /** Where the patient is right now (derived, never stored); null before any visit. */
    operationalStatus: OperationalStatusKey | null;
    source: SourceChannel;
    sourceLabel: string | null;
    departmentName: string | null;
    campaign: { id: string; name: string } | null;
    owner: { id: string; name: string } | null;
    doctorName: string | null;
    createdAt: string;
    lastInteractionAt: string;
    /** Nearest-due open task on this journey (any assignee); type label + due date only, never notes. */
    nextAction: { dueAt: string; label: string } | null;
    /** The task that IS the Next Action (derived from open tasks — never stored): overdue first, then today, then the earliest upcoming. Null when the viewer may not see tasks or none is open. */
    nextTask: TaskRow | null;
    /** Where nextTask falls today, in the hospital's clock. */
    nextTaskBucket: "overdue" | "today" | "upcoming" | null;
    /** The latest configured outcome logged on this Journey (its sub-status), or null. */
    lastOutcome: { label: string; at: string } | null;
    /** Counts derived from this Journey's Call records. */
    callStats: CallStatsVm;
  };
  customFields: JourneyCustomFieldVm[];
  timeline: TimelineEventVm[];
  tasks: TaskRow[];
  appointments: AppointmentRow[];
  treatments: TreatmentRow[] | null;
  revenue: { total: number; events: RevenueEventVm[] } | null;
}

/** PATCH /journeys/:id/owner — null unassigns. */
export interface AssignJourneyOwnerInput {
  ownerUserId: string | null;
}

/** POST /journeys/owner — 1..100 journeys, all-or-nothing. */
export interface BulkAssignJourneyOwnerInput {
  journeyIds: string[];
  ownerUserId: string | null;
}

export interface BulkAssignJourneyOwnerResult {
  updatedCount: number;
  journeyIds: string[];
  owner: { id: string; name: string } | null;
}

/** `owner` list filter: the session user's own, unowned, or a specific user id. */
export type OwnerFilterValue = "mine" | "unassigned" | (string & {});

export interface JourneysSummary {
  activeJourneys: number;
  appointmentsPending: number;
  consultationsPending: number;
  treatmentDecisionsPending: number;
  revenueOpportunity: number;
  spendAtRisk: number;
}

// ---------------------------------------------------------------------------
// Tasks / Follow-ups / My Work (Group L)
// ---------------------------------------------------------------------------

export type TaskType = "CALLBACK" | "FOLLOW_UP" | "APPOINTMENT_CONFIRMATION" | "NO_SHOW_RECOVERY" | "TREATMENT_DECISION" | "POST_CARE" | "RECALL" | "OTHER";
export type TaskPriority = "normal" | "high";
export type TaskStatus = "pending" | "in_progress" | "completed" | "cancelled";
// "unassigned" is the team-attention surface for system-generated tasks that
// had no journey owner at creation time (assignedTo null) — visible only to
// MANAGE_TASKS roles (task.routes.ts forces a VIEW_TASKS-only caller's
// assignedTo to themselves regardless of view, which combined with this
// view's "assignedTo IS NULL" condition always yields an empty result for
// them, never a tenant-wide unassigned queue).
export type TaskView = "today" | "overdue" | "upcoming" | "completed" | "unassigned" | "appointment_risk";
// Why a task exists — distinct from `type` (what action it is). Written by
// the specific service that creates each kind of task; "manual_task" is the
// DB default for anything created without an explicit reason.
export type TaskReason = "overdue_callback" | "missed_follow_up" | "no_show" | "high_intent_uncontacted" | "treatment_decision_pending" | "manual_task" | "new_lead";

/** Stable keys of the default follow-up types. A tenant may rename or archive them but the key never changes. */
export const FOLLOW_UP_KEYS = { callback: "callback", appointmentFollowUp: "appointment_followup", appointmentRisk: "appointment_risk", general: "general_followup", surgery: "surgery_followup" } as const;

export const TASK_TYPE_LABEL: Record<TaskType, string> = {
  CALLBACK: "Callback",
  FOLLOW_UP: "Follow-up",
  APPOINTMENT_CONFIRMATION: "Appointment confirmation",
  NO_SHOW_RECOVERY: "No-show recovery",
  TREATMENT_DECISION: "Treatment decision",
  POST_CARE: "Post-care",
  RECALL: "Recall",
  OTHER: "Other",
};

export type FollowUpDefaultOwner = "JOURNEY_OWNER" | "ACTOR" | "UNASSIGNED";
export const FOLLOW_UP_OWNER_LABEL: Record<FollowUpDefaultOwner, string> = { JOURNEY_OWNER: "Assigned Team Member", ACTOR: "The person adding it", UNASSIGNED: "Unassigned" };

/** What a follow-up type behaves like to the system. Shown to Admins in plain words, never as an internal name. */
export const FOLLOW_UP_BEHAVIOURS: { key: TaskType; label: string; hint: string }[] = [
  { key: "CALLBACK", label: "A call to make", hint: "Shown as a callback in My Work" },
  { key: "FOLLOW_UP", label: "A general follow-up", hint: "Most follow-ups" },
  { key: "APPOINTMENT_CONFIRMATION", label: "Confirming an appointment", hint: "Counts with appointment confirmations" },
  { key: "POST_CARE", label: "Care after treatment", hint: "Post-care check-ins" },
];

export interface FollowUpTypeVm {
  id: string;
  key: string;
  label: string;
  /** The stable internal Task type this label maps to. */
  canonicalTaskType: TaskType;
  defaultPriority: TaskPriority;
  defaultOwner: FollowUpDefaultOwner;
  requiresNote: boolean;
  isActive: boolean;
  sortOrder: number;
  /** Null = offered for every department. */
  departmentId: string | null;
  departmentName: string | null;
}

export interface CreateFollowUpTypeInput {
  label: string;
  canonicalTaskType?: TaskType;
  defaultPriority?: TaskPriority;
  defaultOwner?: FollowUpDefaultOwner;
  requiresNote?: boolean;
  departmentId?: string | null;
}

export interface UpdateFollowUpTypeInput {
  label?: string;
  canonicalTaskType?: TaskType;
  defaultPriority?: TaskPriority;
  defaultOwner?: FollowUpDefaultOwner;
  requiresNote?: boolean;
  departmentId?: string | null;
  isActive?: boolean;
}

/** Add Follow-up on a Journey: the Task engine, with the tenant's follow-up type. */
export interface CreateFollowUpInput {
  followUpTypeId: string;
  /** ISO instant, in the future. */
  dueAt: string;
  /** Omit for the type's default owner; null = unassigned. */
  assignedTo?: string | null;
  /** Omit for the type's default priority. */
  priority?: TaskPriority;
  note?: string;
}

export interface TaskRow {
  id: string;
  patientId: string;
  patientName: string;
  journeyId: string | null;
  journeyType: string | null;
  /** Acquisition source of the owning Journey (null for a task with no Journey). */
  source?: SourceChannel | null;
  assignedTo: string | null;
  assignedToName: string | null;
  type: TaskType;
  /** The tenant's follow-up type, when the task has one. */
  followUpTypeId: string | null;
  followUpTypeKey: string | null;
  /** What to show: the follow-up type's label (even if archived), else the stable type's label. */
  typeLabel: string;
  priority: TaskPriority;
  status: TaskStatus;
  reason: TaskReason;
  notes: string | null;
  dueAt: string;
  completedAt: string | null;
  createdAt: string;
}

export interface TaskCounts {
  mine: number;
  overdue: number;
  today: number;
  upcoming: number;
  completed: number;
  /** Open Appointment Risk tasks assigned to the caller. */
  appointmentRisk: number;
  // Tenant-wide unassigned actionable tasks — only computed for callers with
  // MANAGE_TASKS (see task.routes.ts); omitted (undefined) for everyone else.
  unassigned?: number;
}

export interface CreateTaskInput {
  patientId: string;
  journeyId?: string;
  assignedTo?: string;
  type: TaskType;
  /** Optional: the hospital's follow-up type (label) for this task. */
  followUpTypeId?: string;
  priority?: TaskPriority;
  notes?: string;
  dueAt: string;
}

// ---------------------------------------------------------------------------
// Appointments / Front Desk (Group M)
// ---------------------------------------------------------------------------

export interface AppointmentRow {
  id: string;
  patientId: string;
  patientName: string;
  journeyId: string;
  branchName: string | null;
  doctorId: string;
  doctorName: string | null;
  status: AppointmentStatus;
  scheduledAt: string;
  reason: string | null;
  /** Real check-in time (the appointment's own checkedInAt). Kept under this name for the Front Desk waiting rows. */
  arrivedAt?: string | null;
  checkedInAt?: string | null;
  waitingStartedAt?: string | null;
  consultationStartedAt?: string | null;
  completedAt?: string | null;
  /** Why the latest reschedule / cancellation / no-show happened; null if none has. */
  statusReason?: { code: AppointmentReasonCode; label: string; note: string | null } | null;
  /** An unresolved Appointment Risk task exists for this appointment. */
  atRisk?: boolean;
  /** The Journey's service line ("Cataract", "Laser Vision Correction"). */
  service?: string | null;
  /** The service's stable key (matches treatment-catalog specialtyKey), when the Journey has one. */
  serviceKey?: string | null;
  branchId?: string;
  /** Who booked it (from the Timeline), when known. */
  bookedBy?: string | null;
}

export type AppointmentAction = "confirm" | "check_in" | "mark_waiting" | "send_to_doctor" | "mark_no_show" | "cancel";

/** Everything a person can do to an appointment: the status-moving actions plus Complete and Reschedule. */
export type AppointmentOp = AppointmentAction | "complete" | "reschedule";

/**
 * THE appointment transition graph: what may be done from each status. The API enforces exactly this table and the
 * UI offers exactly these operations, so a button is only ever shown for a step the server will accept.
 */
export const APPOINTMENT_TRANSITIONS: Record<AppointmentStatus, AppointmentOp[]> = {
  requested: ["confirm", "mark_no_show", "cancel", "reschedule"],
  scheduled: ["check_in", "confirm", "mark_no_show", "cancel", "reschedule"],
  confirmed: ["check_in", "mark_no_show", "cancel", "reschedule"],
  checked_in: ["mark_waiting", "cancel"],
  waiting: ["send_to_doctor", "cancel"],
  with_doctor: ["complete"],
  completed: [],
  no_show: ["reschedule"],
  cancelled: ["reschedule"],
};

export function allowedAppointmentOps(status: AppointmentStatus): AppointmentOp[] {
  return APPOINTMENT_TRANSITIONS[status];
}

/** The one obvious next step for Staff at each status, in plain words. */
export const APPOINTMENT_PRIMARY_OP: Partial<Record<AppointmentStatus, { op: AppointmentOp; label: string }>> = {
  requested: { op: "confirm", label: "Confirm appointment" },
  scheduled: { op: "check_in", label: "Check in" },
  confirmed: { op: "check_in", label: "Check in" },
  checked_in: { op: "mark_waiting", label: "Move to waiting" },
  waiting: { op: "send_to_doctor", label: "Send to doctor" },
  with_doctor: { op: "complete", label: "Consultation done" },
};

/** Why an appointment was rescheduled, cancelled or missed. A stable code (tenant customisation comes later) + optional note. */
export type AppointmentReasonCode =
  | "patient_requested" | "doctor_unavailable" | "hospital_reschedule" | "hospital_cancelled" | "timing_conflict" | "unable_to_reach" | "patient_no_show" | "other";
export type AppointmentReasonKind = "reschedule" | "cancel" | "no_show";
export interface AppointmentReasonDef {
  code: AppointmentReasonCode;
  label: string;
  /** The hospital caused it, so the patient has to be contacted: raises an Appointment Risk task. */
  hospitalAction: boolean;
  appliesTo: AppointmentReasonKind[];
}
export const APPOINTMENT_REASONS: AppointmentReasonDef[] = [
  { code: "patient_requested", label: "Patient requested", hospitalAction: false, appliesTo: ["reschedule", "cancel"] },
  { code: "doctor_unavailable", label: "Doctor unavailable", hospitalAction: true, appliesTo: ["reschedule", "cancel"] },
  { code: "hospital_reschedule", label: "Hospital reschedule", hospitalAction: true, appliesTo: ["reschedule"] },
  { code: "hospital_cancelled", label: "Hospital cancelled", hospitalAction: true, appliesTo: ["cancel"] },
  { code: "timing_conflict", label: "Timing conflict", hospitalAction: false, appliesTo: ["reschedule", "cancel"] },
  { code: "unable_to_reach", label: "Unable to reach patient", hospitalAction: false, appliesTo: ["cancel", "no_show"] },
  { code: "patient_no_show", label: "Patient did not arrive", hospitalAction: false, appliesTo: ["no_show"] },
  { code: "other", label: "Other", hospitalAction: false, appliesTo: ["reschedule", "cancel", "no_show"] },
];
export function appointmentReasonsFor(kind: AppointmentReasonKind): AppointmentReasonDef[] {
  return APPOINTMENT_REASONS.filter((r) => r.appliesTo.includes(kind));
}

/** PATCH /appointments/:id/action body. Cancel needs a reason; a no-show defaults to "Patient did not arrive". */
export interface AppointmentActionInput {
  action: AppointmentAction;
  /**
   * With "check_in": check the patient in AND put them in the waiting queue as one step (the arrival time and the waiting start
   * are the same instant). What staff mean by "Check in" - there is no second "move to waiting" click. Ignored for other actions.
   */
  queue?: boolean;
  reasonCode?: AppointmentReasonCode;
  note?: string;
}

/** PATCH /appointments/:id/reschedule body. */
export interface RescheduleAppointmentInput {
  scheduledAt: string;
  reasonCode: AppointmentReasonCode;
  note?: string;
}

/** Schedule a procedure for a Journey (operational scheduling only — no clinical fields). */
export interface ScheduleSurgeryInput {
  treatmentDefinitionId: string;
  scheduledAt: string;
  resourceId: string;
  branchId: string;
  note?: string;
}

/** What happens after a consultation. Exactly one; "none" leaves the Journey as it is. */
export type CompletionNext =
  | { kind: "none" }
  | { kind: "follow_up"; followUp: CreateFollowUpInput }
  | { kind: "surgery"; surgery: ScheduleSurgeryInput };

/** PATCH /appointments/:id/complete body — everything optional, so a bare call still just completes the visit. */
export interface CompleteAppointmentInput {
  next?: CompletionNext;
  note?: string;
}

export interface AppointmentActionResult {
  ok: true;
  status: AppointmentStatus;
  /** True when the appointment was already in the requested state (a repeated click): nothing was written again. */
  alreadyApplied?: boolean;
}

export interface CompleteAppointmentResult {
  ok: true;
  alreadyApplied?: boolean;
  followUpTaskId?: string | null;
  treatmentId?: string | null;
}

/** A scheduling profile (doctor / theatre team): selectable on appointments and surgeries; a login is optional. */
export interface ScheduleResourceVm {
  id: string;
  name: string;
  departmentId: string | null;
  departmentName: string | null;
  /** True when a PulseOS user is linked, i.e. this doctor can sign in. */
  hasLogin: boolean;
  isActive: boolean;
}
export interface CreateScheduleResourceInput {
  name: string;
  departmentId?: string | null;
}
export interface UpdateScheduleResourceInput {
  name?: string;
  departmentId?: string | null;
  isActive?: boolean;
}

/**
 * Minutes a patient has been waiting, derived from real timestamps (never stored): since they arrived (checked in),
 * which is what the patient experiences — the minute between check-in and "waiting" is still waiting. Null once they
 * are with the doctor, or when no arrival time was recorded.
 */
export function waitMinutes(row: Pick<AppointmentRow, "status" | "checkedInAt" | "arrivedAt" | "waitingStartedAt">, now: Date = new Date()): number | null {
  if (row.status !== "checked_in" && row.status !== "waiting") return null;
  const start = row.checkedInAt ?? row.arrivedAt ?? row.waitingStartedAt;
  if (!start) return null;
  return Math.max(0, Math.floor((now.getTime() - new Date(start).getTime()) / 60_000));
}

export interface CreatePatientInput {
  name?: string;
  phone: string;
  email?: string;
  preferredLanguage?: string;
  branchId: string;
}

export interface CreatePatientResult {
  patientId: string;
  isNewPatient: boolean;
}

export interface CreateAppointmentInput {
  patientId: string;
  journeyId: string;
  branchId: string;
  doctorId: string;
  scheduledAt: string;
  reason?: string;
}

export interface FrontDeskDashboard {
  /** The hospital day these rows are for (YYYY-MM-DD). Today unless another day was asked for. */
  date: string;
  /** Today's appointments with an unresolved Appointment Risk task. */
  atRisk?: AppointmentRow[];
  today: AppointmentRow[];
  arrivals: AppointmentRow[];
  waitingQueue: AppointmentRow[];
  noShows: AppointmentRow[];
  pendingConfirmations: AppointmentRow[];
}

// --- P1 view additions ---
/** GET /appointments/calendar-context: the hospital's IANA zone and its current local day (YYYY-MM-DD). */
export interface AppointmentCalendarContext {
  timezone: string;
  today: string;
}

/** GET /appointments filters incl. the inclusive local-day range (tenant timezone) the calendar views use. */
export interface AppointmentRangeFilters {
  branchId?: string;
  doctorId?: string;
  status?: AppointmentStatus;
  date?: string;
  from?: string;
  to?: string;
}
// --- end P1 view additions ---

// ---------------------------------------------------------------------------
// Treatment (Group N)
// ---------------------------------------------------------------------------

export type TreatmentStatus = "ADVISED" | "DECISION_PENDING" | "ACCEPTED" | "SCHEDULED" | "COMPLETED" | "DECLINED" | "CANCELLED" | "LOST";

export interface TreatmentRow {
  id: string;
  patientId: string;
  patientName: string;
  journeyId: string;
  doctorName: string | null;
  treatmentLabel: string;
  /** Service line of the treatment's journey (journey type, e.g. "Laser Vision Correction"). Always set by GET /treatments. */
  service?: string | null;
  /** Catalog procedure this treatment is an instance of; null for free-text/legacy rows. Always set by GET /treatments. */
  treatmentDefinitionId?: string | null;
  estimatedValue: number;
  status: TreatmentStatus;
  ownerName: string | null;
  nextActionDueAt: string | null;
  lastContactAt: string | null;
  /** When the procedure is SCHEDULED for ("Scheduled for"). Null on a legacy row with no date recorded. */
  plannedDate: string | null;
  /** When it was COMPLETED ("Completed on"), stamped by the transition. Null on rows completed before it was recorded — never inferred. */
  completedAt?: string | null;
  /** Scheduled procedure: who it is with, where, and the operational note (set once it is SCHEDULED). */
  resourceId?: string | null;
  resourceName?: string | null;
  branchId?: string | null;
  branchName?: string | null;
  scheduleNote?: string | null;
}

/** GET /treatments query. service = journey type; doctorId = doctor of the journey's latest appointment. */
export interface TreatmentFilters {
  status?: TreatmentStatus;
  ownerId?: string;
  doctorId?: string;
  service?: string;
  treatmentDefinitionId?: string;
  /** Which treatment date the range is about: the day it is scheduled for, or the day it was completed. Never payment date. */
  dateField?: TreatmentDateField;
  /** Hospital days (YYYY-MM-DD, inclusive); both or neither, and only with `dateField`. */
  from?: string;
  to?: string;
}

export type TreatmentDateField = "scheduled" | "completed";

/** One procedure in the tenant's treatment catalog (GET /treatment-catalog — active entries only). */
export interface TreatmentDefinitionVm {
  id: string;
  specialtyKey: string;
  key: string;
  label: string;
  /** Demo/price-list hint used when an outcome doesn't state a value; null = no default. */
  defaultEstimatedValue: number | null;
  sortOrder: number;
}

// ---------------------------------------------------------------------------
// Inbox (Group P)
// ---------------------------------------------------------------------------

export type ConversationChannel = "WHATSAPP" | "CALL" | "SMS" | "EMAIL" | "INTERNAL";
export type OwnershipState = "AI_ACTIVE" | "HUMAN_REQUIRED" | "HUMAN_ASSIGNED" | "HUMAN_ACTIVE" | "AI_RESUME_PENDING" | "CLOSED";

// Configuration/scheduling preference only — PulseOS has no agent runtime yet
// to act on "ai_when_available" or "ai_scheduled". This records what a human
// has asked for, honestly labeled as config, never as something executing.
export type ConversationAutomationMode = "manual" | "ai_when_available" | "ai_scheduled";

export interface ConversationAutomationPreference {
  mode: ConversationAutomationMode;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  timezone: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
}

export interface ConversationRow {
  id: string;
  patientId: string;
  patientName: string;
  channel: ConversationChannel;
  lastMessage: string | null;
  lastMessageAt: string;
  unreadCount: number;
  ownerName: string | null;
  ownershipState: OwnershipState;
  // Which hospital WhatsApp number this thread came in on — resolved from the
  // real per-message `metadata.phone_number_id` Meta sends (see
  // CommunicationEndpointVm) — null when unresolved (no matching endpoint
  // configured yet) or for non-WhatsApp channels.
  endpointLabel: string | null;
}

export interface MessageRow {
  id: string;
  senderType: "patient" | "staff" | "ai" | "system";
  senderName: string | null;
  body: string;
  sentAt: string;
}

// ---------------------------------------------------------------------------
// Conversation sessions and summaries. A session ends after an idle window; each session gets one derived
// summary (raw messages stay authoritative and are never deleted). Summaries are patient-scoped.
// ---------------------------------------------------------------------------

export type SummaryMode = "AI" | "PROVIDER" | "FIXTURE" | "MANUAL";

export interface ConversationSummaryVm {
  id: string;
  conversationId: string;
  patientId: string;
  journeyId: string | null;
  /** 1-based session number inside the conversation. */
  segmentNo: number;
  messageCount: number;
  firstMessageAt: string;
  lastMessageAt: string;
  summary: string;
  patientIntent: string | null;
  serviceInterest: string | null;
  questions: string[];
  outcome: string | null;
  promisedAction: string | null;
  nextAction: string | null;
  generatedAt: string;
  /** Which summarizer produced it (e.g. "fixture", "anthropic"). */
  provider: string;
  /** AI = a language model; FIXTURE = deterministic stand-in (never presented as AI); PROVIDER / MANUAL for other sources. */
  mode: SummaryMode;
}

export interface ConversationSummaryState {
  latest: ConversationSummaryVm | null;
  /** How many sessions have a summary. */
  segments: number;
  /** New messages are waiting for the idle window to pass (or a summary is being written). */
  pending: boolean;
  /** When the pending summary becomes due. */
  dueAt: string | null;
  /** Summarizing kept failing; the raw thread is unaffected. */
  failed: boolean;
  /** Messages not yet covered by any summary. */
  unsummarizedCount: number;
}

export const CONVERSATION_IDLE_RANGE = { min: 5, max: 10, default: 7 } as const;
export interface ConversationSettings {
  idleMinutes: number;
}

export interface ConversationDetail {
  conversation: ConversationRow;
  messages: MessageRow[];
  summary: ConversationSummaryState;
  /** Last patient message + 24h: free-form replies are only allowed inside this window. Null if the patient has not written yet. */
  serviceWindowExpiresAt: string | null;
  patientContext: {
    patientId: string;
    journeyType: string | null;
    stage: JourneyStage | null;
    ownerName: string | null;
    appointmentTime: string | null;
    lastInteractionAt: string | null;
    nextActionDueAt: string | null;
  } | null;
}

// ---------------------------------------------------------------------------
// Lookups (filter dropdown data)
// ---------------------------------------------------------------------------

export interface LookupOption {
  id: string;
  name: string;
}

export interface CampaignOption {
  id: string;
  name: string;
  source: SourceChannel;
}

/** Weekly clinic hours in the hospital's own timezone: "HH:MM" open (inclusive) and close (exclusive), or null for a closed day. */
export type ClinicHoursDay = [open: string, close: string] | null;
export interface ClinicHours { mon: ClinicHoursDay; tue: ClinicHoursDay; wed: ClinicHoursDay; thu: ClinicHoursDay; fri: ClinicHoursDay; sat: ClinicHoursDay; sun: ClinicHoursDay }

export interface Lookups {
  /** Null/absent = the hospital has set no hours, so any time is allowed. */
  clinicHours?: ClinicHours | null;
  branches: LookupOption[];
  doctors: LookupOption[];
  owners: LookupOption[];
  campaigns: CampaignOption[];
}

// ---------------------------------------------------------------------------
// Coordinator "My Work" dashboard
// ---------------------------------------------------------------------------

export interface CoordinatorDashboard {
  treatmentDecisionsPending: TreatmentRow[];
  overdueTasks: TaskRow[];
  todayTasks: TaskRow[];
  postCareDue: TaskRow[];
}

// ---------------------------------------------------------------------------
// Connectors (Group R) — provider-neutral integration configuration.
// ---------------------------------------------------------------------------

export type ConnectorType = "MESSAGING" | "TELEPHONY" | "ADS" | "EMAIL" | "STORAGE" | "HIS" | "ACQUISITION";
export type ConnectorStatus = "NOT_CONFIGURED" | "CONNECTING" | "CONNECTED" | "DEGRADED" | "ERROR" | "DISABLED";
// FIXTURE/SANDBOX/LIVE — never inferred, always the connector's actual
// provenance, so the UI can never visually imply a live production
// connection for a connector that is actually fixture- or sandbox-backed.
export type ConnectorMode = "FIXTURE" | "SANDBOX" | "LIVE";
export type ConnectorCapability =
  | "SEND_MESSAGE"
  | "RECEIVE_MESSAGE"
  | "RECEIVE_STATUS"
  | "INITIATE_CALL"
  | "RECEIVE_CALL_EVENT"
  | "FETCH_RECORDING"
  | "RECEIVE_RECORDING"
  | "RECEIVE_TRANSCRIPT"
  | "RECEIVE_LEAD"
  | "SYNC_CAMPAIGNS"
  | "SYNC_AD_GROUPS"
  | "SYNC_ADS"
  | "SYNC_SPEND"
  | "SYNC_PERFORMANCE"
  | "RECEIVE_FORM"
  | "EXPORT_CONVERSION";

export interface ConnectorRow {
  id: string;
  type: ConnectorType;
  provider: string;
  displayName: string;
  status: ConnectorStatus;
  mode: ConnectorMode;
  capabilities: ConnectorCapability[];
  hasSecrets: boolean;
  lastSyncAt: string | null;
  lastEventAt: string | null;
  lastError: string | null;
}

export interface ConnectorEventRow {
  id: string;
  externalEventId: string;
  direction: "inbound" | "outbound";
  status: "received" | "processed" | "failed" | "duplicate";
  error: string | null;
  receivedAt: string;
}

export interface ConnectorDetail {
  connector: ConnectorRow;
  configuration: Record<string, unknown> | null;
  recentEvents: ConnectorEventRow[];
}

export type CommunicationEndpointType = "PHONE" | "WHATSAPP";

// The N-hospital-numbers-per-1-connector layer (a WABA can hold many
// phone_number_ids; a Runo integration can cover several SIM lines) — see
// docs/superpowers/specs/2026-09-22-pulseos-omnichannel-implementation-contract.md
// for the full design. `providerRef` is provider-verified for WhatsApp
// (Meta's own phone_number_id, present on every webhook) but only a
// manual/admin-assigned label for Runo, which never exposes which line a
// call used — never silently treated as provider-confirmed for Runo.
export interface CommunicationEndpointVm {
  id: string;
  connectorId: string;
  connectorProvider: string;
  branchId: string | null;
  branchName: string | null;
  type: CommunicationEndpointType;
  provider: string;
  publicNumber: string;
  providerRef: string;
  displayLabel: string;
  isActive: boolean;
}

export interface CreateCommunicationEndpointInput {
  connectorId: string;
  branchId?: string | null;
  type: CommunicationEndpointType;
  publicNumber: string;
  providerRef: string;
  displayLabel: string;
}

export interface UpdateCommunicationEndpointInput {
  branchId?: string | null;
  displayLabel?: string;
  isActive?: boolean;
}

// ---------------------------------------------------------------------------
// Specialty templates + custom fields (CRM-7/8) — per-tenant configuration
// of specialty enquiry fields, rendered in the Add Lead drawer.
// ---------------------------------------------------------------------------

export type CustomFieldType = "TEXT" | "LONG_TEXT" | "NUMBER" | "PHONE" | "EMAIL" | "DATE" | "DATETIME" | "BOOLEAN" | "SELECT" | "MULTI_SELECT";
export const CUSTOM_FIELD_TYPES: { key: CustomFieldType; label: string }[] = [
  { key: "TEXT", label: "Text" },
  { key: "LONG_TEXT", label: "Long text" },
  { key: "NUMBER", label: "Number" },
  { key: "PHONE", label: "Phone" },
  { key: "EMAIL", label: "Email" },
  { key: "DATE", label: "Date" },
  { key: "DATETIME", label: "Date and time" },
  { key: "BOOLEAN", label: "Yes / No" },
  { key: "SELECT", label: "Single choice" },
  { key: "MULTI_SELECT", label: "Multiple choice" },
];

// CRM field configuration (extends the field system above — one definition, reused everywhere).
export type FieldGroupKey = "patient_information" | "enquiry_details" | "service_details" | "qualification" | "follow_up_details" | "appointment_details" | "treatment_context";
export const FIELD_GROUPS: { key: FieldGroupKey; label: string }[] = [
  { key: "patient_information", label: "Patient Information" },
  { key: "enquiry_details", label: "Enquiry Details" },
  { key: "service_details", label: "Service Details" },
  { key: "qualification", label: "Qualification" },
  { key: "follow_up_details", label: "Follow-up Details" },
  { key: "appointment_details", label: "Appointment Details" },
  { key: "treatment_context", label: "Treatment Context" },
];

export type FieldPlacement = "add_lead" | "journey_detail" | "patient_360" | "followup_outcome" | "appointment" | "treatment";
/**
 * `shown` = a screen actually renders fields placed there today. Appointment / Treatment placements are accepted and
 * stored (the data model is ready) but no screen captures them yet, so the editor must not imply they appear anywhere.
 */
export const FIELD_PLACEMENTS: { key: FieldPlacement; label: string; where: string; shown: boolean }[] = [
  { key: "add_lead", label: "Add Lead", where: "Asked when a new enquiry is added", shown: true },
  { key: "journey_detail", label: "Journey Detail", where: "Shown and editable on the journey", shown: true },
  { key: "patient_360", label: "Patient 360", where: "Shown on the patient's 360 view", shown: true },
  { key: "followup_outcome", label: "Call / follow-up", where: "Asked when staff log a call or a follow-up outcome", shown: true },
  { key: "appointment", label: "Appointment", where: "Not shown on any screen yet", shown: false },
  { key: "treatment", label: "Treatment", where: "Not shown on any screen yet", shown: false },
];
export const DEFAULT_FIELD_PLACEMENTS: FieldPlacement[] = ["add_lead", "journey_detail", "patient_360"];

/** Who may see a field and its values. everyone | front office (admin, front desk, coordinator) | clinical (admin, doctor). */
export type FieldVisibility = "everyone" | "front_office" | "clinical";
export const FIELD_VISIBILITY: { key: FieldVisibility; label: string }[] = [
  { key: "everyone", label: "Everyone" },
  { key: "front_office", label: "Front office and admin" },
  { key: "clinical", label: "Doctors and admin" },
];
/** specialtyKey value meaning "every service". */
export const ALL_SERVICES_KEY = "*";

const FRONT_OFFICE_ROLES: Role[] = ["SUPER_ADMIN", "HOSPITAL_ADMIN", "FRONT_DESK", "PATIENT_COORDINATOR"];
const CLINICAL_ROLES: Role[] = ["SUPER_ADMIN", "HOSPITAL_ADMIN", "DOCTOR"];
/** Server-side and UI use the same rule: may this role see a field (and its values)? */
export function canRoleSeeField(role: Role, visibleTo: FieldVisibility): boolean {
  return visibleTo === "everyone" || (visibleTo === "front_office" ? FRONT_OFFICE_ROLES : CLINICAL_ROLES).includes(role);
}

export interface CustomFieldDefinitionVm {
  id: string;
  specialtyKey: string;
  key: string;
  label: string;
  fieldType: CustomFieldType;
  options: string[] | null;
  required: boolean;
  sortOrder: number;
  archived: boolean;
  groupKey?: FieldGroupKey;
  placements?: FieldPlacement[];
  defaultValue?: unknown;
  visibleTo?: FieldVisibility;
}

export interface SpecialtyTemplateVm {
  key: string;
  displayName: string;
  defaultJourneyType: string;
  /** The department this service belongs to (null for a service made before departments existed). */
  departmentName: string | null;
  enabled: boolean;
  sortOrder: number;
  fieldCount: number;
}

export interface SpecialtyDetailVm extends SpecialtyTemplateVm {
  fields: CustomFieldDefinitionVm[];
}

export interface UpdateSpecialtyInput {
  displayName?: string;
  defaultJourneyType?: string;
  enabled?: boolean;
}

export interface CreateCustomFieldInput {
  key: string;
  label: string;
  fieldType: CustomFieldType;
  options?: string[];
  required?: boolean;
}

// ---------------------------------------------------------------------------
// Configurable outcomes (sub-status / disposition / follow-up reason). The canonical Journey stages are
// NOT tenant-editable: an outcome maps to CONTACTED or LOST and a Journey only ever moves forward.
// ---------------------------------------------------------------------------

export type OutcomeStage = "contacted" | "lost";

export interface CrmOutcomeVm {
  id: string;
  key: string;
  label: string;
  stage: OutcomeStage;
  /** Logging it needs a follow-up date and time, which creates the follow-up Task. */
  requiresFollowUp: boolean;
  /** The logging form offers to book an appointment. */
  allowsAppointment: boolean;
  /** The logging form asks (optionally) why. */
  asksReason: boolean;
  /** Task type of the follow-up this outcome creates. */
  followUpType: TaskType;
  sortOrder: number;
  archived: boolean;
}

export interface CreateCrmOutcomeInput {
  key: string;
  label: string;
  stage: OutcomeStage;
  requiresFollowUp?: boolean;
  allowsAppointment?: boolean;
  asksReason?: boolean;
  followUpType?: TaskType;
}

export interface UpdateCrmOutcomeInput {
  label?: string;
  stage?: OutcomeStage;
  requiresFollowUp?: boolean;
  allowsAppointment?: boolean;
  asksReason?: boolean;
  followUpType?: TaskType;
  archived?: boolean;
}

export interface LogInteractionInput {
  outcomeKey: string;
  note?: string;
  reason?: string;
  /** ISO instant. Required when the outcome requires a follow-up; optional otherwise. */
  followUpAt?: string;
  /** The open Task this outcome closes. */
  taskId?: string;
  /** Values for CRM fields placed on "Follow-up outcome". */
  fieldValues?: Record<string, unknown>;
  /** How this contact happened (phone call, WhatsApp, walk-in…), recorded on the Timeline. */
  channel?: InteractionChannel;
  /**
   * Book the visit in the same save (the outcome must allow appointments). Instead of a follow-up time: a booked visit IS the next
   * step, so no extra follow-up task is created. Confirmed-with-patient confirms it (confirmation + reminder planned).
   */
  appointment?: LogCallAppointmentInput;
}

export interface LogInteractionResult {
  journeyId: string;
  stage: JourneyStage;
  stageChanged: boolean;
  outcome: CrmOutcomeVm;
  followUpTaskId: string | null;
  completedTaskId: string | null;
  /** The visit booked from this save, when one was asked for. */
  appointmentId?: string | null;
  appointmentStatus?: "scheduled" | "confirmed" | null;
}

// ---------------------------------------------------------------------------
// Allocation rules: ordered, first-match assignment of a NEW Journey's owner. Manual assignment always
// wins; a rule only applies when nobody was chosen. A team is a small pool shared round-robin.
// ---------------------------------------------------------------------------

export interface AllocationRuleVm {
  id: string;
  name: string;
  sortOrder: number;
  enabled: boolean;
  /** Each condition is optional; every one given must match. At least one is required. */
  source: SourceChannel | null;
  specialtyKey: string | null;
  journeyType: string | null;
  branchId: string | null;
  pool: { userId: string; name: string }[];
}

export interface CreateAllocationRuleInput {
  name: string;
  source?: SourceChannel | null;
  specialtyKey?: string | null;
  journeyType?: string | null;
  branchId?: string | null;
  userIds: string[];
  enabled?: boolean;
}

export type UpdateAllocationRuleInput = Partial<CreateAllocationRuleInput>;

/** A configurable CRM field definition (what Settings → CRM Fields edits). */
/** SYSTEM: platform-owned and locked. TEMPLATE: installed with a department template, the hospital may customize or archive it. CUSTOM: made by the hospital. */
export type FieldOrigin = "SYSTEM" | "TEMPLATE" | "CUSTOM";
export const FIELD_ORIGIN_LABEL: Record<FieldOrigin, string> = { SYSTEM: "System", TEMPLATE: "Template", CUSTOM: "Custom" };

/**
 * A declarative rule on a field: WHEN a condition holds, SHOW it or REQUIRE it. Conditions are only "the outcome is one of
 * these" or "another field's answer is one of these" — no expressions, no scripts. Used for outcome-driven fields
 * ("Appointment required" → date, time, doctor) and for child fields ("Cataract" → laterality).
 */
export type FieldRuleCondition = { outcome: string[] } | { field: string; equals: string[] };
export interface FieldRule {
  when: FieldRuleCondition;
  then: "show" | "require";
}
export const MAX_FIELD_RULES = 5;

export interface CrmFieldVm extends CustomFieldDefinitionVm {
  origin: FieldOrigin;
  groupKey: FieldGroupKey;
  placements: FieldPlacement[];
  defaultValue: unknown;
  visibleTo: FieldVisibility;
  /** Shown but not editable once it has a value (a value can still be set when the enquiry is created). */
  readOnly: boolean;
  /** Offered as a filter on the Leads list. */
  filterable: boolean;
  /** The next interaction starts with this field's current value filled in (history stays as it was). */
  carryForward: boolean;
  rules: FieldRule[];
}

export interface FieldEvalContext {
  /** The outcome being logged / chosen, when the form has one. */
  outcomeKey?: string | null;
  /** Current answers, by field key. */
  values: Record<string, unknown>;
}

const asList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : v === undefined || v === null || v === "" ? [] : [String(v)]);

function ruleMatches(rule: FieldRule, ctx: FieldEvalContext, answers: Record<string, unknown>): boolean {
  if ("outcome" in rule.when) return !!ctx.outcomeKey && rule.when.outcome.includes(ctx.outcomeKey);
  const given = asList(answers[rule.when.field]);
  return given.some((g) => (rule.when as { equals: string[] }).equals.includes(g));
}

/**
 * Which fields are visible and required for these answers. Pure, shared by the server (what it will accept) and the form
 * (what it shows), so they cannot disagree. A field with any `show` rule is visible only while one of them matches; a
 * `require` rule makes it required while it matches. A hidden field's answer counts as empty for the fields that depend
 * on it (a hidden parent hides its children), so a stale answer cannot keep a child alive.
 */
export function evaluateFieldRules(fields: { key: string; required: boolean; rules?: FieldRule[] }[], ctx: FieldEvalContext): Record<string, { visible: boolean; required: boolean }> {
  const state: Record<string, { visible: boolean; required: boolean }> = {};
  for (const f of fields) state[f.key] = { visible: true, required: f.required };
  // Parents before children: repeat until stable (rules cannot form a cycle, so this ends within fields.length passes).
  for (let pass = 0; pass <= fields.length; pass++) {
    let changed = false;
    const answers: Record<string, unknown> = {};
    for (const f of fields) if (state[f.key]!.visible) answers[f.key] = ctx.values[f.key];
    for (const f of fields) {
      const rules = f.rules ?? [];
      const show = rules.filter((r) => r.then === "show");
      const visible = show.length === 0 || show.some((r) => ruleMatches(r, ctx, answers));
      const required = visible && (f.required || rules.some((r) => r.then === "require" && ruleMatches(r, ctx, answers)));
      if (visible !== state[f.key]!.visible || required !== state[f.key]!.required) {
        state[f.key] = { visible, required };
        changed = true;
      }
    }
    if (!changed) break;
  }
  return state;
}

export interface CreateCrmFieldInput {
  /** A service key, or "*" for every service. */
  specialtyKey: string;
  key: string;
  label: string;
  fieldType: CustomFieldType;
  options?: string[];
  required?: boolean;
  groupKey?: FieldGroupKey;
  placements?: FieldPlacement[];
  defaultValue?: unknown;
  visibleTo?: FieldVisibility;
  readOnly?: boolean;
  filterable?: boolean;
  carryForward?: boolean;
  rules?: FieldRule[];
}

export interface UpdateCrmFieldInput {
  label?: string;
  fieldType?: CustomFieldType;
  options?: string[];
  required?: boolean;
  archived?: boolean;
  groupKey?: FieldGroupKey;
  placements?: FieldPlacement[];
  defaultValue?: unknown;
  visibleTo?: FieldVisibility;
  readOnly?: boolean;
  filterable?: boolean;
  carryForward?: boolean;
  rules?: FieldRule[];
}

export interface UpdateCustomFieldInput {
  label?: string;
  required?: boolean;
  archived?: boolean;
  sortOrder?: number;
  options?: string[];
}

// ---------------------------------------------------------------------------
// Leads (CRM-2/3/4) — Lead is a VIEW over Patient + Journey, not a separate
// identity model. Creating a Lead resolves-or-creates a Patient, then always
// creates a new Journey representing the enquiry.
// ---------------------------------------------------------------------------

export type LeadStatus = "new" | "uncontacted" | "follow_up_due" | "appointment_booked" | "no_response" | "converted" | "lost";

export interface LeadRow {
  id: string; // journey id
  patientId: string;
  patientName: string;
  phone: string;
  specialtyKey: string | null;
  specialtyLabel: string | null;
  source: SourceChannel;
  /** The precise original source (e.g. "Instagram"); `source` is only its coarse analytics bucket. */
  sourceLabel: string;
  campaignName: string | null;
  stage: JourneyStage;
  leadStatus: LeadStatus;
  /** Where the patient is right now (derived, never stored): Appointment booked, Checked in, Waiting, No-show... null before any visit. */
  operationalStatus: OperationalStatusKey | null;
  ownerId: string | null;
  ownerName: string | null;
  priority: TaskPriority;
  lastInteractionAt: string | null;
  nextActionDueAt: string | null;
  createdAt: string;
  /** The enquiry itself: the journey type ("Cataract"), distinct from the service line. */
  journeyType: string;
  /** The latest configured outcome logged on the journey ("Needs callback"), if any. */
  outcomeLabel: string | null;
  /** The earliest open follow-up (from Tasks): what happens next, and when. */
  nextAction: { label: string; dueAt: string; overdue: boolean } | null;
  /** The earliest appointment that has not happened yet (booked / confirmed, or today's), if any. */
  nextAppointment: { id: string; at: string; status: string } | null;
}

export interface LeadsSummary {
  newToday: number;
  uncontacted: number;
  followUpsDue: number;
  appointmentsBooked: number;
  noResponse: number;
  converted: number;
}

export interface LeadPhoneLookupResult {
  patient: { id: string; name: string; phone: string; activeJourneyCount: number } | null;
}

export interface CreateLeadFollowUp {
  type: TaskType;
  dueAt: string;
  assignedTo?: string;
}

export interface CreateLeadInput {
  patientId?: string;
  /** Optional: a caller may not have given a name yet. */
  name?: string;
  /** Exact date of birth (YYYY-MM-DD) and/or the age the patient reported — both optional. */
  dateOfBirth?: string;
  age?: number;
  phone: string;
  email?: string;
  preferredLanguage?: string;
  specialtyKey: string;
  branchId: string;
  doctorId?: string;
  /** Where the patient originally came from: a key from the hospital's lead sources (GET /lead-sources). */
  sourceKey?: string;
  /** Legacy coarse bucket, still accepted when `sourceKey` is absent. */
  source?: SourceChannel;
  /** How this first contact happened (not where the patient came from). */
  channel?: InteractionChannel;
  campaignId?: string;
  journeyType: string;
  ownerId?: string;
  priority?: TaskPriority;
  notes?: string;
  customFieldValues?: Record<string, unknown>;
  /** Legacy: one follow-up task by canonical type. New callers use `nextStep`. */
  followUp?: CreateLeadFollowUp | null;
  /** What the first contact led to (a configured outcome key, e.g. "needs_callback"). Optional. */
  outcomeKey?: string;
  outcomeNote?: string;
  /** Asked only by outcomes that ask a reason (e.g. "Not interested"). */
  outcomeReason?: string;
  /** What happens next. Times are the HOSPITAL's wall time ("YYYY-MM-DDTHH:mm") or an absolute instant. */
  nextStep?: CreateLeadNextStep;
  /** Phone enquiries only: the call itself, recorded by hand through the M4 call log. */
  call?: { direction: "inbound" | "outbound"; connected: boolean; durationSeconds?: number; note?: string };
}

export type CreateLeadNextStep =
  | { kind: "callback" | "follow_up"; dueAt: string; assignedTo?: string; note?: string }
  | { kind: "appointment"; scheduledAt: string; doctorId: string; branchId?: string; note?: string }
  | { kind: "none" };

export interface CreateLeadResult {
  patientId: string;
  journeyId: string;
  isNewPatient: boolean;
  /** The follow-up Task made from `nextStep` (callback / general), if any. */
  followUpTaskId?: string;
  /** The Appointment made from `nextStep`, if any. */
  appointmentId?: string;
  /** The manual Call recorded from `call`, if any. */
  callId?: string;
}

/** The one step of Add Lead that refused the save (nothing was kept), and why. */
export type LeadSaveStep = "outcome" | "follow_up" | "appointment" | "call";

// ---------------------------------------------------------------------------
// Source vs Channel, lead sources, departments
// ---------------------------------------------------------------------------

/** CHANNEL: how one interaction happened. Fixed by the product; never the patient's source. */
export type InteractionChannel = "IVR_CALL" | "MANUAL_CALL" | "WHATSAPP" | "INSTAGRAM_DM" | "FACEBOOK_DM" | "WALK_IN";
export const INTERACTION_CHANNELS: { key: InteractionChannel; label: string; /** staff can record it by hand */ manual: boolean }[] = [
  { key: "IVR_CALL", label: "IVR call", manual: false },
  { key: "MANUAL_CALL", label: "Phone call", manual: true },
  { key: "WHATSAPP", label: "WhatsApp", manual: true },
  { key: "INSTAGRAM_DM", label: "Instagram DM", manual: true },
  { key: "FACEBOOK_DM", label: "Facebook DM", manual: true },
  { key: "WALK_IN", label: "Walk-in", manual: true },
];
export const INTERACTION_CHANNEL_LABEL: Record<InteractionChannel, string> = Object.fromEntries(INTERACTION_CHANNELS.map((c) => [c.key, c.label])) as Record<InteractionChannel, string>;
export const MANUAL_INTERACTION_CHANNELS: InteractionChannel[] = INTERACTION_CHANNELS.filter((c) => c.manual).map((c) => c.key);

/** What every screen shows for a patient whose name has not been given yet. A display label only — never stored, never submitted as a name. */
export const UNKNOWN_PATIENT_NAME = "Unknown patient";

/** SOURCE: where the patient originally came from. A tenant-owned catalogue; `bucket` is its coarse analytics group. */
export interface LeadSourceVm {
  id: string;
  key: string;
  label: string;
  bucket: SourceChannel;
  archived: boolean;
  sortOrder: number;
}
export interface CreateLeadSourceInput {
  label: string;
  bucket?: SourceChannel;
}
export interface UpdateLeadSourceInput {
  label?: string;
  bucket?: SourceChannel;
  archived?: boolean;
  sortOrder?: number;
}

export interface DepartmentVm {
  id: string;
  key: string;
  displayName: string;
  /** The global template it was installed from; null for a hospital-made department. */
  templateKey: string | null;
  archived: boolean;
  sortOrder: number;
  services: { key: string; displayName: string; enabled: boolean }[];
}

export interface DepartmentTemplateVm {
  key: string;
  displayName: string;
  description: string;
  services: string[];
  installed: boolean;
}

export interface UpdateDepartmentInput {
  displayName?: string;
  archived?: boolean;
}

// ---------------------------------------------------------------------------
// Campaigns / Sources + Marketing Efficiency (CRM-9/10)
// ---------------------------------------------------------------------------

export interface CampaignPerformanceRow {
  campaignId: string | null;
  campaignName: string;
  source: SourceChannel;
  specialtyKey: string | null;
  specialtyLabel: string | null;
  spend: number;
  leads: number;
  appointments: number;
  consultations: number;
  treatmentAdvised: number;
  treatmentCompleted: number;
  revenue: number;
  cpl: number | null;
  costPerAppointment: number | null;
  costPerTreatment: number | null;
  roas: number | null;
  // A synced campaign's numbers are only as real as the connector that
  // produced them — null for a manually-created campaign that was never
  // synced from a provider (the question doesn't apply). See SourcePerformanceRow.
  connectorMode: ConnectorMode | null;
}

export interface MarketingEfficiencySummary {
  spend: number;
  leads: number;
  appointments: number;
  consultations: number;
  treatments: number;
  revenue: number;
  roas: number | null;
  cpl: number | null;
  costPerAppointment: number | null;
  costPerTreatment: number | null;
}

export interface CampaignFilters {
  branchId?: string;
  specialtyKey?: string;
  source?: SourceChannel;
  campaignId?: string;
  // Inclusive ISO date range (YYYY-MM-DD), applied to the touchpoint's
  // occurredAt — i.e. "leads attributed to this campaign in this window",
  // not campaign start/end date.
  dateFrom?: string;
  dateTo?: string;
}

// --- P3 view additions ---
export type CampaignRunStatus = "active" | "paused" | "ended";
/**
 * A /campaigns/performance row plus the campaign's run window, so the Campaigns
 * Table, Calendar and Timeline views all render ONE query. `endDate: null` means
 * the campaign is ongoing — an end date is never invented.
 */
export interface CampaignViewRow extends CampaignPerformanceRow {
  campaignId: string;
  /** ISO instant. */
  startDate: string;
  /** ISO instant, or null while the campaign is ongoing. */
  endDate: string | null;
  campaignStatus: CampaignRunStatus;
}
// --- end P3 view additions ---

// ---------------------------------------------------------------------------
// Analytics workspace (/analytics) — historical, comparative, filter-driven.
// One AnalyticsQuery scopes every endpoint so every panel agrees.
// ---------------------------------------------------------------------------

/**
 * The ONE set of date presets every date filter in PulseOS offers (Analytics, Operations report, Leads, Integration logs, Ads).
 * Days are hospital-local calendar days; `today` is passed in, so each boundary is a pure function with no clock.
 */
export const DATE_PRESETS = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "7d", label: "Last 7 days" },
  { key: "9d", label: "Last 9 days" },
  { key: "30d", label: "Last 30 days" },
  { key: "90d", label: "Last 90 days" },
  { key: "this_month", label: "This month" },
  { key: "prev_month", label: "Previous month" },
  { key: "custom", label: "Custom range" },
] as const;
export type DatePreset = (typeof DATE_PRESETS)[number]["key"];
/** Older links/clients may still send these; every API still resolves them. */
export type LegacyDatePreset = "14d" | "last_month";

const dpAdd = (ymd: string, n: number) => new Date(new Date(`${ymd}T00:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);
const dpMonthStart = (ymd: string) => `${ymd.slice(0, 7)}-01`;

/** [from, to] for a non-custom preset, as inclusive hospital-local days ending on (or before) `today`. */
export function resolveDatePreset(preset: Exclude<DatePreset | LegacyDatePreset, "custom">, today: string): { from: string; to: string } {
  switch (preset) {
    case "today": return { from: today, to: today };
    case "yesterday": return { from: dpAdd(today, -1), to: dpAdd(today, -1) };
    case "7d": return { from: dpAdd(today, -6), to: today };
    case "9d": return { from: dpAdd(today, -8), to: today };
    case "14d": return { from: dpAdd(today, -13), to: today };
    case "30d": return { from: dpAdd(today, -29), to: today };
    case "90d": return { from: dpAdd(today, -89), to: today };
    case "this_month": return { from: dpMonthStart(today), to: today };
    case "prev_month":
    case "last_month": {
      const lastOfPrevious = dpAdd(dpMonthStart(today), -1);
      return { from: dpMonthStart(lastOfPrevious), to: lastOfPrevious };
    }
  }
}

export type AnalyticsRangePreset = DatePreset | LegacyDatePreset;

export interface AnalyticsQuery {
  range?: AnalyticsRangePreset;
  /** Inclusive local (hospital-timezone) dates YYYY-MM-DD, used when range = "custom". */
  from?: string;
  to?: string;
  branchId?: string;
  /** Service line = journey type, e.g. "Cataract". */
  service?: string;
  source?: SourceChannel;
  campaignId?: string;
}

export type AnalyticsGranularity = "day" | "week";

export interface AnalyticsPeriod {
  preset: AnalyticsRangePreset;
  /** Inclusive first / last local day, YYYY-MM-DD, in `timezone`. */
  from: string;
  to: string;
  days: number;
  /** The immediately preceding period of the same length. */
  previousFrom: string;
  previousTo: string;
  /** IANA zone every bucket is grouped in (tenants.timezone). */
  timezone: string;
  /** The tenant-local day at request time. A bucket containing it is still in progress. */
  today: string;
  /**
   * When the period ends today, the previous period is counted only up to the same
   * elapsed point (ISO instant: now minus the period length) so a half-finished today
   * is never compared with a full day. Null for a range that is already complete.
   */
  previousUntil: string | null;
}

/** One chart bucket: a local day, or a 7-day block anchored at the period start (last block may be partial). */
export interface AnalyticsBucket {
  /** First local day of the bucket, YYYY-MM-DD. */
  key: string;
  /** Last local day inside both the bucket and the period. */
  to: string;
  days: number;
  partial: boolean;
}

export interface LeadsBucket extends AnalyticsBucket {
  total: number;
  bySource: Partial<Record<SourceChannel, number>>;
  /** Leads in the same-offset bucket of the previous period; null when it has no counterpart. */
  previousTotal: number | null;
}

export interface LeadsBySourceResponse {
  period: AnalyticsPeriod;
  granularity: AnalyticsGranularity;
  /** Only sources that occur in the period, in canonical order. */
  sources: SourceChannel[];
  buckets: LeadsBucket[];
  total: number;
  previousTotal: number;
}

export interface AnalyticsSummary {
  period: AnalyticsPeriod;
  leads: number;
  previousLeads: number;
  /** Leads that reached at least the appointment-booked stage. */
  appointments: number;
  appointmentRate: number | null;
  revenue: number;
  previousRevenue: number;
  /** Campaign spend pro-rated across the period (spend is stored as a campaign total). */
  spend: number;
  /** Revenue from journeys attributed to a campaign. */
  attributedRevenue: number;
  roas: number | null;
  costPerLead: number | null;
  treatmentsCompleted: number;
}

export interface AnalyticsFunnelStage {
  key: ConversionStageKey;
  label: string;
  /** Journeys that reached this stage or beyond (each journey counted once, at its furthest stage). */
  count: number;
  /** count / leads at Enquiry. */
  pctOfLeads: number | null;
  /** count / previous stage's count. */
  conversionFromPrevious: number | null;
  /** previous stage count - this count. */
  dropOff: number;
}

export interface AnalyticsFunnel {
  period: AnalyticsPeriod;
  stages: AnalyticsFunnelStage[];
  /** Journeys currently lost; the stage they were lost from is not stored. */
  lost: number;
}

export interface AnalyticsRatio {
  numerator: number;
  denominator: number;
  rate: number | null;
}

export interface SourceConversionRow {
  source: SourceChannel;
  leads: number;
  toAppointment: AnalyticsRatio;
  toConsultation: AnalyticsRatio;
  toTreatment: AnalyticsRatio;
}

export interface SourceConversionResponse {
  period: AnalyticsPeriod;
  rows: SourceConversionRow[];
}

export interface AnalyticsRevenueBucket extends AnalyticsBucket {
  revenue: number;
  events: number;
}

export interface RevenueBySource {
  source: SourceChannel;
  spend: number;
  attributedRevenue: number;
  roas: number | null;
}

export interface RevenueByService {
  service: string;
  revenue: number;
}

export interface RevenueEventRow {
  id: string;
  journeyId: string;
  /** Local day, YYYY-MM-DD. */
  day: string;
  amount: number;
  type: "consultation_fee" | "treatment_payment" | "other";
  service: string;
  source: SourceChannel;
}

export interface AnalyticsRevenue {
  period: AnalyticsPeriod;
  granularity: AnalyticsGranularity;
  buckets: AnalyticsRevenueBucket[];
  total: number;
  events: number;
  previousTotal: number;
  spend: number;
  attributedRevenue: number;
  roas: number | null;
  bySource: RevenueBySource[];
  byService: RevenueByService[];
  recent: RevenueEventRow[];
}

export interface AnalyticsCampaignRow {
  campaignId: string;
  campaignName: string;
  source: SourceChannel;
  /** Pro-rated across the period. */
  spend: number;
  leads: number;
  appointments: number;
  /** Journeys whose treatment is completed. */
  treatments: number;
  revenue: number;
  roas: number | null;
  costPerLead: number | null;
}

export interface AnalyticsCampaigns {
  period: AnalyticsPeriod;
  rows: AnalyticsCampaignRow[];
  /** Leads / revenue with no campaign attribution (walk-in, referral, organic...). */
  unattributed: { leads: number; revenue: number };
}

export interface AnalyticsServiceRow {
  service: string;
  leads: number;
  appointments: number;
  consultations: number;
  treatmentsAdvised: number;
  treatmentsCompleted: number;
  revenue: number;
  /** Leads per bucket across the period (sparkline). */
  trend: number[];
}

export interface AnalyticsServices {
  period: AnalyticsPeriod;
  granularity: AnalyticsGranularity;
  rows: AnalyticsServiceRow[];
}

export type AnalyticsFlowKind = "source" | "service" | "outcome";

export interface AnalyticsFlowNode {
  id: string;
  label: string;
  kind: AnalyticsFlowKind;
}

export interface AnalyticsFlowLink {
  source: string;
  target: string;
  value: number;
}

export interface AnalyticsFlow {
  period: AnalyticsPeriod;
  nodes: AnalyticsFlowNode[];
  /** source -> service line and service line -> outcome edges; every journey appears once in each layer. */
  links: AnalyticsFlowLink[];
  /** source -> outcome edges (each journey once) — the staged view "where does each source end up?". */
  sourceOutcomes: AnalyticsFlowLink[];
  total: number;
}

export interface AnalyticsTeamRow {
  /** null = journeys with no owner. */
  userId: string | null;
  name: string;
  role: Role | null;
  assignedJourneys: number;
  appointmentsBooked: number;
  conversion: AnalyticsRatio;
  followUpsCompleted: number;
  /** Snapshot at request time, not period-bound. */
  openTasks: number;
  overdueTasks: number;
}

export interface AnalyticsTeam {
  period: AnalyticsPeriod;
  rows: AnalyticsTeamRow[];
}

export interface AnalyticsFilterOptions {
  services: string[];
  sources: SourceChannel[];
  campaigns: { id: string; name: string; source: SourceChannel }[];
}

// ---------------------------------------------------------------------------
// Operations report (Command Centre → Operations) — the hospital's daily loop
// over a hospital-local period: enquiries, contact, follow-ups, appointments,
// procedures, conversion. No spend/ROAS here, so every edition gets it.
// ---------------------------------------------------------------------------

export type ReportRange = DatePreset | LegacyDatePreset;

export const REPORT_RANGES: { key: ReportRange; label: string }[] = DATE_PRESETS.map((p) => ({ key: p.key, label: p.label }));

export interface ReportQuery {
  range?: ReportRange;
  /** Inclusive hospital-local days (YYYY-MM-DD), used when range = "custom". */
  from?: string;
  to?: string;
  /** Patient's branch for enquiries/follow-ups; the visit's branch for appointments; the procedure's branch for procedures. */
  branchId?: string;
  /** Service line = journey type, e.g. "Cataract". */
  service?: string;
  /** The hospital's own lead source (lead_sources.id) — where the patient came from. */
  sourceId?: string;
  /** Journey owner for enquiries; assignee for follow-ups. */
  ownerId?: string;
  /** Doctor / schedule resource — applies to appointments and procedures only. */
  doctorId?: string;
  /** The journey's department (the service line's department). */
  departmentId?: string;
}

export interface ReportPeriod {
  range: ReportRange;
  from: string;
  to: string;
  days: number;
  timezone: string;
  /** Hospital-local today at request time. */
  today: string;
}

export interface OperationsKpis {
  /** Journeys created in the period. */
  newEnquiries: number;
  /** …of which nobody has contacted yet (still at the Enquiry stage). */
  uncontacted: number;
  /** …of which the latest logged outcome is "No answer" and that never got further than Contacted. */
  noResponse: number;
  /** Open follow-ups due inside the period. */
  followUpsDue: number;
  /** Open follow-ups already past due right now (not limited to the period). */
  followUpsOverdue: number;
  /** Follow-ups completed inside the period. */
  followUpsCompleted: number;
  /** Appointments created (booked) inside the period, whenever the visit is. */
  appointmentsBooked: number;
  /** Visits scheduled inside the period. */
  appointmentsScheduled: number;
  /** …that the patient attended (checked in or later). */
  appointmentsAttended: number;
  appointmentsNoShow: number;
  appointmentsCancelled: number;
  /** Procedures with a planned date inside the period (scheduled or done). */
  proceduresScheduled: number;
  /** Procedures completed inside the period, by their recorded completion time (treatment_opportunities.completed_at). */
  proceduresCompleted: number;
  /** Completed procedures (all time, same filters) with no completion time recorded — not counted by date, never dated by payment. */
  proceduresCompletedUndated: number;
  /** Visits scheduled inside the period whose consultation was completed. */
  consultationsCompleted: number;
  /** Enquiries of the period whose procedure/treatment is completed. */
  converted: number;
  /** converted / newEnquiries, null without enquiries. */
  conversionRate: number | null;
}

export interface OperationsDay {
  day: string;
  enquiries: number;
  appointmentsScheduled: number;
  attended: number;
  /** Visits scheduled this day whose consultation was completed. */
  consultationsCompleted: number;
  noShow: number;
  cancelled: number;
  followUpsDue: number;
  followUpsCompleted: number;
}

/** The analytics pipeline: how many of the period's enquiries reached each step (cumulative, never widening). */
export interface OperationsPipelineStage {
  key: "enquiry" | "booked" | "checked_in" | "consulted" | "procedure";
  label: string;
  count: number;
}

export interface OperationsFunnelStage {
  key: "enquiry" | "contacted" | "booked" | "attended" | "procedure" | "converted";
  label: string;
  count: number;
}

export interface OperationsSourceRow {
  sourceId: string | null;
  label: string;
  bucket: SourceChannel;
  enquiries: number;
  contacted: number;
  booked: number;
  attended: number;
  converted: number;
  conversionRate: number | null;
}

export interface OperationsOwnerRow {
  userId: string | null;
  name: string;
  enquiries: number;
  uncontacted: number;
  followUpsDue: number;
  followUpsOverdue: number;
  followUpsCompleted: number;
}

export interface OperationsServiceRow {
  service: string;
  enquiries: number;
  booked: number;
  attended: number;
  converted: number;
}

export interface OperationsReport {
  period: ReportPeriod;
  kpis: OperationsKpis;
  daily: OperationsDay[];
  funnel: OperationsFunnelStage[];
  pipeline: OperationsPipelineStage[];
  bySource: OperationsSourceRow[];
  byOwner: OperationsOwnerRow[];
  byService: OperationsServiceRow[];
}

export interface ReportFilterOptions {
  branches: { id: string; name: string }[];
  departments: { id: string; name: string }[];
  services: string[];
  sources: { id: string; label: string; archived: boolean }[];
  owners: { id: string; name: string }[];
  doctors: { id: string; name: string }[];
}

/** Row-level exports offered next to the report. */
export type ReportExportKind = "summary" | "enquiries" | "appointments" | "follow-ups" | "procedures";


// ---------------------------------------------------------------------------
// Leads workspace (M6.6): operational quick views. These are FILTERS over real journeys, tasks and appointments,
// never stored statuses. Every count shown next to a view is produced by the same predicate that selects its rows.
// ---------------------------------------------------------------------------

export type LeadView = "all" | "today" | "new_today" | "uncontacted" | "follow_up_due" | "appointments_today" | "appointment_booked" | "missed_visit" | "no_response" | "converted" | "lost";

export const LEAD_VIEWS: { key: LeadView; label: string; hint: string }[] = [
  { key: "all", label: "All", hint: "Every lead" },
  { key: "today", label: "Today", hint: "New today, follow-ups due or overdue, appointments today" },
  { key: "new_today", label: "New Today", hint: "Enquiries created today" },
  { key: "uncontacted", label: "Uncontacted", hint: "Nobody has reached them yet" },
  { key: "follow_up_due", label: "Follow-up Due", hint: "An open follow-up due today or overdue" },
  { key: "appointments_today", label: "Appointments Today", hint: "A visit scheduled today" },
  { key: "appointment_booked", label: "Appointment Booked", hint: "A visit booked that has not happened yet" },
  { key: "missed_visit", label: "Missed Visit", hint: "A no-show or cancelled visit that has not been rebooked" },
  { key: "no_response", label: "No Response", hint: "Contacted, no reply, nothing scheduled" },
  { key: "converted", label: "Converted", hint: "Treatment accepted or completed" },
  { key: "lost", label: "Lost", hint: "Closed as lost" },
];

/** The date a Leads range is measured against. It is always stated on screen — dates are never mixed silently. */
export type LeadDateContext =
  | { kind: "created"; label: string }
  | { kind: "today"; label: string }
  | { kind: "follow_up_due"; label: string };

export interface LeadsWorkspaceQuery {
  view?: LeadView;
  range?: ReportRange;
  from?: string;
  to?: string;
  owner?: string;
  source?: string;
  service?: string;
  status?: LeadStatus;
  /** Only with view = follow_up_due: restrict to follow-ups already past due. */
  due?: "overdue";
  /** A CRM field the hospital marked "filterable", and the answer to match (e.g. diabetes = Yes). */
  fieldKey?: string;
  fieldValue?: string;
}

export interface LeadsTodaySummary {
  appointmentsToday: number;
  followUpsDue: number;
  overdue: number;
  newToday: number;
}

export interface LeadsWorkspace {
  view: LeadView;
  period: { range: ReportRange | null; from: string | null; to: string | null; today: string; timezone: string };
  dateContext: LeadDateContext;
  rows: LeadRow[];
  /** Count per view under the active owner / source / service filters (and the range, for views it applies to). */
  counts: Record<LeadView, number>;
  today: LeadsTodaySummary;
  /** Per-owner counts under every active filter except the owner filter itself. */
  ownerCounts: { all: number; unassigned: number; byOwner: { userId: string; name: string; count: number }[] };
  /** What the Service and Source filters can offer: the values that actually occur across this hospital's leads. */
  options: { services: string[]; sources: { key: string; label: string }[]; /** CRM fields marked filterable (choice and Yes/No fields), with the answers to pick from. */ filterableFields: { key: string; label: string; options: string[] }[] };
}

// ---------------------------------------------------------------------------
// Integration Hub (M7). One catalogue of what a hospital can connect, with the facts kept SEPARATE:
// Enabled (the tenant's capability switch) ≠ Configuration (credentials + settings present) ≠ Health (what the
// provider last told us). Secrets are never part of any of these shapes: only `hasSecret`.
// ---------------------------------------------------------------------------

/** One line of the Settings Activity log: who changed which setting, when. Never carries a secret value. */
export interface ActivityEntry {
  id: string;
  at: string;
  actorName: string | null;
  action: string;
  entityType: string;
  entityKey: string | null;
  metadata: Record<string, unknown>;
}

export const INTEGRATION_KEYS = ["google_ads", "meta_ads", "runo", "ccs_ivr", "whatsapp_meta_cloud", "sms", "webhooks"] as const;
export type IntegrationKey = (typeof INTEGRATION_KEYS)[number];
export type IntegrationCategory = "ADS" | "CALLING" | "MESSAGING" | "ADVANCED";
export const INTEGRATION_CATEGORY_LABEL: Record<IntegrationCategory, string> = {
  ADS: "Ads & Attribution",
  CALLING: "Calling & IVR",
  MESSAGING: "Messaging",
  ADVANCED: "Advanced",
};

/** What the card honestly says about how real this connection is. Never inferred from "enabled". */
export type IntegrationMode = "LIVE_CONFIGURED" | "LIVE_CAPABLE" | "SANDBOX" | "FIXTURE" | "BLOCKED" | "NOT_CONFIGURED" | "DISABLED";
export type IntegrationConfigurationState = "CONFIGURED" | "PARTIAL" | "NOT_CONFIGURED" | "BLOCKED";
export type IntegrationHealth = "HEALTHY" | "DEGRADED" | "UNHEALTHY" | "UNKNOWN" | "NOT_APPLICABLE";

export interface IntegrationFieldSpec {
  key: string;
  label: string;
  help?: string;
}

export interface IntegrationCard {
  key: IntegrationKey;
  category: IntegrationCategory;
  name: string;
  provider: string;
  purpose: string;
  /** The tenant switch that turns this on (Settings → Features); null for tools that have none (Webhooks). */
  capability: Capability | null;
  enabled: boolean;
  configuration: IntegrationConfigurationState;
  health: IntegrationHealth;
  mode: IntegrationMode;
  blockedReason: string | null;
  lastSyncAt: string | null;
  lastEventAt: string | null;
  lastError: string | null;
  /** Who may change non-secret settings / credentials, as the caller sees it. */
  canConfigure: boolean;
  canManageSecrets: boolean;
}

export interface IntegrationDetail extends IntegrationCard {
  configurationFields: IntegrationFieldSpec[];
  /** Non-secret values currently set. */
  configurationValues: Record<string, string>;
  /** One entry per secret field; the value itself is never sent. */
  secretFields: (IntegrationFieldSpec & { hasSecret: boolean })[];
  /** Provider dispositions / actions mapped to PulseOS next actions (calling), or other mapping notes. */
  mappingNotes: string | null;
  /** Ads providers only: the latest sync runs (what was pulled, when, and any failure). */
  syncRuns?: AdsSyncRunVm[];
  webhookUrl: string | null;
  connectorMode: "FIXTURE" | "SANDBOX" | "LIVE" | null;
}

export interface IntegrationLogRow {
  id: string;
  provider: string;
  direction: "inbound" | "outbound";
  status: "received" | "processed" | "failed" | "duplicate" | "sent" | "pending";
  summary: string;
  error: string | null;
  at: string;
}

// Outbound webhooks (Super Admin only). Real domain events only; conditions are simple structured comparisons —
// never an expression or script.
export const WEBHOOK_EVENT_TYPES = [
  "lead.created",
  "call.completed",
  "call.missed",
  "interaction.logged",
  "followup.created",
  "appointment.booked",
  "appointment.rescheduled",
  "appointment.cancelled",
  "appointment.completed",
  "surgery.scheduled",
  "surgery.completed",
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];
export const WEBHOOK_CONDITION_OPS = ["eq", "neq", "in"] as const;
export type WebhookConditionOp = (typeof WEBHOOK_CONDITION_OPS)[number];
export interface WebhookCondition {
  /** A top-level field of the event payload (e.g. "sourceKey", "departmentId"). */
  field: string;
  op: WebhookConditionOp;
  value: string | string[];
}

export interface OutboundWebhookVm {
  id: string;
  name: string;
  url: string;
  events: WebhookEventType[];
  conditions: WebhookCondition[];
  enabled: boolean;
  hasSecret: true;
  createdAt: string;
  lastDeliveryAt: string | null;
  lastDeliveryStatus: string | null;
}

// ---------------------------------------------------------------------------
// Notifications (M7): appointment/surgery confirmations and reminders, and staff follow-up messages.
// ---------------------------------------------------------------------------

export const NOTIFICATION_STATUSES = ["PENDING", "PROCESSING", "SENT", "DELIVERED", "READ", "FAILED", "BLOCKED", "CANCELLED"] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

export type NotificationSubject = "APPOINTMENT" | "SURGERY";
export type NotificationRuleKind = "CONFIRMATION" | "REMINDER";
export type NotificationOffsetUnit = "minutes" | "hours" | "days";

/** Why a notification was not created, or was stopped. Stable codes, never free text. */
export type NotificationSuppression =
  | "TRIGGER_ALREADY_PASSED"
  | "TOO_CLOSE_TO_PREVIOUS_NOTIFICATION"
  | "APPOINTMENT_CANCELLED"
  | "RULE_DISABLED";

export interface NotificationRuleVm {
  id: string;
  subject: NotificationSubject;
  kind: NotificationRuleKind;
  enabled: boolean;
  /** CONFIRMATION sends on booking (offset 0); REMINDER sends `offset` before the visit/surgery. */
  offsetValue: number;
  offsetUnit: NotificationOffsetUnit;
  channel: "WHATSAPP";
  templateId: string | null;
  minGapMinutes: number;
}

/** Template purposes and the ONLY variables each may use. A body referencing anything else is refused. */
export const TEMPLATE_PURPOSES = ["APPOINTMENT_CONFIRMATION", "APPOINTMENT_REMINDER", "SURGERY_REMINDER", "FOLLOW_UP_MESSAGE"] as const;
export type TemplatePurpose = (typeof TEMPLATE_PURPOSES)[number];
export const TEMPLATE_PURPOSE_LABEL: Record<TemplatePurpose, string> = {
  APPOINTMENT_CONFIRMATION: "Appointment confirmation",
  APPOINTMENT_REMINDER: "Appointment reminder",
  SURGERY_REMINDER: "Surgery reminder",
  FOLLOW_UP_MESSAGE: "Follow-up message (staff)",
};
export const TEMPLATE_VARIABLES: Record<TemplatePurpose, string[]> = {
  APPOINTMENT_CONFIRMATION: ["patient_name", "doctor_name", "date", "time", "branch_name", "hospital_name"],
  APPOINTMENT_REMINDER: ["patient_name", "doctor_name", "date", "time", "branch_name", "hospital_name"],
  SURGERY_REMINDER: ["patient_name", "procedure", "date", "time", "branch_name", "hospital_name"],
  FOLLOW_UP_MESSAGE: ["patient_name", "staff_name", "hospital_name"],
};

export interface MessageTemplateVm {
  id: string;
  purpose: TemplatePurpose;
  name: string;
  /** The template name approved with the provider (Meta). Required before it can be sent live. */
  providerTemplateName: string;
  language: string;
  body: string;
  variables: string[];
  enabled: boolean;
}

export interface NotificationVm {
  id: string;
  subject: NotificationSubject | "FOLLOW_UP";
  subjectId: string;
  status: NotificationStatus;
  reason: string | null;
  scheduledFor: string;
  sentAt: string | null;
  templatePurpose: TemplatePurpose | null;
}

export interface WhatsAppPreview {
  recipient: string;
  text: string;
  templateName: string;
  missingVariables: string[];
  canSend: boolean;
  blockedReason: string | null;
}

// ---------------------------------------------------------------------------
// Ads reporting (M7): read-only Google Ads / Meta Ads facts, normalized and idempotent per
// (provider, account, entity, date). Provider-reported conversions are NEVER PulseOS outcomes.
// ---------------------------------------------------------------------------

export const ADS_PROVIDERS = ["google_ads", "meta_ads"] as const;
export type AdsProvider = (typeof ADS_PROVIDERS)[number];
export const ADS_PROVIDER_LABEL: Record<AdsProvider, string> = { google_ads: "Google Ads", meta_ads: "Meta Ads" };

export type AdsSyncStatus = "RUNNING" | "SUCCEEDED" | "FAILED";
export interface AdsSyncRunVm {
  id: string;
  status: AdsSyncStatus;
  trigger: "MANUAL" | "SCHEDULED";
  rangeFrom: string;
  rangeTo: string;
  rowsUpserted: number;
  attempts: number;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export type AdsSetupState = "NOT_ENABLED" | "NOT_CONFIGURED" | "NEVER_SYNCED" | "READY";

export interface AdsProviderStatus {
  provider: AdsProvider;
  name: string;
  setup: AdsSetupState;
  mode: IntegrationMode;
  lastSyncedAt: string | null;
  lastSyncStatus: AdsSyncStatus | null;
  lastSyncError: string | null;
}

/** What PulseOS itself recorded for a campaign it could match to the provider's campaign id. */
export interface AdsCampaignOutcomes {
  campaignId: string;
  leads: number;
  appointments: number;
  consultations: number;
  treatments: number;
  revenue: number;
}

export interface AdsCampaignRow {
  provider: AdsProvider;
  entityId: string;
  name: string;
  currency: string;
  spend: number;
  impressions: number;
  clicks: number;
  ctr: number | null;
  cpc: number | null;
  /** As the provider reports them (Google "conversions", Meta mapped results). Never called leads or outcomes. */
  providerConversions: number | null;
  /** Meta results counted under the action types the hospital mapped as leads; null when none are mapped. */
  providerMappedLeads: number | null;
  /** null = PulseOS cannot tie this campaign to its own journeys (never shown as zero). */
  pulseos: AdsCampaignOutcomes | null;
  costPerLead: number | null;
  costPerAppointment: number | null;
  costPerConsultation: number | null;
  costPerTreatment: number | null;
  roas: number | null;
}

export interface AdsAnalytics {
  period: { from: string; to: string; timezone: string };
  providers: AdsProviderStatus[];
  /** Why there is nothing to show (setup, capability, or a slice the ad accounts cannot be split by). */
  unavailable: "NO_PROVIDER_ENABLED" | "NO_PROVIDER_FOR_SOURCE" | "NO_DATA_YET" | "NOT_SLICEABLE" | "MIXED_CURRENCY" | null;
  currency: string | null;
  totals: { spend: number; impressions: number; clicks: number; providerConversions: number | null } | null;
  /** Derived over the campaigns PulseOS could match only, so a cost is never divided by outcomes of a different set. */
  matched: { spend: number; leads: number; appointments: number; consultations: number; treatments: number; revenue: number; costPerLead: number | null; costPerAppointment: number | null; costPerConsultation: number | null; costPerTreatment: number | null; roas: number | null } | null;
  coverage: { matchedCampaigns: number; totalCampaigns: number; matchedSpend: number; totalSpend: number };
  campaigns: AdsCampaignRow[];
  daily: { date: string; spend: number; clicks: number; impressions: number }[];
}

// ---------------------------------------------------------------------------
// Hospital sign-up (public onboarding). The option lists are shared so the form and the API validate the same words.
// ---------------------------------------------------------------------------

export const SIGNUP_INDUSTRIES = ["Healthcare", "Other"] as const;
export const SIGNUP_ORGANIZATION_TYPES = ["Hospital", "Eye Hospital", "Clinic", "Multi-specialty Hospital", "Other"] as const;
/** Departments a hospital can name at sign-up. Ophthalmology and Gynaecology install a ready template; the rest are recorded. */
export const SIGNUP_DEPARTMENTS = ["Ophthalmology", "Gynaecology", "ENT / Rhinology", "Other"] as const;
export const SIGNUP_DISCOVERY_SOURCES = ["Google", "Instagram", "Facebook", "YouTube", "Referral", "Event / Conference", "Invictus Global Tech", "Other"] as const;
export const SIGNUP_EDITIONS = ["V1", "V2"] as const;

export type SignupIndustry = (typeof SIGNUP_INDUSTRIES)[number];
export type SignupEditionChoice = (typeof SIGNUP_EDITIONS)[number];

export interface SignupInput {
  fullName: string;
  email: string;
  phone: string;
  password: string;
  organizationName: string;
  industry: SignupIndustry;
  organizationType?: (typeof SIGNUP_ORGANIZATION_TYPES)[number];
  department?: (typeof SIGNUP_DEPARTMENTS)[number];
  addressLine: string;
  locality?: string;
  city: string;
  state: string;
  pinCode: string;
  country: string;
  discoverySource: (typeof SIGNUP_DISCOVERY_SOURCES)[number];
  discoveryNotes?: string;
  edition: SignupEditionChoice;
}

/** One hospital listed in Developer Access (development only): who it is and which sign-in roles actually exist in it. */
export interface DevEnvironment {
  key: string;
  label: string;
  roles: { role: Role; label: string }[];
}

/** What a hospital has already set up: drives the "Welcome to PulseOS" checklist on an empty Command Centre. */
export interface SetupStatus {
  hasJourneys: boolean;
  crmConfigured: boolean;
  hasDoctors: boolean;
  callingConnected: boolean;
  whatsappConnected: boolean;
  hasStaff: boolean;
}

// ---------------------------------------------------------------------------
// Operational status - a DERIVED indicator ("where is this patient right now?") over the canonical data: the journey's
// stage, its appointments, its treatment and its open tasks. It is never stored, never written back and never replaces a
// stage; it is the one deterministic answer every screen (Leads, Journey, Patient) shows for the same facts.
//
// Precedence, first match wins:
//   1. closed                      the journey is lost
//   2. with_doctor / waiting / checked_in   a visit is in the clinic right now (the furthest step first)
//   3. procedure_done / procedure_scheduled a procedure is booked or finished (the bigger milestone wins over a review visit)
//   4. appointment_confirmed / appointment_booked   a visit is booked and has not happened yet
//   5. treatment_follow_up         an open treatment decision (ADVISED / DECISION_PENDING / ACCEPTED, or a treatment-decision task)
//   6. consultation_completed / no_show / cancelled   the MOST RECENT closed visit decides
//   otherwise null: before any appointment the existing lead status (new, uncontacted, follow-up due...) already says it.
// ---------------------------------------------------------------------------

export const OPERATIONAL_STATUS_KEYS = [
  "appointment_booked",
  "appointment_confirmed",
  "checked_in",
  "waiting",
  "with_doctor",
  "consultation_completed",
  "treatment_follow_up",
  "procedure_scheduled",
  "procedure_done",
  "no_show",
  "cancelled",
  "closed",
] as const;
export type OperationalStatusKey = (typeof OPERATIONAL_STATUS_KEYS)[number];

export interface OperationalStatusInput {
  stage: JourneyStage;
  appointments: { status: AppointmentStatus; scheduledAt: string | Date }[];
  treatments: { status: TreatmentStatus }[];
  /** Types of the journey's OPEN tasks (pending / in progress). */
  openTaskTypes: string[];
}

const IN_CLINIC_RANK: Partial<Record<AppointmentStatus, number>> = { checked_in: 1, waiting: 2, with_doctor: 3 };
const IN_CLINIC_KEY: Record<number, OperationalStatusKey> = { 1: "checked_in", 2: "waiting", 3: "with_doctor" };
const OPEN_TREATMENT: TreatmentStatus[] = ["ADVISED", "DECISION_PENDING", "ACCEPTED"];
const DECISION_TASK_TYPES = ["TREATMENT_DECISION"];

export function deriveOperationalStatus(i: OperationalStatusInput): OperationalStatusKey | null {
  if (i.stage === "lost") return "closed";

  const rank = Math.max(0, ...i.appointments.map((a) => IN_CLINIC_RANK[a.status] ?? 0));
  if (rank > 0) return IN_CLINIC_KEY[rank]!;

  if (i.treatments.some((t) => t.status === "COMPLETED")) return "procedure_done";
  if (i.treatments.some((t) => t.status === "SCHEDULED")) return "procedure_scheduled";

  const pending = i.appointments.filter((a) => a.status === "requested" || a.status === "scheduled" || a.status === "confirmed");
  if (pending.length > 0) return pending.some((a) => a.status === "confirmed") ? "appointment_confirmed" : "appointment_booked";

  const closed = i.appointments
    .filter((a) => a.status === "completed" || a.status === "no_show" || a.status === "cancelled")
    .map((a) => ({ status: a.status, at: new Date(a.scheduledAt).getTime() }))
    // Latest visit first; the status name breaks an exact tie so the answer never depends on input order.
    .sort((a, b) => b.at - a.at || a.status.localeCompare(b.status));
  const last = closed[0];

  if (last?.status === "completed" && (i.treatments.some((t) => OPEN_TREATMENT.includes(t.status)) || i.openTaskTypes.some((t) => DECISION_TASK_TYPES.includes(t)))) return "treatment_follow_up";
  if (!last && i.treatments.some((t) => OPEN_TREATMENT.includes(t.status))) return "treatment_follow_up";
  if (last?.status === "completed") return "consultation_completed";
  if (last?.status === "no_show") return "no_show";
  if (last?.status === "cancelled") return "cancelled";
  return null;
}

// ---------------------------------------------------------------------------
// Owner performance view (Command Centre > Performance). Everything here is counted from real rows - journeys opened in the
// chosen hospital-time period and what happened to them - and carries no revenue, so it exists for every hospital. Insights
// and the alert are RULES over those counts (a threshold and a comparison), labelled as such; nothing here is AI or a forecast.
// ---------------------------------------------------------------------------

// Every step is a fact about the patient's journey, never about a phone call: "Visit attended" means the patient ARRIVED for an
// appointment (checked in, waiting, with the doctor or done); a call being answered is a Calls metric, not a funnel stage.
// "Procedure scheduled" and "Procedure done" are different things: a scheduled procedure is not counted as done.
export const PERFORMANCE_FUNNEL_STEPS = [
  { key: "enquiries", label: "Enquiries" },
  { key: "booked", label: "Appointment booked" },
  { key: "attended", label: "Visit attended" },
  { key: "consulted", label: "Consultation completed" },
  { key: "advised", label: "Procedure advised" },
  { key: "scheduled", label: "Procedure scheduled" },
  { key: "done", label: "Procedure done" },
] as const;
export type PerformanceStepKey = (typeof PERFORMANCE_FUNNEL_STEPS)[number]["key"];

export interface PerformanceFunnelStep {
  key: PerformanceStepKey;
  label: string;
  /** Journeys (from this period's enquiries) that reached at least this step. */
  count: number;
  /** count / previous step's count, 0-100; null for the first step or when the previous step is empty. */
  conversionFromPrevious: number | null;
  /** Journeys that reached the previous step but not this one. */
  droppedBefore: number;
}

export interface PerformanceBreakdownRow {
  key: string;
  label: string;
  enquiries: number;
  booked: number;
  attended: number;
  consulted: number;
  advised: number;
  scheduled: number;
  done: number;
}

export interface DemographicRow {
  label: string;
  count: number;
  /** Share of the people who answered this question, 0-100. */
  pct: number;
}
/** One "who is enquiring" breakdown: the age group, or one of the hospital's own filterable fields. Only exists when real answers do. */
export interface DemographicDimension {
  key: string;
  label: string;
  /** How many enquiries have an answer (the rest are simply not counted, never shown as a group). */
  answered: number;
  rows: DemographicRow[];
}

export interface PerformanceStaffRow {
  userId: string;
  name: string;
  role: Role;
  /** Enquiries (opened in the period) this person owns. */
  owned: number;
  contacted: number;
  booked: number;
  callsLogged: number;
  followUpsDone: number;
  /** Follow-ups assigned to them that are overdue right now (not limited to the period). */
  overdueNow: number;
}

export type PerformanceInsightKey = "uncontacted" | "overdue_followups" | "no_shows" | "no_outcome" | "undecided" | "lost";
export interface PerformanceInsight {
  key: PerformanceInsightKey;
  /** A plain sentence, e.g. "14 enquiries have not yet been contacted". */
  message: string;
  count: number;
  /** Where to act on it (an existing view). */
  href: string;
  severity: "attention" | "info";
}

export type PerformanceAlertKind = "enquiries_down" | "contact_rate_low" | "no_show_rate_high";
export interface PerformanceAlert {
  kind: PerformanceAlertKind;
  message: string;
  /** The numbers behind it, so it can be checked. */
  detail: string;
  /** Always "Rule-based alert": a fixed threshold over the counts above, never a model. */
  label: "Rule-based alert";
}

export interface PerformanceDashboard {
  period: DashboardPeriod | null;
  funnel: PerformanceFunnelStep[];
  kpis: {
    enquiries: number;
    booked: number;
    attended: number;
    consulted: number;
    noShows: number;
    advised: number;
    scheduled: number;
    /** Procedures actually completed (not merely scheduled). */
    done: number;
    /** attended / booked, 0-100 (null with nothing booked). */
    attendanceRate: number | null;
    /** consulted / attended, 0-100. */
    consultationCompletionRate: number | null;
    /** done / enquiries, 0-100: enquiries that ended in a completed procedure. */
    conversionRate: number | null;
  };
  insights: PerformanceInsight[];
  /** Age group plus the hospital's filterable fields (area, gender ...), for the same enquiries. Empty when nothing has been recorded. */
  demographics: DemographicDimension[];
  alert: PerformanceAlert | null;
  sources: PerformanceBreakdownRow[];
  services: PerformanceBreakdownRow[];
  staff: PerformanceStaffRow[];
}

// ---------------------------------------------------------------------------
// Tenant-branded sign-in. ONE approved PulseOS page serves every hospital (/login/<slug>); only the SAFE structured data below
// differs. Structured data only: no HTML, no CSS, no script, no colours. This is everything the public endpoint may say.
// ---------------------------------------------------------------------------

export const DEFAULT_LOGIN_TAGLINE = "Every enquiry, call, appointment and follow-up in one place.";
export const DEFAULT_LOGIN_SUPPORT_TEXT = "Need help? Contact your administrator.";

/** A logo is a file of this app's own /brand folder (so it is served from the same origin, never an outside URL). */
export const LOGIN_LOGO_PATH_PATTERN = /^\/brand\/[a-z0-9][a-z0-9._-]{0,80}\.(svg|png|webp)$/;

export interface TenantLoginBranding {
  slug: string;
  /** The hospital's full name (tenants.name). */
  displayName: string;
  /** The short name used in "PulseOS × Namokar" and "Namokar's PulseOS workspace". */
  shortName: string;
  /** An approved client logo (/brand/…); null = the typographic fallback. */
  logoPath: string | null;
  /** The large line on the brand panel; null = the full name. */
  headline: string | null;
  tagline: string;
  /** The small badge in the sign-in card ("V1 Pilot"); null = no badge. */
  badgeLabel: string | null;
  supportText: string;
}
