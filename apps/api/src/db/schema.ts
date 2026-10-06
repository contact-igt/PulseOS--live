import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, integer, boolean, jsonb, pgEnum, index, uniqueIndex, primaryKey, date, numeric, check, type AnyPgColumn } from "drizzle-orm/pg-core";

export const roleEnum = pgEnum("role", ["SUPER_ADMIN", "HOSPITAL_ADMIN", "FRONT_DESK", "PATIENT_COORDINATOR", "DOCTOR"]);

// One codebase, one schema: the edition is a tenant property read by the API (see domain/auth/edition.ts) and mirrored in the UI.
export const tenantEditionEnum = pgEnum("tenant_edition", ["BETA_V1_CORE", "BETA_V2_GROWTH"]);

export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  // ISO 3166-1 alpha-2 region used as the default country context when
  // normalizing a phone number to E.164 with no other signal available.
  defaultPhoneRegion: text("default_phone_region").notNull().default("IN"),
  // IANA timezone of the hospital. Every analytics day/week bucket ("which day
  // did this enquiry arrive on?") is grouped in this zone, not UTC or the
  // server clock, so a 23:30 IST enquiry lands on its own calendar day.
  timezone: text("timezone").notNull().default("Asia/Kolkata"),
  // Existing tenants predate editions and keep every capability they already had.
  edition: tenantEditionEnum("edition").notNull().default("BETA_V2_GROWTH"),
  // The name a hospital's dedicated sign-in page is reached by (/login/<slug>). Null = no dedicated page (sign-up and demo
  // hospitals). Lower-case words only, unique; the page can sign people into THIS hospital and no other.
  loginSlug: text("login_slug"),
  // Weekly clinic hours (see ClinicHours in @pulseos/types). Null = no restriction. Appointments are only accepted inside them.
  clinicHours: jsonb("clinic_hours").$type<import("@pulseos/types").ClinicHours | null>(),
  // Interface style (Settings > Appearance): "airy" | "balanced" | "solid". Null = the default (balanced).
  surfaceStyle: text("surface_style"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  loginSlugUnique: uniqueIndex("tenants_login_slug_unique").on(t.loginSlug),
  surfaceStyleShape: check("tenants_surface_style_shape", sql`${t.surfaceStyle} is null or ${t.surfaceStyle} in ('airy', 'balanced', 'solid')`),
  loginSlugShape: check("tenants_login_slug_shape", sql`${t.loginSlug} is null or ${t.loginSlug} ~ '^[a-z][a-z0-9-]{1,38}[a-z0-9]$'`),
}));

// What a hospital told us about itself when it signed up (or, for the seeded demos, who it is). One row per tenant.
// `devVisible` is the ONLY thing that lists a tenant in Developer Access: it is set at sign-up when development login is
// enabled, and by the demo seed - never in production, never from a request field.
export const tenantProfiles = pgTable("tenant_profiles", {
  tenantId: uuid("tenant_id").primaryKey().references(() => tenants.id),
  source: text("source").notNull().default("signup"), // signup | demo
  devVisible: boolean("dev_visible").notNull().default(false),
  ownerName: text("owner_name").notNull(),
  ownerEmail: text("owner_email").notNull(),
  ownerPhone: text("owner_phone").notNull(),
  industry: text("industry").notNull(),
  organizationType: text("organization_type"),
  department: text("department"),
  addressLine: text("address_line").notNull(),
  locality: text("locality"),
  city: text("city").notNull(),
  state: text("state").notNull(),
  pinCode: text("pin_code").notNull(),
  country: text("country").notNull().default("India"),
  discoverySource: text("discovery_source").notNull(),
  discoveryNotes: text("discovery_notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// What a hospital's own sign-in page says (/login/<slug>). SAFE STRUCTURED DATA only - short text and one logo file of this app's own
// /brand folder; never HTML, CSS, script or a colour. Every column is optional: a hospital with no row (or null columns) gets the
// defaults, so a missing logo or tagline can never block anyone from signing in. Bounded by CHECKs, so a page cannot be flooded.
export const tenantLoginConfigs = pgTable("tenant_login_configs", {
  tenantId: uuid("tenant_id").primaryKey().references(() => tenants.id),
  shortName: text("short_name"),
  logoPath: text("logo_path"),
  headline: text("headline"),
  tagline: text("tagline"),
  badgeLabel: text("badge_label"),
  supportText: text("support_text"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  shortNameLen: check("tenant_login_configs_short_name_len", sql`${t.shortName} is null or char_length(${t.shortName}) between 1 and 40`),
  logoPathShape: check("tenant_login_configs_logo_path_shape", sql`${t.logoPath} is null or ${t.logoPath} ~ '^/brand/[a-z0-9][a-z0-9._-]{0,80}\\.(svg|png|webp)$'`),
  headlineLen: check("tenant_login_configs_headline_len", sql`${t.headline} is null or char_length(${t.headline}) between 1 and 120`),
  taglineLen: check("tenant_login_configs_tagline_len", sql`${t.tagline} is null or char_length(${t.tagline}) between 1 and 160`),
  badgeLen: check("tenant_login_configs_badge_len", sql`${t.badgeLabel} is null or char_length(${t.badgeLabel}) between 1 and 24`),
  supportLen: check("tenant_login_configs_support_len", sql`${t.supportText} is null or char_length(${t.supportText}) between 1 and 160`),
}));

// A tenant's OWN capability switches. A row overrides the edition's default for that capability (on or off); no row
// means "use the edition default". The runtime authority for what a tenant can do is edition default + these rows.
export const tenantCapabilities = pgTable("tenant_capabilities", {
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  capability: text("capability").notNull(),
  enabled: boolean("enabled").notNull(),
  updatedBy: uuid("updated_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.tenantId, t.capability] }),
}));

export const branches = pgTable("branches", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  name: text("name").notNull(),
  city: text("city").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  tenantIdx: index("branches_tenant_idx").on(t.tenantId),
}));

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  branchId: uuid("branch_id").references(() => branches.id),
  name: text("name").notNull(),
  email: text("email").notNull(),
  passwordHash: text("password_hash").notNull(),
  role: roleEnum("role").notNull(),
  // Personal display preferences (bounded names, never raw sizes). Null = never chosen = the standard.
  interfaceSize: text("interface_size"),
  textSize: text("text_size"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  tenantIdx: index("users_tenant_idx").on(t.tenantId),
  emailTenantUnique: uniqueIndex("users_email_tenant_unique").on(t.tenantId, t.email),
  interfaceSizeShape: check("users_interface_size_shape", sql`${t.interfaceSize} is null or ${t.interfaceSize} in ('compact', 'comfortable', 'large')`),
  textSizeShape: check("users_text_size_shape", sql`${t.textSize} is null or ${t.textSize} in ('small', 'default', 'large', 'xlarge')`),
}));

export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  userIdx: index("sessions_user_idx").on(t.userId),
}));

export const sourceEnum = pgEnum("source_channel", ["meta", "google", "website", "whatsapp", "phone", "walk_in", "referral", "organic", "other"]);
export type SourceChannelDb = (typeof sourceEnum.enumValues)[number];

export const patients = pgTable("patients", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  branchId: uuid("branch_id").references(() => branches.id),
  // NULL while the name is unknown (a caller who has not given one). Never a placeholder string in storage; the
  // API derives a display label ("Unknown patient") so analytics and search never see an invented name.
  name: text("name"),
  // Optional. A date of birth is exact; a reported age is what the patient said at first contact.
  dateOfBirth: date("date_of_birth"),
  reportedAge: integer("reported_age"),
  // Raw, as-entered/as-received value — always preserved, still the display value.
  phone: text("phone").notNull(),
  // Canonical E.164 form (null when normalization failed) — the only field
  // identity resolution ever matches on. Never fuzzy-matched.
  phoneE164: text("phone_e164"),
  phoneCountry: text("phone_country"),
  email: text("email"),
  preferredLanguage: text("preferred_language").notNull().default("English"),
  // Conversion-feedback eligibility gate — defaults to true (a patient who
  // messages/calls/submits a form has implicitly engaged), can be revoked.
  // See acquisition/conversion-feedback.service.ts.
  marketingConsent: boolean("marketing_consent").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  tenantIdx: index("patients_tenant_idx").on(t.tenantId),
  phoneE164Idx: index("patients_phone_e164_idx").on(t.phoneE164),
  // One Patient per tenant per number, enforced by the database so concurrent webhooks/forms cannot create two.
  // An un-normalizable number (no E.164) falls back to its exact raw text.
  tenantPhoneE164Unique: uniqueIndex("patients_tenant_phone_e164_unique").on(t.tenantId, t.phoneE164).where(sql`${t.phoneE164} is not null`),
  tenantRawPhoneUnique: uniqueIndex("patients_tenant_raw_phone_unique").on(t.tenantId, t.phone).where(sql`${t.phoneE164} is null`),
}));

// Departments and lead sources are tenant-owned configuration, installed from global definitions in code
// (domain/specialty/department-templates.ts, domain/lead/lead-source.service.ts) and then edited freely per tenant.
export const departments = pgTable("departments", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  key: text("key").notNull(),
  displayName: text("display_name").notNull(),
  // The global template this department was installed from (null for a hospital-made department).
  templateKey: text("template_key"),
  archived: boolean("archived").notNull().default(false),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  tenantKeyUnique: uniqueIndex("departments_tenant_key_unique").on(t.tenantId, t.key),
}));

// SOURCE = where the patient originally came from. `bucket` maps a source onto the coarse platform enum the
// campaign/attribution/analytics code has always used, so a hospital can add "Newspaper" without touching them.
export const leadSources = pgTable("lead_sources", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  key: text("key").notNull(),
  label: text("label").notNull(),
  // No DB default: an enum value added in an earlier migration cannot be used as a default in the same transaction.
  bucket: sourceEnum("bucket").notNull(),
  // Archived sources stay valid on the journeys that already use them but are not offered for new leads.
  archived: boolean("archived").notNull().default(false),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  tenantKeyUnique: uniqueIndex("lead_sources_tenant_key_unique").on(t.tenantId, t.key),
}));

// CHANNEL = how one interaction happened. Fixed by the product (never tenant-edited): it keeps interaction
// analytics comparable across hospitals, and is independent of the patient's original source.
export const interactionChannelEnum = pgEnum("interaction_channel", ["IVR_CALL", "MANUAL_CALL", "WHATSAPP", "INSTAGRAM_DM", "FACEBOOK_DM", "WALK_IN"]);

export const journeyStageEnum = pgEnum("journey_stage", [
  "enquiry", "contacted", "booked", "attended", "consulted", "treatment_advised", "scheduled", "completed", "lost",
]);

// Declared here (ahead of its original home just above `tasks`) so `journeys`
// below can reuse the same enum for lead priority instead of duplicating it.
export const taskPriorityEnum = pgEnum("task_priority", ["normal", "high"]);

// Tenant-configurable outcomes (sub-status / disposition / follow-up reason). The canonical Journey stage
// stays fixed; an outcome only maps to CONTACTED or LOST and carries three simple rules.
export const crmOutcomes = pgTable("crm_outcomes", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  key: text("key").notNull(),
  label: text("label").notNull(),
  stage: text("stage").notNull().default("contacted"),
  requiresFollowUp: boolean("requires_follow_up").notNull().default(false),
  allowsAppointment: boolean("allows_appointment").notNull().default(false),
  asksReason: boolean("asks_reason").notNull().default(false),
  followUpType: text("follow_up_type").notNull().default("FOLLOW_UP"),
  sortOrder: integer("sort_order").notNull().default(0),
  archived: boolean("archived").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  tenantIdx: index("crm_outcomes_tenant_idx").on(t.tenantId),
  tenantKeyUnique: uniqueIndex("crm_outcomes_tenant_key_unique").on(t.tenantId, t.key),
}));

// Ordered first-match rules that choose the owner of a new Journey. A pool of users is shared round-robin
// through rr_cursor (incremented atomically). Manual assignment always wins.
export const allocationRules = pgTable("allocation_rules", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  name: text("name").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  enabled: boolean("enabled").notNull().default(true),
  matchSource: text("match_source"),
  matchSpecialtyKey: text("match_specialty_key"),
  matchJourneyType: text("match_journey_type"),
  matchBranchId: uuid("match_branch_id").references(() => branches.id),
  pool: jsonb("pool").notNull().default([]),
  rrCursor: integer("rr_cursor").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  tenantIdx: index("allocation_rules_tenant_idx").on(t.tenantId),
}));

export const journeys = pgTable("journeys", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  patientId: uuid("patient_id").notNull().references(() => patients.id),
  journeyType: text("journey_type").notNull(),
  // Free-text key into specialty_templates.key, not a hard FK — a template
  // may be archived without invalidating historical journeys that used it.
  specialtyKey: text("specialty_key"),
  stage: journeyStageEnum("stage").notNull().default("enquiry"),
  // Coarse bucket (analytics / attribution); sourceId below is the precise original source.
  source: sourceEnum("source").notNull(),
  sourceId: uuid("source_id").references(() => leadSources.id),
  departmentId: uuid("department_id").references(() => departments.id),
  // Free-text refinement of the source ("CCS Express IVR", a camp name...). Never a substitute for sourceId.
  sourceDetail: text("source_detail"),
  ownerUserId: uuid("owner_user_id").references(() => users.id),
  priority: taskPriorityEnum("priority").notNull().default("normal"),
  notes: text("notes"),
  contactedAt: timestamp("contacted_at", { withTimezone: true }),
  // The latest configured outcome logged on this Journey (its sub-status).
  lastOutcomeId: uuid("last_outcome_id").references(() => crmOutcomes.id),
  lastOutcomeAt: timestamp("last_outcome_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  tenantIdx: index("journeys_tenant_idx").on(t.tenantId),
  patientIdx: index("journeys_patient_idx").on(t.patientId),
}));

export const taskStatusEnum = pgEnum("task_status", ["pending", "in_progress", "completed", "cancelled"]);

// `reason` is the operational-failure bucket used only for Spend-At-Risk
// categorization (dashboard.service.ts SPEND_AT_RISK_CATEGORIES) — it answers
// "what acquisition spend is this task protecting," not "what kind of work is
// this." `type` (below) is the hospital-operational work category shown on
// Tasks/My Work and answers "what does the assignee actually need to do."
// The two taxonomies serve different screens and are kept independent.
export const taskReasonEnum = pgEnum("task_reason", [
  "overdue_callback", "missed_follow_up", "no_show", "high_intent_uncontacted", "treatment_decision_pending", "manual_task", "new_lead",
]);

export const taskTypeEnum = pgEnum("task_type", [
  "CALLBACK", "FOLLOW_UP", "APPOINTMENT_CONFIRMATION", "NO_SHOW_RECOVERY", "TREATMENT_DECISION", "POST_CARE", "RECALL", "OTHER",
]);

// Tenant-owned follow-up types: the product labels staff see ("Callback", "Appointment Risk"…). Each maps onto a
// canonical Task type, so the Task engine and everything keyed on it stay stable. `key` never changes once created;
// a type is archived (isActive=false) rather than deleted, so historical tasks keep their label.
export const followUpDefaultOwnerEnum = pgEnum("followup_default_owner", ["JOURNEY_OWNER", "ACTOR", "UNASSIGNED"]);

export const followUpTypes = pgTable("followup_types", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  // Null = offered for every department; otherwise only for journeys of that department.
  departmentId: uuid("department_id").references(() => departments.id),
  key: text("key").notNull(),
  label: text("label").notNull(),
  canonicalTaskType: taskTypeEnum("canonical_task_type").notNull().default("FOLLOW_UP"),
  defaultPriority: taskPriorityEnum("default_priority").notNull().default("normal"),
  defaultOwner: followUpDefaultOwnerEnum("default_owner").notNull().default("JOURNEY_OWNER"),
  requiresNote: boolean("requires_note").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  tenantKeyUnique: uniqueIndex("followup_types_tenant_key_unique").on(t.tenantId, t.key),
}));

export const tasks = pgTable("tasks", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  patientId: uuid("patient_id").notNull().references(() => patients.id),
  journeyId: uuid("journey_id").references(() => journeys.id),
  assignedTo: uuid("assigned_to").references(() => users.id),
  reason: taskReasonEnum("reason").notNull().default("manual_task"),
  type: taskTypeEnum("type").notNull().default("OTHER"),
  // The tenant's product label for this task (null on tasks made before follow-up types, or by the system).
  followUpTypeId: uuid("followup_type_id").references(() => followUpTypes.id),
  priority: taskPriorityEnum("priority").notNull().default("normal"),
  status: taskStatusEnum("status").notNull().default("pending"),
  notes: text("notes"),
  dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
  createdBy: uuid("created_by").references(() => users.id),
  completedBy: uuid("completed_by").references(() => users.id),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  // Set only on a system-raised Appointment Risk task: which appointment, and which operational signal raised it.
  // At most one OPEN task per (appointment, riskReason) — see the partial unique index below.
  appointmentId: uuid("appointment_id").references((): AnyPgColumn => appointments.id, { onDelete: "set null" }),
  riskReason: text("risk_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  tenantIdx: index("tasks_tenant_idx").on(t.tenantId),
  assignedIdx: index("tasks_assigned_idx").on(t.assignedTo),
  journeyIdx: index("tasks_journey_idx").on(t.journeyId),
  openRiskUnique: uniqueIndex("tasks_open_appointment_risk_unique").on(t.appointmentId, t.riskReason).where(sql`${t.appointmentId} is not null and ${t.riskReason} is not null and ${t.status} in ('pending', 'in_progress')`),
}));

// "scheduled" is the DB-level synonym for the operational state BOOKED
// (kept as the original enum value to avoid a risky ALTER TYPE RENAME VALUE
// migration on live data — display layers show it as "Booked").
export const appointmentStatusEnum = pgEnum("appointment_status", [
  "requested", "scheduled", "confirmed", "checked_in", "waiting", "with_doctor", "completed", "no_show", "cancelled",
]);

// Who an appointment or surgery is scheduled WITH. A resource is a scheduling profile, not a login: a doctor may have
// no PulseOS account at all. `linkedUserId` ties the profile to a person who can sign in (their own dashboard and
// consultation outcomes follow that link). Every DOCTOR user gets a linked resource automatically (DB trigger).
export const scheduleResources = pgTable("schedule_resources", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  departmentId: uuid("department_id").references(() => departments.id, { onDelete: "set null" }),
  linkedUserId: uuid("linked_user_id").references(() => users.id, { onDelete: "set null" }),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  tenantIdx: index("schedule_resources_tenant_idx").on(t.tenantId),
  linkedUserUnique: uniqueIndex("schedule_resources_tenant_user_unique").on(t.tenantId, t.linkedUserId).where(sql`${t.linkedUserId} is not null`),
}));

export const appointments = pgTable("appointments", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  patientId: uuid("patient_id").notNull().references(() => patients.id),
  journeyId: uuid("journey_id").notNull().references(() => journeys.id),
  branchId: uuid("branch_id").notNull().references(() => branches.id),
  // Who the visit is with. The DB guarantees it is set (a trigger resolves it from doctorUserId for older writers).
  resourceId: uuid("resource_id").references(() => scheduleResources.id),
  // The resource's login, when it has one — kept in step by the DB so the Doctor's own views keep working.
  doctorUserId: uuid("doctor_user_id").references(() => users.id),
  status: appointmentStatusEnum("status").notNull().default("scheduled"),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
  reason: text("reason"),
  // Event timestamps — only the ones the front-desk workflow reads (waiting time, "completed 11:42 AM").
  checkedInAt: timestamp("checked_in_at", { withTimezone: true }),
  waitingStartedAt: timestamp("waiting_started_at", { withTimezone: true }),
  consultationStartedAt: timestamp("consultation_started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  noShowAt: timestamp("no_show_at", { withTimezone: true }),
  // Why the latest reschedule / cancellation / no-show happened (a stable code + optional note); the Timeline keeps the history.
  statusReasonCode: text("status_reason_code"),
  statusReasonNote: text("status_reason_note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  tenantIdx: index("appointments_tenant_idx").on(t.tenantId),
  doctorIdx: index("appointments_doctor_idx").on(t.doctorUserId),
  resourceIdx: index("appointments_resource_idx").on(t.resourceId),
  // The notification reconcile pass scans confirmed, upcoming visits across hospitals.
  statusScheduledIdx: index("appointments_status_scheduled_idx").on(t.status, t.scheduledAt),
}));

// ---------------------------------------------------------------------------
// Marketing → Patient Journey attribution domain
// ---------------------------------------------------------------------------

export const campaignStatusEnum = pgEnum("campaign_status", ["active", "paused", "ended"]);

export const marketingCampaigns = pgTable("marketing_campaigns", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  // Which connector synced this campaign, and therefore which mode
  // (FIXTURE/SANDBOX/LIVE) its spend/status data actually reflects — null
  // for manually-created campaigns (e.g. seed data) that were never synced
  // from a provider. The Campaigns/Sources UI joins through this to show
  // mode clearly rather than ever implying real synced spend for a fixture
  // connector.
  connectorId: uuid("connector_id").references(() => connectors.id),
  source: sourceEnum("source").notNull(),
  name: text("name").notNull(),
  externalCampaignId: text("external_campaign_id"),
  // Ad-account-level id (Meta ad account, Google Ads customer id...) — the
  // level above campaign, needed once campaign spend sync is wired in.
  externalAccountId: text("external_account_id"),
  spendAmount: integer("spend_amount").notNull().default(0),
  currency: text("currency").notNull().default("INR"),
  startDate: timestamp("start_date", { withTimezone: true }).notNull(),
  endDate: timestamp("end_date", { withTimezone: true }),
  status: campaignStatusEnum("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  tenantIdx: index("marketing_campaigns_tenant_idx").on(t.tenantId),
  // NULLs never collide in a Postgres unique index, so manually-created
  // campaigns (no externalCampaignId) are unaffected — this only guards
  // against re-creating a duplicate campaign row for the same provider id.
  tenantExternalUnique: uniqueIndex("marketing_campaigns_tenant_external_unique").on(t.tenantId, t.externalCampaignId),
}));

// `touchType` marks structural role, not a fixed count: the row created by a
// journey's very first attribution event stays "first_touch" forever (never
// overwritten); every touchpoint recorded after that is "last_touch" — the
// one among those with the latest occurredAt is the current last touch, and
// all "last_touch" rows together are the full touchpoint history between
// first and now. See acquisition/attribution.service.ts.
export const touchTypeEnum = pgEnum("touch_type", ["first_touch", "last_touch"]);

export const campaignTouchpoints = pgTable("campaign_touchpoints", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  patientId: uuid("patient_id").notNull().references(() => patients.id),
  journeyId: uuid("journey_id").notNull().references(() => journeys.id),
  campaignId: uuid("campaign_id").references(() => marketingCampaigns.id),
  source: sourceEnum("source").notNull(),
  touchType: touchTypeEnum("touch_type").notNull().default("first_touch"),
  // UTM-style context, kept as raw strings alongside the resolved campaignId
  // so a touchpoint is still meaningful even when no MarketingCampaign could
  // be resolved (e.g. an unrecognized utm_campaign value on a website form).
  medium: text("medium"),
  utmCampaign: text("utm_campaign"),
  utmContent: text("utm_content"),
  utmTerm: text("utm_term"),
  // Provider hierarchy ids, preserved verbatim for drill-down even though
  // only externalCampaignId currently resolves to a MarketingCampaign.
  externalAccountId: text("external_account_id"),
  externalCampaignId: text("external_campaign_id"),
  externalAdGroupId: text("external_ad_group_id"),
  externalAdId: text("external_ad_id"),
  externalFormId: text("external_form_id"),
  externalLeadId: text("external_lead_id"),
  // Click identifiers — gclid/gbraid/wbraid for Google traffic, fbclid for
  // Meta traffic. Preserved for downstream conversion feedback, never used
  // for identity matching.
  gclid: text("gclid"),
  gbraid: text("gbraid"),
  wbraid: text("wbraid"),
  fbclid: text("fbclid"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  metadata: jsonb("metadata"),
}, (t) => ({
  tenantIdx: index("campaign_touchpoints_tenant_idx").on(t.tenantId),
  journeyIdx: index("campaign_touchpoints_journey_idx").on(t.journeyId),
  campaignIdx: index("campaign_touchpoints_campaign_idx").on(t.campaignId),
}));

export const conversionFeedbackEventTypeEnum = pgEnum("conversion_feedback_event_type", [
  "QUALIFIED_ENQUIRY", "APPOINTMENT_BOOKED", "APPOINTMENT_ATTENDED", "CONSULTATION_COMPLETED",
  "TREATMENT_ADVISED", "TREATMENT_COMPLETED", "REVENUE_RECORDED",
]);

// A candidate outbound conversion-feedback event, built only when the
// patient is consent-eligible (marketingConsent) — see
// acquisition/conversion-feedback.service.ts. Deliberately never sent to any
// provider by this checkpoint; this table is the payload-building/audit
// layer only. click ids and externalCampaignId are copied from the
// journey's current attribution (attribution.service.getAttributionSummary)
// at the moment the milestone is recorded, not looked up live later.
export const conversionFeedbackEvents = pgTable("conversion_feedback_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  journeyId: uuid("journey_id").notNull().references(() => journeys.id),
  patientId: uuid("patient_id").notNull().references(() => patients.id),
  eventType: conversionFeedbackEventTypeEnum("event_type").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  value: integer("value"),
  currency: text("currency").notNull().default("INR"),
  source: sourceEnum("source"),
  externalCampaignId: text("external_campaign_id"),
  gclid: text("gclid"),
  gbraid: text("gbraid"),
  wbraid: text("wbraid"),
  fbclid: text("fbclid"),
  // "{journeyId}:{eventType}" — a journey reports each milestone at most
  // once, even if the triggering domain event somehow fires twice.
  idempotencyKey: text("idempotency_key").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  tenantIdx: index("conversion_feedback_events_tenant_idx").on(t.tenantId),
  idempotencyUnique: uniqueIndex("conversion_feedback_events_idempotency_unique").on(t.idempotencyKey),
}));

export const consultationOutcomeEnum = pgEnum("consultation_outcome_type", [
  "CONSULTED", "TREATMENT_ADVISED", "NO_TREATMENT_REQUIRED", "DECISION_PENDING", "FOLLOW_UP_REQUIRED", "REFERRED", "OTHER", "TREATMENT_DECLINED",
]);

export const consultationOutcomes = pgTable("consultation_outcomes", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  patientId: uuid("patient_id").notNull().references(() => patients.id),
  journeyId: uuid("journey_id").notNull().references(() => journeys.id),
  appointmentId: uuid("appointment_id").notNull().references(() => appointments.id),
  outcome: consultationOutcomeEnum("outcome").notNull(),
  recordedBy: uuid("recorded_by").notNull().references(() => users.id),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  notes: text("notes"),
}, (t) => ({
  tenantIdx: index("consultation_outcomes_tenant_idx").on(t.tenantId),
  appointmentUnique: uniqueIndex("consultation_outcomes_appointment_unique").on(t.appointmentId),
}));

export const treatmentStatusEnum = pgEnum("treatment_status", [
  "ADVISED", "DECISION_PENDING", "ACCEPTED", "SCHEDULED", "COMPLETED", "DECLINED", "CANCELLED", "LOST",
]);

export const treatmentOpportunities = pgTable("treatment_opportunities", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  patientId: uuid("patient_id").notNull().references(() => patients.id),
  journeyId: uuid("journey_id").notNull().references(() => journeys.id),
  consultationOutcomeId: uuid("consultation_outcome_id").references(() => consultationOutcomes.id),
  treatmentLabel: text("treatment_label").notNull(),
  // Optional link to the tenant's treatment catalog (treatment_definitions). The label above stays the
  // display text (and is all that free-text/legacy rows have); the FK is what groups/filters by procedure.
  treatmentDefinitionId: uuid("treatment_definition_id").references(() => treatmentDefinitions.id),
  status: treatmentStatusEnum("status").notNull().default("ADVISED"),
  estimatedValue: integer("estimated_value").notNull().default(0),
  ownerUserId: uuid("owner_user_id").references(() => users.id),
  decisionDate: timestamp("decision_date", { withTimezone: true }),
  plannedDate: timestamp("planned_date", { withTimezone: true }),
  // Where and with whom a SCHEDULED procedure takes place (operational scheduling only — no clinical fields).
  scheduledResourceId: uuid("scheduled_resource_id").references(() => scheduleResources.id, { onDelete: "set null" }),
  scheduledBranchId: uuid("scheduled_branch_id").references(() => branches.id, { onDelete: "set null" }),
  scheduleNote: text("schedule_note"),
  // When the treatment was COMPLETED, stamped by the transition service with the server clock. COMPLETED is final, so
  // it is set once and never changes. Distinct from plannedDate (when it was SCHEDULED for) and from revenue dates
  // (when money was recorded). NULL on rows completed before this column existed unless the Timeline held the
  // moment of completion — never inferred from a payment date.
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  tenantIdx: index("treatment_opportunities_tenant_idx").on(t.tenantId),
  completedIdx: index("treatment_opportunities_completed_idx").on(t.tenantId, t.completedAt).where(sql`${t.completedAt} is not null`),
  journeyIdx: index("treatment_opportunities_journey_idx").on(t.journeyId),
  definitionIdx: index("treatment_opportunities_definition_idx").on(t.treatmentDefinitionId),
}));

export const revenueEventTypeEnum = pgEnum("revenue_event_type", ["consultation_fee", "treatment_payment", "other"]);

export const revenueEvents = pgTable("revenue_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  patientId: uuid("patient_id").notNull().references(() => patients.id),
  journeyId: uuid("journey_id").notNull().references(() => journeys.id),
  treatmentOpportunityId: uuid("treatment_opportunity_id").references(() => treatmentOpportunities.id),
  amount: integer("amount").notNull(),
  currency: text("currency").notNull().default("INR"),
  type: revenueEventTypeEnum("type").notNull().default("treatment_payment"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  sourceSystem: text("source_system").notNull().default("manual"),
}, (t) => ({
  tenantIdx: index("revenue_events_tenant_idx").on(t.tenantId),
  journeyIdx: index("revenue_events_journey_idx").on(t.journeyId),
  // A treatment produces at most one completion-revenue-event. treatmentOpportunityId
  // is nullable (a revenue event need not always be tied to a treatment), and a plain
  // unique index treats NULLs as distinct — so this only constrains the non-null case,
  // exactly the invariant we need. Defense-in-depth alongside the application-level
  // conditional-update guard in treatment.service.ts's updateTreatmentStatus.
  treatmentOpportunityUnique: uniqueIndex("revenue_events_treatment_opportunity_unique").on(t.treatmentOpportunityId),
}));

export const actorTypeEnum = pgEnum("actor_type", ["system", "ai", "user"]);

export const timelineEvents = pgTable("timeline_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  patientId: uuid("patient_id").notNull().references(() => patients.id),
  journeyId: uuid("journey_id").references(() => journeys.id),
  actorType: actorTypeEnum("actor_type").notNull().default("system"),
  actorId: uuid("actor_id"),
  eventType: text("event_type").notNull(),
  // Legacy: holds the lead's source key on lead events. The interaction channel is `channel`.
  sourceChannel: text("source_channel"),
  channel: interactionChannelEnum("channel"),
  title: text("title").notNull(),
  description: text("description"),
  relatedEntityType: text("related_entity_type"),
  relatedEntityId: uuid("related_entity_id"),
  metadata: jsonb("metadata"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  tenantIdx: index("timeline_events_tenant_idx").on(t.tenantId),
  patientIdx: index("timeline_events_patient_idx").on(t.patientId),
  journeyIdx: index("timeline_events_journey_idx").on(t.journeyId),
  occurredIdx: index("timeline_events_occurred_idx").on(t.occurredAt),
}));

// ---------------------------------------------------------------------------
// Inbox — PulseOS-native conversation shell (Group P). Demo/persisted data
// only in this checkpoint; no live channel provider is wired yet.
// ---------------------------------------------------------------------------

export const conversationChannelEnum = pgEnum("conversation_channel", ["WHATSAPP", "CALL", "SMS", "EMAIL", "INTERNAL"]);
export const ownershipStateEnum = pgEnum("ownership_state", [
  "AI_ACTIVE", "HUMAN_REQUIRED", "HUMAN_ASSIGNED", "HUMAN_ACTIVE", "AI_RESUME_PENDING", "CLOSED",
]);

export const conversations = pgTable("conversations", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  patientId: uuid("patient_id").notNull().references(() => patients.id),
  journeyId: uuid("journey_id").references(() => journeys.id),
  channel: conversationChannelEnum("channel").notNull().default("WHATSAPP"),
  ownershipState: ownershipStateEnum("ownership_state").notNull().default("AI_ACTIVE"),
  assignedTo: uuid("assigned_to").references(() => users.id),
  lastMessageAt: timestamp("last_message_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // Which live connector this thread belongs to (Group T). Null for demo-seed
  // conversations that never touched a real provider.
  connectorId: uuid("connector_id").references(() => connectors.id),
  // The provider's own thread/account identity (e.g. WhatsApp wa_id), used to
  // resolve an inbound webhook back to this conversation without re-deriving
  // it from the patient's phone number every time.
  externalThreadId: text("external_thread_id"),
  // Which hospital WhatsApp number this thread is on. Nullable — existing
  // rows and any tenant with only one number never populate this; it only
  // matters once a tenant configures more than one WhatsApp endpoint.
  communicationEndpointId: uuid("communication_endpoint_id").references(() => communicationEndpoints.id),
  // Conversation sessions (summaries). summary_due_at is the ONLY source of truth for "when is this idle
  // enough to summarize": every message pushes it out by the tenant idle window, a due-job runner claims
  // it with a conditional update, so it survives restarts and never runs twice.
  summaryDueAt: timestamp("summary_due_at", { withTimezone: true }),
  summaryState: text("summary_state").notNull().default("idle"),
  summaryAttempts: integer("summary_attempts").notNull().default(0),
  summaryClaimedAt: timestamp("summary_claimed_at", { withTimezone: true }),
  summaryError: text("summary_error"),
  // The WhatsApp customer-service window: last patient message + 24h.
  lastPatientInboundAt: timestamp("last_patient_inbound_at", { withTimezone: true }),
}, (t) => ({
  tenantIdx: index("conversations_tenant_idx").on(t.tenantId),
  summaryDueIdx: index("conversations_summary_due_idx").on(t.summaryDueAt),
  patientIdx: index("conversations_patient_idx").on(t.patientId),
  // Widened from (connectorId, externalThreadId): under one WABA, the same
  // patient (externalThreadId = their wa_id) can legitimately message two
  // different hospital numbers — without the endpoint in the key, those two
  // genuinely separate conversations would collide into one.
  //
  // Endpoint resolution is now live (whatsapp-webhook.service.ts resolves
  // and stamps communicationEndpointId from the real metadata.phone_number_id,
  // and findOrCreateConversation's SELECT matches on it too, so the app-level
  // guard and this index agree). REMAINING, still-live risk: Postgres treats
  // every NULL as distinct for uniqueness, so for any still-endpoint-less
  // conversation (no CommunicationEndpoint configured for that line yet) the
  // DB-level race backstop is weaker than for a resolved one — two
  // concurrent inbound webhooks for the same (connectorId, externalThreadId,
  // endpoint=NULL) could both pass this index. The app-level find-or-create
  // SELECT-then-INSERT in whatsapp-webhook.service.ts (now NULL-aware via
  // isNull()) remains the real duplicate guard for that case, same as before
  // this column existed.
  externalThreadUnique: uniqueIndex("conversations_connector_endpoint_external_thread_unique").on(t.connectorId, t.communicationEndpointId, t.externalThreadId),
}));

// Configuration/scheduling preference only — there is no agent runtime yet
// to actually act on "ai_scheduled". One row per conversation (upserted),
// honestly representing what a human has asked for, not what is executing.
export const conversationAutomationModeEnum = pgEnum("conversation_automation_mode", ["manual", "ai_when_available", "ai_scheduled"]);

export const conversationAutomationPreferences = pgTable("conversation_automation_preferences", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  conversationId: uuid("conversation_id").notNull().references(() => conversations.id),
  mode: conversationAutomationModeEnum("mode").notNull().default("manual"),
  scheduledStart: timestamp("scheduled_start", { withTimezone: true }),
  scheduledEnd: timestamp("scheduled_end", { withTimezone: true }),
  timezone: text("timezone"),
  updatedBy: uuid("updated_by").references(() => users.id),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  tenantIdx: index("conversation_automation_preferences_tenant_idx").on(t.tenantId),
  conversationUnique: uniqueIndex("conversation_automation_preferences_conversation_unique").on(t.conversationId),
}));

// One row per tenant of small hospital-wide settings (conversation idle window, 5-10 minutes, default 7).
export const tenantSettings = pgTable("tenant_settings", {
  tenantId: uuid("tenant_id").primaryKey().references(() => tenants.id),
  conversationIdleMinutes: integer("conversation_idle_minutes").notNull().default(7),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const messageSenderEnum = pgEnum("message_sender", ["patient", "staff", "ai", "system"]);
export const messageDeliveryStatusEnum = pgEnum("message_delivery_status", ["queued", "sent", "delivered", "read", "failed"]);

export const messages = pgTable("messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  conversationId: uuid("conversation_id").notNull().references(() => conversations.id),
  senderType: messageSenderEnum("sender_type").notNull(),
  senderUserId: uuid("sender_user_id").references(() => users.id),
  body: text("body").notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
  readAt: timestamp("read_at", { withTimezone: true }),
  // Live-transport metadata (Group T). Null for staff-composed/system/demo-seed
  // messages that never touched a real provider.
  connectorId: uuid("connector_id").references(() => connectors.id),
  providerMessageId: text("provider_message_id"),
  deliveryStatus: messageDeliveryStatusEnum("delivery_status"),
}, (t) => ({
  conversationIdx: index("messages_conversation_idx").on(t.conversationId),
  providerMessageUnique: uniqueIndex("messages_connector_provider_message_unique").on(t.connectorId, t.providerMessageId),
}));

// A derived summary of one conversation session (messages between two idle gaps). Raw messages stay
// authoritative; this is never the source of truth and never replaces them. Scoped by tenant + conversation
// + patient (+ journey when the conversation is linked to one).
export const conversationSummaries = pgTable("conversation_summaries", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  conversationId: uuid("conversation_id").notNull().references(() => conversations.id),
  patientId: uuid("patient_id").notNull().references(() => patients.id),
  journeyId: uuid("journey_id").references(() => journeys.id),
  segmentNo: integer("segment_no").notNull(),
  firstMessageId: uuid("first_message_id").notNull().references(() => messages.id),
  lastMessageId: uuid("last_message_id").notNull().references(() => messages.id),
  firstMessageAt: timestamp("first_message_at", { withTimezone: true }).notNull(),
  lastMessageAt: timestamp("last_message_at", { withTimezone: true }).notNull(),
  messageCount: integer("message_count").notNull(),
  summary: text("summary").notNull(),
  patientIntent: text("patient_intent"),
  serviceInterest: text("service_interest"),
  questions: jsonb("questions").notNull().default([]),
  outcome: text("outcome"),
  promisedAction: text("promised_action"),
  nextAction: text("next_action"),
  generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
  provider: text("provider").notNull(),
  mode: text("mode").notNull(),
}, (t) => ({
  conversationIdx: index("conversation_summaries_conversation_idx").on(t.conversationId),
  patientIdx: index("conversation_summaries_patient_idx").on(t.patientId),
  // Idempotency: a session ending at the same last message is summarized exactly once.
  sessionUnique: uniqueIndex("conversation_summaries_session_unique").on(t.conversationId, t.lastMessageId),
}));

// ---------------------------------------------------------------------------
// Connectors — provider-neutral adapter configuration (Group R). PulseOS core
// (Patient/Journey/Conversation/Timeline/Task) never depends on a specific
// provider; a Connector is the configured instance an adapter reads to talk to
// one. Secrets never live on this row — see connectorSecrets below.
// ---------------------------------------------------------------------------

export const connectorTypeEnum = pgEnum("connector_type", ["MESSAGING", "TELEPHONY", "ADS", "EMAIL", "STORAGE", "HIS", "ACQUISITION"]);
export const connectorStatusEnum = pgEnum("connector_status", ["NOT_CONFIGURED", "CONNECTING", "CONNECTED", "DEGRADED", "ERROR", "DISABLED"]);
// FIXTURE/SANDBOX/LIVE — never inferred, always the connector's actual
// provenance, so the UI can never visually imply a live production
// connection for a connector that is actually fixture- or sandbox-backed.
export const connectorModeEnum = pgEnum("connector_mode", ["FIXTURE", "SANDBOX", "LIVE"]);
export const connectorCapabilityEnum = pgEnum("connector_capability", [
  "SEND_MESSAGE", "RECEIVE_MESSAGE", "RECEIVE_STATUS",
  "INITIATE_CALL", "RECEIVE_CALL_EVENT", "FETCH_RECORDING", "RECEIVE_RECORDING", "RECEIVE_TRANSCRIPT",
  "RECEIVE_LEAD", "SYNC_CAMPAIGNS", "SYNC_AD_GROUPS", "SYNC_ADS", "SYNC_SPEND", "SYNC_PERFORMANCE",
  "RECEIVE_FORM", "EXPORT_CONVERSION",
]);

export const connectors = pgTable("connectors", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  type: connectorTypeEnum("type").notNull(),
  // Adapter-registry key (e.g. "whatsapp_meta_cloud", "runo") — never branched on
  // in domain logic, only used to look up the adapter implementation.
  provider: text("provider").notNull(),
  status: connectorStatusEnum("status").notNull().default("NOT_CONFIGURED"),
  mode: connectorModeEnum("mode").notNull().default("FIXTURE"),
  displayName: text("display_name").notNull(),
  capabilities: connectorCapabilityEnum("capabilities").array().notNull(),
  // Non-secret configuration only (phone_number_id, webhook path, account id...).
  configuration: jsonb("configuration"),
  lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
  lastEventAt: timestamp("last_event_at", { withTimezone: true }),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  tenantIdx: index("connectors_tenant_idx").on(t.tenantId),
  tenantProviderUnique: uniqueIndex("connectors_tenant_provider_unique").on(t.tenantId, t.provider),
}));

// ---------------------------------------------------------------------------
// Communication endpoints — the N-hospital-numbers-per-1-connector layer.
// A Connector stays 1-per-tenant-per-provider (it owns the single credential/
// webhook a provider actually gives you — one WABA webhook URL, one Runo API
// key — confirmed against both providers' real architecture, not assumed).
// A hospital can still have several phone/WhatsApp lines under that one
// connector (Main Line, Fertility Line, a WhatsApp number) — this table is
// that N side. Deliberately NOT unique per (tenantId) — many endpoints per
// tenant is the whole point.
// ---------------------------------------------------------------------------

export const communicationEndpointTypeEnum = pgEnum("communication_endpoint_type", ["PHONE", "WHATSAPP"]);

export const communicationEndpoints = pgTable("communication_endpoints", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  connectorId: uuid("connector_id").notNull().references(() => connectors.id),
  // Optional — not every number maps 1:1 to a branch (e.g. a specialty line
  // shared across branches).
  branchId: uuid("branch_id").references(() => branches.id),
  type: communicationEndpointTypeEnum("type").notNull(),
  // Denormalized from connectors.provider — cheap, avoids a join for the
  // common "which provider is this number on" read.
  provider: text("provider").notNull(),
  publicNumber: text("public_number").notNull(),
  // The provider's own identifier for this specific number: WhatsApp's real
  // `phone_number_id` (confirmed present on every inbound webhook payload),
  // or — for Runo, which never exposes which SIM/line a call used (confirmed
  // against their live API) — a manual/config label an admin assigns, never
  // silently treated as provider-verified.
  providerRef: text("provider_ref").notNull(),
  displayLabel: text("display_label").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  // Attribution for calls that arrive on this line, configured by the hospital (never assumed): the Source a call through
  // this line inherits (a campaign, a health camp, the main reception...), a free-text source detail, and the department.
  // The branch is `branchId` above. All optional: a line with no mapping falls back to Phone.
  leadSourceId: uuid("lead_source_id").references(() => leadSources.id),
  sourceDetail: text("source_detail"),
  departmentId: uuid("department_id").references(() => departments.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  tenantIdx: index("communication_endpoints_tenant_idx").on(t.tenantId),
  connectorProviderRefUnique: uniqueIndex("communication_endpoints_connector_provider_ref_unique").on(t.connectorId, t.providerRef),
}));

// Google Business Profile aggregate listing performance — a dedicated table
// because this data is location-shaped, not campaign-shaped, and does not
// belong in marketing_campaigns. Deliberately has NO patientId/journeyId/
// touchpoint link of any kind: these are aggregate metrics for a Google
// Business listing, never a trackable event for an individual person, so
// nothing here can ever create or touch a Patient.
export const gbpPerformanceMetrics = pgTable("gbp_performance_metrics", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  connectorId: uuid("connector_id").notNull().references(() => connectors.id),
  metricDate: timestamp("metric_date", { withTimezone: true }).notNull(),
  impressions: integer("impressions"),
  clicks: integer("clicks"),
  searchImpressions: integer("search_impressions"),
  websiteClicks: integer("website_clicks"),
  callClicks: integer("call_clicks"),
  directionRequests: integer("direction_requests"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  tenantIdx: index("gbp_performance_metrics_tenant_idx").on(t.tenantId),
  connectorDateUnique: uniqueIndex("gbp_performance_metrics_connector_date_unique").on(t.connectorId, t.metricDate),
}));

// One encrypted blob per connector holding every secret field the adapter
// needs (access token, app secret, webhook verify token...). Decrypted only in
// memory at the point of use — never logged, never returned to the client.
export const connectorSecrets = pgTable("connector_secrets", {
  connectorId: uuid("connector_id").primaryKey().references(() => connectors.id),
  encryptedPayload: text("encrypted_payload").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const connectorEventDirectionEnum = pgEnum("connector_event_direction", ["inbound", "outbound"]);
export const connectorEventStatusEnum = pgEnum("connector_event_status", ["received", "processed", "failed", "duplicate"]);

// Idempotency + dead-letter visibility for every webhook/event a connector
// ingests or sends. The unique (connectorId, externalEventId) index is the
// actual idempotency guard — a duplicate insert is caught and recorded as
// "duplicate" rather than reprocessed.
export const connectorEvents = pgTable("connector_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  connectorId: uuid("connector_id").notNull().references(() => connectors.id),
  externalEventId: text("external_event_id").notNull(),
  direction: connectorEventDirectionEnum("direction").notNull(),
  status: connectorEventStatusEnum("status").notNull().default("received"),
  error: text("error"),
  payload: jsonb("payload"),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
}, (t) => ({
  connectorIdx: index("connector_events_connector_idx").on(t.connectorId),
  idempotencyUnique: uniqueIndex("connector_events_connector_external_unique").on(t.connectorId, t.externalEventId),
}));

// ---------------------------------------------------------------------------
// Disposition -> Next Action mappings. Tenant-scoped, connector-scoped,
// admin-editable. `action` is a fixed whitelist — arbitrary provider
// disposition text can never invoke an arbitrary backend action, only ever
// the exact whitelisted ones below with validated config.
// ---------------------------------------------------------------------------

export const dispositionActionEnum = pgEnum("disposition_action", ["CREATE_CALLBACK_TASK", "ADVANCE_JOURNEY_STAGE"]);

export const connectorDispositionMappings = pgTable("connector_disposition_mappings", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  connectorId: uuid("connector_id").notNull().references(() => connectors.id),
  providerDisposition: text("provider_disposition").notNull(),
  action: dispositionActionEnum("action").notNull(),
  actionConfig: jsonb("action_config").notNull(),
  createdBy: uuid("created_by").references(() => users.id),
  updatedBy: uuid("updated_by").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  connectorIdx: index("disposition_mappings_connector_idx").on(t.connectorId),
  uniquePerConnector: uniqueIndex("disposition_mappings_connector_disposition_unique").on(t.connectorId, t.providerDisposition),
}));

// Every create/update/delete of a connector config value (disposition
// mappings today; extensible to other admin-editable connector config)
// is recorded here — who, what changed, before/after.
export const connectorAuditActionEnum = pgEnum("connector_audit_action", ["CREATE", "UPDATE", "DELETE"]);

export const connectorConfigAuditEvents = pgTable("connector_config_audit_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  connectorId: uuid("connector_id").notNull().references(() => connectors.id),
  actorId: uuid("actor_id").notNull().references(() => users.id),
  entityType: text("entity_type").notNull(),
  entityId: uuid("entity_id").notNull(),
  action: connectorAuditActionEnum("action").notNull(),
  before: jsonb("before"),
  after: jsonb("after"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  connectorIdx: index("connector_audit_connector_idx").on(t.connectorId),
}));

// ---------------------------------------------------------------------------
// Telephony — provider-neutral call/interaction record (Group V/W).
// ---------------------------------------------------------------------------

export const callDirectionEnum = pgEnum("call_direction", ["inbound", "outbound"]);
export const callStatusEnum = pgEnum("call_status", ["completed", "missed", "no_answer", "busy", "failed"]);

// IVR: created by a provider webhook (connector + provider call id). MANUAL: logged by staff from a Journey
// (no connector, no provider id). Both are the same Call, in the same Timeline.
export const callOriginEnum = pgEnum("call_origin", ["IVR", "MANUAL"]);

export const calls = pgTable("calls", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  origin: callOriginEnum("origin").notNull().default("IVR"),
  // Provider-only concepts: null for a manually logged call.
  connectorId: uuid("connector_id").references(() => connectors.id),
  // Nullable: Runo never tells you which hospital line/SIM a call used
  // (confirmed against their real API) — most calls will have no resolvable
  // endpoint unless a tenant has configured a manual default for its Runo
  // connector. Never backfilled; existing rows stay null forever, correctly.
  communicationEndpointId: uuid("communication_endpoint_id").references(() => communicationEndpoints.id),
  patientId: uuid("patient_id").references(() => patients.id),
  journeyId: uuid("journey_id").references(() => journeys.id),
  externalCallId: text("external_call_id"),
  direction: callDirectionEnum("direction").notNull(),
  phone: text("phone").notNull(),
  status: callStatusEnum("status").notNull(),
  durationSeconds: integer("duration_seconds"),
  recordingUrl: text("recording_url"),
  disposition: text("disposition"),
  agentName: text("agent_name"),
  // HUMAN-authored and authoritative. Nothing derived (transcript, AI summary) is ever written here.
  staffFeedback: text("staff_feedback"),
  feedbackByUserId: uuid("feedback_by_user_id").references(() => users.id),
  feedbackAt: timestamp("feedback_at", { withTimezone: true }),
  outcomeId: uuid("outcome_id").references(() => crmOutcomes.id),
  loggedByUserId: uuid("logged_by_user_id").references(() => users.id),
  // WHO HANDLED this call (a provider agent mapped to a team member). Not the Journey's owner: answering one call never
  // reassigns the Journey.
  handledByUserId: uuid("handled_by_user_id").references(() => users.id),
  // The callback this call asked for (the one Task engine — no separate follow-up table).
  callbackTaskId: uuid("callback_task_id").references(() => tasks.id),
  // A double-tapped Save returns the first call instead of creating a second.
  idempotencyKey: text("idempotency_key"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  tenantIdx: index("calls_tenant_idx").on(t.tenantId),
  journeyIdx: index("calls_journey_idx").on(t.journeyId),
  requestKeyUnique: uniqueIndex("calls_tenant_idempotency_unique").on(t.tenantId, t.idempotencyKey).where(sql`${t.idempotencyKey} is not null`),
  patientIdx: index("calls_patient_idx").on(t.patientId),
  idempotencyUnique: uniqueIndex("calls_connector_external_unique").on(t.connectorId, t.externalCallId),
}));

// A provider's agent/member (as it names them) -> a PulseOS team member. Tenant- and connector-scoped, configured by a
// Super Admin. Mapping never changes who owns a Journey; it only records who handled a call.
export const connectorAgentMappings = pgTable("connector_agent_mappings", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  connectorId: uuid("connector_id").notNull().references(() => connectors.id),
  // As the provider shows it, and the normalised form calls are matched on.
  externalAgent: text("external_agent").notNull(),
  externalKey: text("external_key").notNull(),
  userId: uuid("user_id").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  connectorAgentUnique: uniqueIndex("connector_agent_mappings_connector_key_unique").on(t.connectorId, t.externalKey),
  tenantIdx: index("connector_agent_mappings_tenant_idx").on(t.tenantId),
}));

// Derived data about a call, kept apart from the call itself and from staff feedback. The recording is the
// authoritative record; the transcript is derived from it and the summary from the transcript. Each has its own
// status, so a failed summary never hides a good transcript and neither ever blocks the call.
export const callIntelStatusEnum = pgEnum("call_intel_status", ["PENDING", "PROCESSING", "COMPLETED", "FAILED", "NOT_CONFIGURED"]);

export const callIntelligence = pgTable("call_intelligence", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  callId: uuid("call_id").notNull().references(() => calls.id),
  transcriptStatus: callIntelStatusEnum("transcript_status").notNull().default("PENDING"),
  transcript: text("transcript"),
  transcriptProvider: text("transcript_provider"),
  // PROVIDER = the telephony provider sent it; FIXTURE = deterministic demo stand-in; AI = a real model.
  transcriptMode: text("transcript_mode"),
  summaryStatus: callIntelStatusEnum("summary_status").notNull().default("PENDING"),
  summary: text("summary"),
  summaryDetails: jsonb("summary_details"),
  summaryProvider: text("summary_provider"),
  summaryMode: text("summary_mode"),
  error: text("error"),
  attempts: integer("attempts").notNull().default(0),
  // DB-held schedule + claim, like conversation summaries: restart-safe and idempotent.
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  generatedAt: timestamp("generated_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  callUnique: uniqueIndex("call_intelligence_call_unique").on(t.callId),
  dueIdx: index("call_intelligence_due_idx").on(t.transcriptStatus, t.summaryStatus, t.nextAttemptAt),
}));

// ---------------------------------------------------------------------------
// Specialty templates + custom fields — lets a tenant configure per-specialty
// enquiry fields (e.g. Gynecology's EDD, Ophthalmology's Laterality) without
// forking the product or hard-coding columns onto `patients`/`journeys`.
// `specialtyTemplates` rows are never hard-deleted (only toggled `enabled` or
// a field `archived`) so historical journeys/values referencing a key by
// plain text (not a FK — see `journeys.specialtyKey` above) stay valid.
// ---------------------------------------------------------------------------

export const customFieldTypeEnum = pgEnum("custom_field_type", ["TEXT", "NUMBER", "DATE", "BOOLEAN", "SELECT", "MULTI_SELECT", "PHONE", "LONG_TEXT", "EMAIL", "DATETIME"]);

export const specialtyTemplates = pgTable("specialty_templates", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  key: text("key").notNull(),
  displayName: text("display_name").notNull(),
  defaultJourneyType: text("default_journey_type").notNull(),
  departmentId: uuid("department_id").references(() => departments.id),
  enabled: boolean("enabled").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  tenantIdx: index("specialty_templates_tenant_idx").on(t.tenantId),
  tenantKeyUnique: uniqueIndex("specialty_templates_tenant_key_unique").on(t.tenantId, t.key),
}));

// SYSTEM: platform-owned, cannot be archived or retyped by a tenant. TEMPLATE: installed with a department
// template, the tenant may customize or archive it. CUSTOM: created by the tenant.
export const fieldOriginEnum = pgEnum("field_origin", ["SYSTEM", "TEMPLATE", "CUSTOM"]);

export const customFieldDefinitions = pgTable("custom_field_definitions", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  specialtyKey: text("specialty_key").notNull(),
  key: text("key").notNull(),
  label: text("label").notNull(),
  fieldType: customFieldTypeEnum("field_type").notNull(),
  origin: fieldOriginEnum("origin").notNull().default("CUSTOM"),
  options: jsonb("options"),
  required: boolean("required").notNull().default(false),
  sortOrder: integer("sort_order").notNull().default(0),
  archived: boolean("archived").notNull().default(false),
  // CRM configuration: one definition, reused wherever it is placed. specialty_key "*" = every service.
  groupKey: text("group_key").notNull().default("enquiry_details"),
  placements: jsonb("placements").notNull().default(["add_lead", "journey_detail", "patient_360"]),
  defaultValue: jsonb("default_value"),
  visibleTo: text("visible_to").notNull().default("everyone"),
  // Behaviour (M7): see FieldRule / CrmFieldVm in @pulseos/types.
  readOnly: boolean("read_only").notNull().default(false),
  filterable: boolean("filterable").notNull().default(false),
  carryForward: boolean("carry_forward").notNull().default(false),
  rules: jsonb("rules").notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  tenantIdx: index("custom_field_definitions_tenant_idx").on(t.tenantId),
  specialtyIdx: index("custom_field_definitions_specialty_idx").on(t.tenantId, t.specialtyKey),
  tenantSpecialtyKeyUnique: uniqueIndex("custom_field_definitions_tenant_specialty_key_unique").on(t.tenantId, t.specialtyKey, t.key),
}));

// ---------------------------------------------------------------------------
// Treatment catalog — the procedures a tenant offers (e.g. LASIK, PRK, CXL),
// attached to a specialty by plain-text key exactly like custom_field_definitions.
// Rows are never hard-deleted (toggle is_active) so historical treatments keep
// their link. default_estimated_value is a demo/price-list hint, not billing.
// ---------------------------------------------------------------------------

export const treatmentDefinitions = pgTable("treatment_definitions", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  specialtyKey: text("specialty_key").notNull(),
  key: text("key").notNull(),
  label: text("label").notNull(),
  defaultEstimatedValue: integer("default_estimated_value"),
  isActive: boolean("is_active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  tenantSpecialtyIdx: index("treatment_definitions_tenant_specialty_idx").on(t.tenantId, t.specialtyKey),
  tenantKeyUnique: uniqueIndex("treatment_definitions_tenant_key_unique").on(t.tenantId, t.key),
}));

export const customFieldValues = pgTable("custom_field_values", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  journeyId: uuid("journey_id").notNull().references(() => journeys.id),
  fieldDefinitionId: uuid("field_definition_id").notNull().references(() => customFieldDefinitions.id),
  value: jsonb("value").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  journeyIdx: index("custom_field_values_journey_idx").on(t.journeyId),
  journeyFieldUnique: uniqueIndex("custom_field_values_journey_field_unique").on(t.journeyId, t.fieldDefinitionId),
}));

// ---------------------------------------------------------------------------
// Outbound webhooks (M7, Super Admin only): send selected real domain events to a hospital's own systems.
// The signing secret is encrypted like connector secrets and shown once at creation. One delivery row per
// (webhook, event): the unique index is the idempotency guard, so a repeated event never posts twice.
// ---------------------------------------------------------------------------

export const outboundWebhooks = pgTable("outbound_webhooks", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  name: text("name").notNull(),
  url: text("url").notNull(),
  endpointPath: text("endpoint_path"),
  httpMethod: text("http_method").notNull().default("POST"),
  headers: jsonb("headers").$type<Array<{ key: string; value: string }>>().notNull().default([]),
  payloadMapping: jsonb("payload_mapping").$type<Array<{ key: string; field: string; fallbackValue?: string | null }>>().notNull().default([]),
  webhookCategory: text("webhook_category").notNull().default("CUSTOM"),
  events: text("events").array().notNull(),
  // [{ field, op: "eq" | "neq" | "in", value }] — all must hold. Structured data, never an expression.
  conditions: jsonb("conditions").notNull().default([]),
  enabled: boolean("enabled").notNull().default(true),
  encryptedSecret: text("encrypted_secret").notNull(),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  tenantIdx: index("outbound_webhooks_tenant_idx").on(t.tenantId),
}));

export const outboundWebhookDeliveries = pgTable("outbound_webhook_deliveries", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  webhookId: uuid("webhook_id").notNull().references(() => outboundWebhooks.id, { onDelete: "cascade" }),
  eventType: text("event_type").notNull(),
  eventId: text("event_id").notNull(),
  // The exact JSON body that is (re)sent; no secrets, no patient free text beyond what the event carries.
  payload: jsonb("payload").notNull(),
  status: text("status").notNull().default("PENDING"), // PENDING | SENT | FAILED
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  responseStatus: integer("response_status"),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
}, (t) => ({
  idempotencyUnique: uniqueIndex("outbound_webhook_deliveries_webhook_event_unique").on(t.webhookId, t.eventId),
  dueIdx: index("outbound_webhook_deliveries_due_idx").on(t.status, t.nextAttemptAt),
  tenantIdx: index("outbound_webhook_deliveries_tenant_idx").on(t.tenantId, t.createdAt),
}));

// ---------------------------------------------------------------------------
// Notifications (M7). Appointment/surgery domain events → a rule decides what to send and when → one durable row per
// message (`notifications`) → a worker re-checks the visit and sends through the MessagingProvider adapter → provider
// delivery webhooks move the status forward. The unique idempotency key is the guard against sending anything twice.
// ---------------------------------------------------------------------------

export const messageTemplates = pgTable("message_templates", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  purpose: text("purpose").notNull(),
  name: text("name").notNull(),
  // The template name approved with the provider; outside the 24-hour window only approved templates may be sent.
  providerTemplateName: text("provider_template_name").notNull(),
  language: text("language").notNull().default("en"),
  body: text("body").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  tenantPurposeUnique: uniqueIndex("message_templates_tenant_purpose_unique").on(t.tenantId, t.purpose),
}));

export const notificationRules = pgTable("notification_rules", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  subject: text("subject").notNull(), // APPOINTMENT | SURGERY
  kind: text("kind").notNull(), // CONFIRMATION | REMINDER
  enabled: boolean("enabled").notNull().default(true),
  offsetValue: integer("offset_value").notNull(),
  offsetUnit: text("offset_unit").notNull(), // minutes | hours | days
  channel: text("channel").notNull().default("WHATSAPP"),
  templateId: uuid("template_id").references(() => messageTemplates.id, { onDelete: "set null" }),
  minGapMinutes: integer("min_gap_minutes").notNull().default(60),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  tenantIdx: index("notification_rules_tenant_idx").on(t.tenantId, t.subject),
}));

export const notifications = pgTable("notifications", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  ruleId: uuid("rule_id").references(() => notificationRules.id, { onDelete: "set null" }),
  templateId: uuid("template_id").references(() => messageTemplates.id, { onDelete: "set null" }),
  // APPOINTMENT | SURGERY | FOLLOW_UP (a message a staff member chose to send).
  subjectType: text("subject_type").notNull(),
  subjectId: uuid("subject_id").notNull(),
  // A notification is derived from a patient's journey and means nothing without it: when the journey/patient is deleted
  // (only data tools and tests ever do), its notifications go with it instead of blocking the delete.
  patientId: uuid("patient_id").notNull().references(() => patients.id, { onDelete: "cascade" }),
  journeyId: uuid("journey_id").references(() => journeys.id, { onDelete: "cascade" }),
  channel: text("channel").notNull().default("WHATSAPP"),
  // The visit/surgery time this notification was planned against; if the visit has moved since, the worker cancels it.
  subjectAt: timestamp("subject_at", { withTimezone: true }),
  scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
  status: text("status").notNull().default("PENDING"),
  // BLOCKED / CANCELLED / FAILED reason: a stable code (e.g. RESCHEDULED, CAPABILITY_DISABLED, PROVIDER_NOT_CONFIGURED).
  reason: text("reason"),
  attempts: integer("attempts").notNull().default(0),
  providerMessageId: text("provider_message_id"),
  // The exact text that was (or would be) sent, kept so the message can be audited as the patient saw it.
  renderedText: text("rendered_text"),
  idempotencyKey: text("idempotency_key").notNull(),
  createdBy: uuid("created_by").references(() => users.id),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  readAt: timestamp("read_at", { withTimezone: true }),
  processingStartedAt: timestamp("processing_started_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idempotencyUnique: uniqueIndex("notifications_tenant_idempotency_unique").on(t.tenantId, t.idempotencyKey),
  dueIdx: index("notifications_due_idx").on(t.status, t.scheduledFor),
  subjectIdx: index("notifications_subject_idx").on(t.tenantId, t.subjectType, t.subjectId),
  providerMessageIdx: index("notifications_provider_message_idx").on(t.providerMessageId),
}));

// ---------------------------------------------------------------------------
// Ads reporting (M7): read-only, normalized, idempotent. One row per (provider, account, campaign, day); a re-sync of the same
// day overwrites it (providers restate recent days), so repeating a sync can never double-count spend.
// ---------------------------------------------------------------------------

export const adsDailyFacts = pgTable("ads_daily_facts", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  connectorId: uuid("connector_id").notNull().references(() => connectors.id),
  provider: text("provider").notNull(),
  accountId: text("account_id").notNull(),
  entityType: text("entity_type").notNull().default("CAMPAIGN"),
  entityId: text("entity_id").notNull(),
  entityName: text("entity_name").notNull(),
  factDate: date("fact_date", { mode: "string" }).notNull(),
  currency: text("currency").notNull().default("INR"),
  spend: numeric("spend", { precision: 14, scale: 2 }).notNull().default("0"),
  impressions: integer("impressions").notNull().default(0),
  clicks: integer("clicks").notNull().default(0),
  providerConversions: numeric("provider_conversions", { precision: 14, scale: 2 }),
  // Meta: raw action_type -> count. Which of them counts as a lead is the hospital's mapping, applied when reading.
  actions: jsonb("actions"),
  syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  naturalKey: uniqueIndex("ads_daily_facts_natural_unique").on(t.tenantId, t.provider, t.accountId, t.entityType, t.entityId, t.factDate),
  rangeIdx: index("ads_daily_facts_range_idx").on(t.tenantId, t.provider, t.factDate),
}));

export const adsSyncRuns = pgTable("ads_sync_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  connectorId: uuid("connector_id").notNull().references(() => connectors.id),
  provider: text("provider").notNull(),
  trigger: text("trigger").notNull(), // MANUAL | SCHEDULED
  status: text("status").notNull().default("RUNNING"), // RUNNING | SUCCEEDED | FAILED
  rangeFrom: date("range_from", { mode: "string" }).notNull(),
  rangeTo: date("range_to", { mode: "string" }).notNull(),
  rowsUpserted: integer("rows_upserted").notNull().default(0),
  attempts: integer("attempts").notNull().default(0),
  error: text("error"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
}, (t) => ({
  tenantProviderIdx: index("ads_sync_runs_tenant_provider_idx").on(t.tenantId, t.provider, t.startedAt),
}));

// ---------------------------------------------------------------------------
// Activity log (M7): who changed which setting, when. Admin-safe by construction: `metadata` is scrubbed of anything
// credential-shaped before it is stored, and only identifiers/flags of the change are kept (never values of secrets).
// ---------------------------------------------------------------------------

export const activityLog = pgTable("activity_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  actorId: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
  action: text("action").notNull(),
  entityType: text("entity_type").notNull(),
  entityKey: text("entity_key"),
  metadata: jsonb("metadata").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  tenantTimeIdx: index("activity_log_tenant_time_idx").on(t.tenantId, t.createdAt),
}));
