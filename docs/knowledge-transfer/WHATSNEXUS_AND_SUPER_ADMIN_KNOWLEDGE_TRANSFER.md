# WhatsNexus and Super Admin — Complete Knowledge Transfer

Prepared: 17 November 2026. Inspected project: `C:\Invictus_Projects\Whatsnexus`, containing `invictus-chatbot` (backend) and `Whatnexus-frontend` (frontend). Companion: `PULSEOS_COMPLETE_KNOWLEDGE_TRANSFER.md`.

## 1. Scope, naming and evidence

The user referred to Whatnexus/Whatsnexus. The full paired project found locally is `Whatsnexus`; its frontend folder is spelled `Whatnexus-frontend`. Other siblings include `C:\Invictus_Projects\Whatnexus-frontend`, `Whatsnexus-2` and `whatsnexus-embedded`. They are separate copies/projects; this document does not merge their implementations or assume identical versions. PulseOS integration reports and the full management dashboard implementation exist in the selected paired project.

This is a source-based product/engineering handoff for uploading into ChatGPT. It combines inspected implementation with existing project reference documents. No seed, migration, production database query, login, provider message, email, charge, deployment or application test was executed. Features with code are distinguished from live operational verification. No `.env` secrets, personal account values or customer records are reproduced.

Future ChatGPT instructions: use this project's source paths; distinguish management users from tenant users; enforce backend authorization; never use human JWTs as PulseOS machine credentials; preserve idempotency and reconcile unknown send outcomes. Treat older overview documents as historical when package manifests or code differ.

## 2. What WhatsNexus does

WhatsNexus is a multi-tenant WhatsApp engagement and AI-assisted operations platform. Tenant businesses manage WhatsApp connections, conversations, contacts, leads, templates, campaigns, knowledge, appointments, staff and billing. Platform management users oversee organizations, access policies, pricing, wallets, subscriptions and operational health across tenants.

Code modules cover healthcare operations (doctors, specializations, branches and appointments) and education-related features (courses, sessions and mentors). The existence of these modules does not mean every tenant receives them: industry, plan, module and tenant-specific access controls determine availability.

WhatsNexus is also an optional messaging provider for PulseOS. PulseOS retains ownership of hospital journeys and follow-ups. WhatsNexus handles its WhatsApp/Meta delivery, approved templates, platform wallet/billing and delivery callback pipeline.

## 3. Technical architecture

| Layer | Inspected implementation |
|---|---|
| Backend | Node.js ES modules, Express 4, Sequelize 6, MySQL via mysql2 |
| Frontend | Next.js dependency `^16.2.2`, React `19.2.3`, TypeScript, App Router, Tailwind 4 |
| State | TanStack Query, Redux Toolkit, Redux Persist |
| Auth | bcrypt password hashes, bearer JWT access/refresh tokens, management/tenant identity distinction |
| Realtime | Socket.IO dependencies and chat features |
| Jobs | Bull/BullMQ, Redis/ioredis, node-cron and separate campaign-worker script |
| Providers/utilities | Meta/WhatsApp integrations, OpenAI/Groq-related dependencies, AWS S3, Nodemailer, Razorpay, file/audio/document processing |
| Tests | Jest/Supertest; dedicated billing and PulseOS unit/dispatch/MySQL regression scripts |

Dependencies show supported tooling, not proof that a deployed service uses every dependency. Existing `docs/super_admin_dashboard_overview.md` says Next.js 14; the inspected frontend manifest has Next.js 16.2.2 range and React 19.2.3, so the older overview is stale on framework version.

Backend request flow: `src/app.js` mounts routers → authentication and authorization → controller → service → Sequelize/MySQL/provider. Frontend pages render view components; service classes and React Query hooks load API data; Redux holds auth/user context. Background workers deliver campaigns and integration callbacks independently of page rendering.

### API namespace boundaries

| Base path | Purpose |
|---|---|
| `/api/management` | Management users, dashboard, logs, plans, modules, industry mappings and tenant access administration |
| `/api/management/ai-catalog` | AI model catalogue router |
| `/api/tenant` | Tenant organization/users/invitations and tenant-facing module/feature access |
| `/api/whatsapp` | Messaging, knowledge, contacts, leads, live chat, appointments, templates, campaigns, billing, healthcare/education modules and related services |
| `/api/integrations/pulseos` | Machine-to-machine integration API |
| `/api/management/integrations/pulseos` | Privileged provisioning and reconciliation of PulseOS integration |
| `/api/campaign/diagnostics` | Tenant campaign diagnostics with explicit tenant-role authorization |

Source: backend `src/app.js`. Router-local paths in the appendix must be combined with their actual mount point.

## 4. Tenant feature inventory

| Feature group | What the checked-out code exposes |
|---|---|
| WhatsApp onboarding/settings | WhatsApp account management, account status/quality, authentication and settings/playground surfaces |
| Chats and shared inbox | Conversation/message interfaces, live-chat operations, history, staff handoff and realtime communication components |
| Message composition | Text/media/template and interactive-button support; separate implementation references document button display and mapping |
| Contacts | Contact records, groups, group detail and campaign audiences |
| Leads/follow-ups | Leads and detail views, follow-up hub, reminders and related operational tracking |
| Appointments | Appointment records and tenant healthcare scheduling interfaces |
| Healthcare configuration | Branches, doctors, specializations and business knowledge |
| AI/knowledge | Knowledge-source management, prompts, playground, analysis/token usage and model catalogue/pricing infrastructure |
| Templates | WhatsApp template management and approval/rejection editing workflows |
| Gallery | Media assets and approval flow; implementation/reference documents exist |
| Campaigns | Create/list/detail, audience/template-based sending, status/diagnostics and background workers |
| Billing | Wallet/ledger/pricing/payment interfaces, platform billing and tenant billing variants |
| Team/profile/settings | Tenant staff/users, organization profile, preferences, AI settings and timezones |
| Education | Courses, sessions and mentors modules, subject to access mappings |
| Legal/public | Privacy, terms and data-deletion pages; account activation and password recovery |
| Reporting | Tenant dashboard and weekly summary views; separate platform command centre for management |

This table is an implementation inventory, not an end-to-end acceptance test. The exact current page/module inventories appear below. UI availability is subject to role, industry, plan and tenant-specific access, as well as provider and billing readiness.

## 5. Super Admin architecture: independent platform identity

WhatsNexus uses two identity domains:

| Identity | Storage/claims | Scope |
|---|---|---|
| Management | Management model/table; `user_type: management`; roles `super_admin` and `platform_admin`; normally `tenant_id: null` | Platform-wide administration |
| Tenant user | TenantUser model/table; `user_type: tenant`; tenant-bound ID and roles such as `tenant_admin`, `staff` | One business workspace |

Management Super Admin is independent of a customer's tenant. The JWT includes `id`, `unique_id`, `user_type`, `tenant_id`, `role`. For management, `unique_id` corresponds to readable `management_id`, with an `MG` prefix. This separation enables cross-tenant aggregation and controlled tenant provisioning without granting ordinary tenant users platform access.

This is materially different from PulseOS: PulseOS has a privileged tenant-bound `SUPER_ADMIN` hospital role, not the same independent management control plane. Reusing the name must not imply identical scope or database architecture.

## 6. Exactly how the first Super Admin is created

Authoritative file: backend `src/scripts/seedSuperAdmin.js`; npm script: `seed:superadmin`.

1. Load environment configuration with dotenv.
2. Read `SUPER_ADMIN_EMAIL`, `SUPER_ADMIN_USERNAME`, `SUPER_ADMIN_PASSWORD`, `SUPER_ADMIN_COUNTRY_CODE`, `SUPER_ADMIN_MOBILE`.
3. Set role `super_admin`, status `active`, and default title `Mr` in the seed object.
4. Call `db.sequelize.sync()`.
5. Query the Management table for **any** record with `role = 'super_admin'`, limit one.
6. If one exists, skip creation. The script does not rotate/reset that account's password or create another bootstrap account.
7. Hash the configured password with `bcrypt.hash(password, 10)`.
8. Generate a readable `management_id` using `generateReadableIdFromLast(..., 'management_id', 'MG')`.
9. Insert management ID, title, username, email, country code, mobile, password hash, role, status and timestamps using SQL replacements.
10. Print creation/skip status and identity details; the script refers users to the environment for the password rather than printing it.

Documented execution from the backend directory:

```powershell
npm run seed:superadmin
```

**This command was not run.** Use it only against an intended database after confirming environment and backup/migration policy. It calls schema sync, so it is more than a read-only account check. The bootstrap check is any super-admin row, without an active/non-deleted filter in the inspected script; an inactive/deleted super-admin record can therefore cause a skip. Required environment values must be supplied; the seed is not a complete configuration-validation wizard. Concurrent bootstrap races and all self-lockout cases were not tested in this task.

## 7. Creating additional administrators

After bootstrap, `POST /api/management/register` requires an authenticated management user with role `super_admin`.

The registration controller accepts username, email, country code, mobile and role, with optional title. Allowed roles are `platform_admin` and `super_admin`. It normalizes email/mobile, checks duplicates, generates an MG management ID and a random password, hashes the password with bcrypt cost 10, creates the record, and sends the `managementInvite` email template containing the generated initial password. The API responds with success text rather than returning that password in the response.

Operational implication: email delivery/configuration is part of administrator onboarding. The inspected flow sends an initial password by email; this is the actual implementation and should not be described as an invitation-link-only flow. SMTP behavior, forced first-login rotation and self/last-super-admin protection were not verified here.

Only Super Admin can register management users, soft-delete/restore/permanently delete management accounts, mutate pricing/AI pricing and manually credit wallets according to the inspected route file. Some management update routes allow both roles, so do not summarize Platform Admin as globally read-only. Controller/service restrictions must also be checked before treating a broad update route as unrestricted.

Sources: `ManagementModel/management.routes.js`, `management.controller.js`, `management.service.js`.

## 8. Management login, JWTs and backend enforcement

Frontend management sign-in: `/management/login`; recovery: `/management/forgotPassword`. Backend management login: `POST /api/management/login`.

Login normalizes email, trims password, requires active status, verifies bcrypt hash and issues management-context tokens. Access JWT lifetime is 24 hours; refresh JWT lifetime is 7 days. Shared auth code also defines 48-hour invitation tokens and 30-day remember-me tokens; their existence is not proof every management login uses them.

`authenticate` extracts bearer token, verifies signature and reloads the referenced management/tenant user to reject missing or inactive accounts. Tenant users additionally require an active tenant. `authorize({ user_type, roles })` enforces identity class and permitted role names. `authenticateAdmin` combines management checks for some routes.

**Source-review caveats:** authorization uses the role carried in the decoded JWT in the inspected middleware; the account status is refreshed from the database, but role changes are not visibly copied from the database into the decoded role there. Therefore do not promise immediate role-change revocation without checking token lifecycle. Refresh uses JWT verification and regenerates tokens from claims; do not claim dedicated token-type separation, rotation/revocation storage or MFA from this source. These are review areas, not proven exploits from this documentation exercise.

The frontend Redux auth persistence whitelist includes token, refreshToken and user, using session storage; the root Redux persistence uses local storage. This differs from PulseOS's httpOnly session-cookie policy. Do not copy the persisted JWT approach into PulseOS while claiming it follows PulseOS's locked auth architecture.

## 9. Super Admin vs Platform Admin permission summary

| Operation | Super Admin | Platform Admin | Source |
|---|---|---|---|
| Platform dashboard | Yes | Yes | SuperAdminDashboard router |
| Read management list/profile/preferences | Yes | Yes | Management router |
| Update management by ID | Route permits | Route permits | Controller restrictions must also be reviewed |
| Register management user | Yes | No | Management `/register` |
| Management soft delete, restore, permanent delete | Yes | No | Management lifecycle routes |
| Read message/AI pricing rules | Yes | Yes | Management pricing routes |
| Create/update/delete message/AI pricing | Yes | No | Management pricing routes |
| Inspect tenant wallet | Yes | Yes | Management wallet status |
| Manually credit tenant wallet | Yes | No | Management wallet credit |
| Create/list/update tenant, status, soft delete/restore, resend invitation | Yes | Yes | Tenant router |
| Permanently delete tenant | Yes | No | Tenant permanent delete |
| Industry/module/plan CRUD and mappings | Yes | Yes | ModuleAccess management router |
| Tenant feature/dynamic-access settings | Yes | Yes | TenantFeatureAccess and ModuleAccess routers |
| Read PulseOS integration/readiness/unresolved dispatches | Yes | Yes | PulseOS management router |
| Change/pair/rotate/replay/resolve PulseOS integration | Yes | No | PulseOS management write middleware |

This table reflects explicit route gates, not a full penetration test. Tenant routes under `/api/whatsapp` do not automatically accept management identity. A management quick-action button pointing at a tenant-oriented screen is not sufficient evidence of backend access.

## 10. Super Admin Command Center dashboard

Endpoint: `GET /api/management/dashboard?period=30days`. Auth: management JWT and `super_admin` or `platform_admin`. Backend chain: `superAdminDashboard.routes.js` → controller → `getSuperAdminDashboardStatsService` → Sequelize and raw MySQL aggregations. Frontend `/dashboard` selects the management dashboard for management users; tenant users get their tenant dashboard.

The service aggregates across tenants, not just one customer. Its 24 conceptual query sections are not necessarily 24 simultaneously executing SQL statements; some calls are parallel groups and others sequential.

| Data area | Returned/visualized information |
|---|---|
| Organizations | Total, active/inactive/deleted counts, new registrations and period comparison |
| Management | Super/platform administrator counts |
| Tenant users | Total and role distribution |
| Messages | Selected-period/current/previous/today volume |
| Leads | Totals and period/today changes |
| Campaigns | Counts and status distribution |
| WhatsApp accounts | Connected/disconnected totals and quality status |
| Top organizations | Five organizations ranked by message volume |
| Recent registrations | Recent tenant organizations and owner/context fields |
| Appointments | Period and today totals |
| Knowledge | Total/active sources |
| Wallets | Aggregate wallet balances |
| Live chat | Active chat counts and period totals |
| AI analysis | Analysis-log totals/type breakdown |
| Message chart | Last seven-day daily volume series |
| Subscription health | Status distribution and upcoming expirations |
| Revenue intelligence | BillingLedger cost totals by category and top contributing tenants |
| Platform live operations | Escalations, agents, active chats by tenant |
| WhatsApp quality map | Quality distribution and warning accounts |
| AI platform usage | Tokens, estimated costs, model and top-tenant usage |
| Tenant growth | Monthly registrations over twelve months |
| Alerts | Expired tenants, low-wallet count below INR 100 and disconnected accounts |
| Activity feed | Recent registrations/status/disconnection events composed from source tables |

Eight headline KPI cards cover organizations, platform messages, leads, system admins, tenant users, campaigns, WhatsApp accounts and live chats. Additional components include command bar, quick actions, volume chart, revenue panel, live operations, growth, platform health, subscription health, registrations, quality, AI usage and activity feed.

### Period and number semantics

Period options: `7days`, `30days`, `alltime`. Current service resolves start dates using JavaScript local date boundaries; alltime uses a null lower bound. Do not copy the older overview's epoch-start description as current implementation. A previous comparable window is generated for trend calculations when applicable. Daily message and twelve-month growth charts use their own fixed windows; active chats, account status and wallet balances are current snapshots rather than uniform period-filtered values.

The service uses server/SQL date functions; it has not been shown here to obey PulseOS's hospital-timezone reporting contract. Some period filters use a lower bound rather than a universal inclusive/exclusive date interval. Validate boundary semantics before comparing platform charts with hospital reports.

Revenue intelligence aggregates `BillingLedger.total_cost`. It is an operational billing measure, not automatically subscription cash receipts, bank reconciliation, net profit or GAAP-recognized revenue. AI costs are estimates based on recorded usage. An Operational badge is not a substitute for external infrastructure monitoring or an uptime probe.

### Actual frontend refresh behavior

`hooks/useSuperAdminDashboardQuery.tsx` uses query key `['super-admin-dashboard', period]`, enabled only with token and management identity. Current settings: 30-second stale time, two-minute refetch, no background refetch, refresh on focus and reconnect. The older overview states five-minute stale and ten-minute refetch; **current hook wins**. Cross-app mutations also invalidate the key through query-client helpers.

Frontend component sources: `components/views/superAdminDashboard/*`; API service: `services/superAdminDashboard*`. Existing detailed reference: `docs/super_admin_dashboard_overview.md`; use it for component context while checking stale values against code.

## 11. Organization lifecycle and access configuration

Management tenant routes expose organization creation/list/detail/update, activation/status changes, invitation listing/resending, onboarded listing, soft-deleted listing, restore and Super-Admin-only permanent deletion. Tenant-user activation and account activation pages complete onboarding; do not confuse a created tenant with a fully onboarded and connected customer.

There are related but distinct entitlement layers:

- Industry catalogue and industry-to-SaaS-module mapping.
- SaaS module catalogue.
- Plan catalogue and plan-to-module mapping.
- Per-tenant dynamic access and feature settings.
- User role checks, tenant active status, subscription/wallet/provider checks at execution time.

Management endpoints include `/industries`, `/saas-modules`, `/plans`, mapping subresources, `/tenants/:tenantId/dynamic-access` and `/tenant/:tenantId/features` under `/api/management`. Both management roles are allowed by those routers. Tenant-facing access routers expose resolved availability. Read their services before assuming override precedence, deny behavior or field shapes; this document does not invent an unverified precedence algorithm.

Frontend management pages cover organizations, platformAdmins, invited/onboarded/deleted lists, industries, SaaS modules, plans, industry mapping, plan mapping, tenant access and tenant dynamic access.

## 12. Pricing, wallet, billing and AI controls

Super Admin has explicit write authority over message pricing and AI pricing. Both management roles can read pricing and tenant wallet status. Manual wallet credit is Super-Admin-only. Billing modules, Razorpay/payment dependencies, ledger models and billing interfaces support the charging/payment domain, but provider credentials, webhooks and actual settlement were not tested.

AI model catalogue routes exist under management; usage is tracked per model and tenant in AI usage/analysis records. Tenant AI settings and knowledge sources control business-specific behavior. Price changes, provider costs, currency conversion and customer charges must be traced to their actual billing services rather than inferred from a dashboard label.

Sources: `ManagementModel`, `BillingModel`, `PaymentModel`, `AiModelCatalogModel`, `src/config/billing.config.js`, frontend billing/pricing views. Existing `npm run test:billing` checks a focused billing-access suite; it is not evidence of a complete accounting audit.

## 13. Super Admin PulseOS provisioning and recovery

Management integration base: `/api/management/integrations/pulseos`. Read access includes both management roles. Write operations require Super Admin. A validated `:tenantId` selects the WhatsNexus tenant; this is privileged platform provisioning, not arbitrary tenant selection by ordinary staff.

| Endpoint suffix | Purpose |
|---|---|
| `GET /:tenantId` | Safe integration view |
| `GET /:tenantId/readiness` | Readiness diagnostics |
| `POST /:tenantId/test-callback` | Test callback reachability/signature flow |
| `POST /:tenantId/pairing` | Create pairing code |
| `DELETE /:tenantId/pairing` | Cancel pairing |
| `PUT /:tenantId` | Update integration settings |
| `POST /:tenantId/api-key` | Rotate API key |
| `POST /:tenantId/callback-secret` | Rotate callback secret |
| `GET /:tenantId/dispatches/unresolved` | Inspect unknown/unresolved dispatches |
| `POST /:tenantId/dispatches/:dispatchId/resolve` | Resolve uncertain outcome |
| `POST /:tenantId/callbacks/replay-dead` | Replay dead callbacks |

Secrets are designed to be returned only once on rotation/pairing, not exposed in ordinary reads. Pairing binds the intended PulseOS hospital to the WhatsNexus tenant and callback destination. Rotation requires coordinated storage updates; never paste keys into browser-visible env vars or knowledge files.

## 14. Machine integration: PulseOS → WhatsNexus → Meta

Base: `/api/integrations/pulseos`. Machine auth uses `X-Tenant-Id` plus `X-Api-Key`; human JWTs are not accepted as this integration identity. Feature flag `PULSEOS_INTEGRATION_ENABLED` and per-tenant enablement gate new sends and health. Read-only dispatch lookup remains available for reconciliation after disabling sends.

| Method/path | Operation |
|---|---|
| `POST /pair` | Redeem pairing code; code itself is the credential, with tight IP/body limits |
| `GET /health` | Authenticated readiness/connectivity view |
| `GET /templates` | Approved template list |
| `POST /messages` | Template/message dispatch |
| `POST /text` | Text dispatch |
| `POST /media` | Media dispatch with separate body limit |
| `GET /dispatches/:externalId` | Read-only dispatch reconciliation |
| `GET /media/:mediaId` | Media retrieval through its own handler/authorization contract |

Delivery path: PulseOS durable notification/message → idempotent WhatsNexus dispatch → tenant/billing/template checks → Meta send → provider message ID → Meta webhook → WhatsNexus event/callback pipeline → HMAC-signed PulseOS callback → normalized message/notification state.

Important guarantees to preserve: idempotency keys; tenant binding; validated callbacks; safe secret handling; durable callback retries/dead-letter recovery; explicit unknown outcome; no duplicate send simply because a network request timed out. Text/media availability is still subject to WhatsApp policy/window and implementation checks; route presence does not override provider policy.

Integration sources: backend `src/models/IntegrationModel/*`; PulseOS `domain/connector/adapters/whatsnexus.ts`, `whatsnexus-callback.ts`, webhook routes and notification workers. Cross-project reports: `WHATSNEXUS_PULSEOS_IMPLEMENTATION_REPORT.md`, `WHATSNEXUS_PULSEOS_INTEGRATION_AUDIT.md`, `WHATSNEXUS_PULSEOS_POST_IMPLEMENTATION_VERIFICATION.md`, `LOCAL_MANUAL_TEST_GUIDE_PULSEOS_WHATSNEXUS.md`. Those reports are historical, not newly rerun acceptance evidence.

## 15. Operations and local setup

Two applications require separate dependency installation/configuration. Backend manifest scripts include:

```powershell
npm install
npm run start:dev
# Separately, when intended and configured:
npm run start:campaign-workers
```

Frontend scripts: `npm run dev`, `npm run build`, `npm run start`, `npm run lint`. Determine actual API URL and ports from configuration; this review did not start services or verify local URLs. MySQL is required for backend data, Redis for applicable queued work, SMTP for invitations/recovery, and provider/payment/storage credentials for the corresponding features.

Backend `build` is currently `npm install`, not a compilation or full validation pipeline. `db:truncate` is destructive and must not be used as routine setup. Seed/pricing scripts mutate data; inspect target configuration first. Test scripts include `test:billing`, `test:pulseos`, `test:pulseos:mysql`; MySQL suites need a suitable test database and may mutate fixtures. None were run here.

## 16. Findings and limitations to retain in future conversations

1. Current manifests and hooks supersede stale dashboard overview framework/refresh values.
2. Platform Admin is a substantial operational role, not merely a read-only dashboard viewer.
3. Some dashboard sections use fixed windows/current snapshots; a period toggle does not filter every number identically.
4. Ledger-derived revenue and estimated AI cost need clear labels; neither is automatically financial settlement/profit.
5. Bootstrap skips if any super-admin row exists and calls schema sync; it is not a password-reset tool.
6. Role changes/token refresh deserve focused review because middleware uses decoded role claims.
7. Redux-persist auth storage is a different security model from PulseOS; do not describe them as equivalent.
8. No independent proof here of MFA, SSO, per-action audit coverage, complete token revocation, backup restoration or production uptime.
9. Route exposure and UI screens prove implementation surface, not correct authorization on every nested data operation. A security audit would require controller/service and runtime checks.
10. Source inventories below include modules/pages with potentially specialized or legacy behavior. Module availability must be checked per tenant.

## 17. Source appendices

Paths below are relative to the selected paired WhatsNexus project. Router paths are local strings; apply mounts from section 3 and inspect middleware before use. Authorization can be inherited from shared hooks and arrays. This path index intentionally does not assign a role to each route; use the permission summary and actual middleware.

### Frontend page inventory

| URL (route groups omitted) | Source relative to Whatnexus-frontend |
|---|---|
| `/admin-billing` | `app/(protected)/admin-billing/page.tsx` |
| `/appointments` | `app/(protected)/appointments/page.tsx` |
| `/billing` | `app/(protected)/billing/page.tsx` |
| `/branches` | `app/(protected)/branches/page.tsx` |
| `/campaign/[id]` | `app/(protected)/campaign/[id]/page.tsx` |
| `/campaign` | `app/(protected)/campaign/page.tsx` |
| `/chats` | `app/(protected)/chats/page.tsx` |
| `/composeMessage` | `app/(protected)/composeMessage/page.tsx` |
| `/contacts/contacts` | `app/(protected)/contacts/contacts/page.tsx` |
| `/contacts/groups/[id]` | `app/(protected)/contacts/groups/[id]/page.tsx` |
| `/contacts/groups` | `app/(protected)/contacts/groups/page.tsx` |
| `/courses/mentors` | `app/(protected)/courses/mentors/page.tsx` |
| `/courses` | `app/(protected)/courses/page.tsx` |
| `/courses/sessions` | `app/(protected)/courses/sessions/page.tsx` |
| `/dashboard` | `app/(protected)/dashboard/page.tsx` |
| `/doctors` | `app/(protected)/doctors/page.tsx` |
| `/followup-hub/[id]` | `app/(protected)/followup-hub/[id]/page.tsx` |
| `/followup-hub` | `app/(protected)/followup-hub/page.tsx` |
| `/followups/[id]` | `app/(protected)/followups/[id]/page.tsx` |
| `/followups` | `app/(protected)/followups/page.tsx` |
| `/gallery` | `app/(protected)/gallery/page.tsx` |
| `/knowledge` | `app/(protected)/knowledge/page.tsx` |
| `/leads/[id]` | `app/(protected)/leads/[id]/page.tsx` |
| `/leads` | `app/(protected)/leads/page.tsx` |
| `/logic` | `app/(protected)/logic/page.tsx` |
| `/management/api-request-logs/[id]` | `app/(protected)/management/api-request-logs/[id]/page.tsx` |
| `/management/api-request-logs` | `app/(protected)/management/api-request-logs/page.tsx` |
| `/management/deleted` | `app/(protected)/management/deleted/page.tsx` |
| `/management/industries` | `app/(protected)/management/industries/page.tsx` |
| `/management/industry-module-mapping` | `app/(protected)/management/industry-module-mapping/page.tsx` |
| `/management/invitations` | `app/(protected)/management/invitations/page.tsx` |
| `/management/onboarded` | `app/(protected)/management/onboarded/page.tsx` |
| `/management/plan-module-mapping` | `app/(protected)/management/plan-module-mapping/page.tsx` |
| `/management/plans` | `app/(protected)/management/plans/page.tsx` |
| `/management/profile` | `app/(protected)/management/profile/page.tsx` |
| `/management/saas-modules` | `app/(protected)/management/saas-modules/page.tsx` |
| `/management/tenant-access` | `app/(protected)/management/tenant-access/page.tsx` |
| `/management/tenant-dynamic-access` | `app/(protected)/management/tenant-dynamic-access/page.tsx` |
| `/organizations` | `app/(protected)/organizations/page.tsx` |
| `/platformAdmins` | `app/(protected)/platformAdmins/page.tsx` |
| `/playground` | `app/(protected)/playground/page.tsx` |
| `/pricing` | `app/(protected)/pricing/page.tsx` |
| `/profile` | `app/(protected)/profile/page.tsx` |
| `/reminders` | `app/(protected)/reminders/page.tsx` |
| `/settings/general` | `app/(protected)/settings/general/page.tsx` |
| `/settings/whatsapp-playground` | `app/(protected)/settings/whatsapp-playground/page.tsx` |
| `/settings/whatsapp-settings` | `app/(protected)/settings/whatsapp-settings/page.tsx` |
| `/shared-inbox/history` | `app/(protected)/shared-inbox/history/page.tsx` |
| `/shared-inbox/live-chats` | `app/(protected)/shared-inbox/live-chats/page.tsx` |
| `/specialization` | `app/(protected)/specialization/page.tsx` |
| `/system` | `app/(protected)/system/page.tsx` |
| `/team` | `app/(protected)/team/page.tsx` |
| `/templates` | `app/(protected)/templates/page.tsx` |
| `/tenant/profile` | `app/(protected)/tenant/profile/page.tsx` |
| `/weeklySummary` | `app/(protected)/weeklySummary/page.tsx` |
| `/whatsapp-settings` | `app/(protected)/whatsapp-settings/page.tsx` |
| `/account/activate` | `app/(public)/account/activate/page.tsx` |
| `/dataDeletion` | `app/(public)/dataDeletion/page.tsx` |
| `/forgotPassword` | `app/(public)/forgotPassword/page.tsx` |
| `/login` | `app/(public)/login/page.tsx` |
| `/management/forgotPassword` | `app/(public)/management/forgotPassword/page.tsx` |
| `/management/login` | `app/(public)/management/login/page.tsx` |
| `/privacyPolicy` | `app/(public)/privacyPolicy/page.tsx` |
| `/termsAndConditions` | `app/(public)/termsAndConditions/page.tsx` |
| `/` | `app/page.tsx` |

### Backend model/module inventory

- `AiModelCatalogModel`
- `AiPrompt`
- `ApiRequestLogModel`
- `AppointmentModel`
- `AttachmentModel`
- `AuthWhatsapp`
- `BillingModel`
- `BranchModel`
- `ContactGroupModel`
- `ContactsModel`
- `CoursesModel`
- `DashboardModel`
- `DoctorModel`
- `Faq`
- `GalleryModel`
- `IntegrationModel`
- `Knowledge`
- `LeadsModel`
- `LiveChatModel`
- `ManagementModel`
- `MentorsModel`
- `Messages`
- `ModuleAccessModel`
- `OtpVerificationModel`
- `PaymentModel`
- `Playground`
- `SpecializationModel`
- `SuperAdminDashboardModel`
- `TenantFeatureAccessModel`
- `TenantInvitationModel`
- `TenantModel`
- `TenantSecretsModel`
- `TenantUserModel`
- `UserPreferencesModel`
- `WhatsappAccountModel`
- `WhatsappCampaignModel`
- `WhatsappTemplateModel`

### Backend route inventory

### `models/AiModelCatalogModel/catalog.routes.js`

- `GET /`
- `POST /sync`
- `PUT /:id`
- `POST /:id/test`
- `POST /:id/activate`
- `POST /:id/deactivate`

### `models/AiPrompt/aiprompt.routes.js`

- `POST /ai/completion`
- `POST /prompt`
- `GET /prompts/deleted/list`
- `GET /prompts`
- `GET /prompt/:id`
- `GET /prompt-active-lists`
- `PUT /prompt/:id`
- `PUT /prompt-active/:id`
- `POST /prompt/:id/restore`
- `DELETE /prompt/:id/soft`
- `DELETE /prompt/:id/permanent`

### `models/ApiRequestLogModel/apiRequestLog.routes.js`

- `GET /api-request-logs`

### `models/AppointmentModel/appointment.routes.js`

- `POST /appointment`
- `GET /appointment`
- `GET /appointment/contact/:contact_id`
- `PATCH /appointment/status/:appointment_id`
- `POST /appointment-outcome`
- `POST /appointment/complete-with-outcome`
- `POST /complete-with-outcome`
- `POST /appointment/noshow-with-action`
- `POST /noshow-with-action`
- `GET /appointment/availability`
- `GET /appointment/slots`
- `PUT /appointment/:appointment_id`
- `GET /appointment/:appointment_id/reminders`
- `GET /reminders`
- `GET /reminders/:id`
- `PUT /appointment/:appointment_id/reminders`
- `DELETE /appointment/:appointment_id`
- `DELETE /appointment/:appointment_id/soft`
- `DELETE /appointment/:appointment_id/permanent`
- `POST /appointment/:appointment_id/restore`
- `GET /appointments/deleted/list`
- `GET /appointment-reminder-rules`
- `PUT /appointment-reminder-rules`
- `GET /followup-hub`
- `GET /followup-hub/pending-count`
- `GET /followup-hub/:id`
- `PATCH /followup-hub/:id/retry`
- `PATCH /followup-hub/:id/reschedule`
- `POST /followup-hub/:id/send-now`

### `models/AttachmentModel/attachment.routes.js`

- `GET /attachments/proxy`

### `models/AuthWhatsapp/AuthWhatsapp.routes.js`

- `GET /webhook/:tenantId?`
- `POST /webhook/:tenantId?`

### `models/BillingModel/billing.routes.js`

- `GET /billing/gst-breakdown`
- `GET /billing/invoices/:id/pdf`
- `GET /admin/invoices/:id/pdf`
- `GET /billing/payments/:id/receipt-pdf`
- `GET /admin/payments/:id/receipt-pdf`
- `GET /billing/kpi`
- `GET /billing/ledger`
- `GET /billing/spend-chart`
- `GET /billing/wallet`
- `GET /billing/wallet/transactions`
- `GET /billing/pricing`
- `PUT /billing/pricing/:id`
- `GET /billing/template-stats`
- `GET /billing/campaign-stats`
- `GET /billing/ai-usage`
- `GET /billing/ai-models`
- `GET /billing/auto-recharge`
- `PUT /billing/auto-recharge`
- `GET /billing/wallet/status`
- `GET /billing/mode`
- `GET /billing/invoices`
- `GET /billing/invoices/:id`
- `POST /billing/invoices/:id/pay`
- `POST /billing/admin/force-unlock`
- `POST /billing/admin/manual-credit`
- `POST /billing/admin/invoice-close`
- `POST /billing/admin/change-mode`
- `GET /billing/admin/audit-log`
- `GET /billing/admin/health`
- `GET /billing/admin/tenants`
- `GET /billing/admin/tenant-overview`
- `POST /billing/admin/health/:id/resolve`
- `GET /billing/admin/health/unresolved`
- `PUT /billing/admin/usage-limits`
- `GET /billing/admin/gst/current`
- `GET /billing/admin/gst/list`
- `POST /billing/admin/gst/add`
- `POST /billing/admin/gst/activate`
- `POST /billing/admin/gst/deactivate`
- `PUT /billing/admin/gst/:id`
- `DELETE /billing/admin/gst/:id`

### `models/BranchModel/branch.routes.js`

- `POST /branch`
- `GET /branches`
- `GET /branches/deleted/list`
- `GET /branch/:branch_id`
- `PUT /branch/:branch_id`
- `GET /branch/:branch_id/doctors`
- `POST /branch/:branch_id/doctors`
- `DELETE /branch/:branch_id/doctors/:doctor_id`
- `DELETE /branch/:branch_id/soft`
- `POST /branch/:branch_id/restore`
- `DELETE /branch/:branch_id/permanent`

### `models/ContactGroupModel/contactGroup.routes.js`

- `POST /contact-group`
- `GET /contact-group/deleted/list`
- `GET /contact-group/list`
- `GET /contact-group/:group_id`
- `POST /contact-group/:group_id/restore`
- `GET /contact-group/:group_id/available-contacts`
- `PUT /contact-group/:group_id`
- `POST /contact-group/:group_id/add-contacts`
- `DELETE /contact-group/:group_id/contact/:contact_id`
- `DELETE /contact-group/:group_id/soft`
- `DELETE /contact-group/:group_id/permanent`

### `models/ContactsModel/contacts.routes.js`

- `POST /contact`
- `GET /contacts`
- `GET /contact/:contact_id`
- `PUT /contact/:contact_id`
- `DELETE /contact/:contact_id/soft`
- `DELETE /contact/:contact_id/permanent`
- `POST /contact/:contact_id/restore`
- `GET /contacts/deleted/list`
- `POST /contact/import`
- `PATCH /contact/:contact_id/silence`

### `models/CoursesModel/courses.routes.js`

- `POST /courses`
- `GET /courses`
- `GET /courses/:course_id`
- `PUT /courses/:course_id`
- `DELETE /courses/:course_id`

### `models/DashboardModel/dashboard.routes.js`

- `GET /dashboard`
- `GET /weekly-summary`
- `GET /weekly-summary/contact/:contactId?`

### `models/DoctorModel/doctor.routes.js`

- `POST /doctor`
- `GET /doctors`
- `GET /doctors/deleted/list`
- `GET /doctor/:doctor_id`
- `GET /doctor/:doctor_id/branches`
- `PUT /doctor/:doctor_id`
- `PUT /doctor/:doctor_id/branches`
- `DELETE /doctor/:doctor_id/soft`
- `DELETE /doctor/:doctor_id/permanent`
- `POST /doctor/:doctor_id/restore`

### `models/Faq/faq.routes.js`

- `GET /faq-reviews`
- `GET /faq-reviews/counts`
- `GET /faq-reviews/master-source`
- `POST /faq-reviews`
- `PUT /faq-reviews/:id`
- `PUT /faq-reviews/:id/publish`
- `PUT /faq-reviews/:id/toggle`
- `DELETE /faq-reviews/:id/soft`
- `GET /faq-reviews/knowledge-entries`
- `GET /faq-reviews/knowledge-entries/:id`
- `PUT /faq-reviews/knowledge-entries/:id`
- `DELETE /faq-reviews/knowledge-entries/:id`

### `models/GalleryModel/gallery.routes.js`

- `POST /gallery/upload`
- `GET /gallery`
- `GET /gallery/stats`
- `GET /gallery/deleted/list`
- `GET /gallery/:asset_id`
- `DELETE /gallery/:asset_id`
- `PATCH /gallery/:asset_id/tags`
- `POST /gallery/:asset_id/restore`
- `DELETE /gallery/:asset_id/permanent`
- `POST /media/upload`
- `GET /media`
- `GET /media/:asset_id`
- `DELETE /media/:asset_id`

### `models/IntegrationModel/pulseos.management.routes.js`

- `GET /:tenantId`
- `GET /:tenantId/readiness`
- `POST /:tenantId/test-callback`
- `POST /:tenantId/pairing`
- `DELETE /:tenantId/pairing`
- `PUT /:tenantId`
- `POST /:tenantId/api-key`
- `POST /:tenantId/callback-secret`
- `GET /:tenantId/dispatches/unresolved`
- `POST /:tenantId/dispatches/:dispatchId/resolve`
- `POST /:tenantId/callbacks/replay-dead`

### `models/IntegrationModel/pulseos.routes.js`

- `GET /media/:mediaId`
- `POST /pair`
- `GET /health`
- `GET /templates`
- `POST /messages`
- `POST /text`
- `POST /media`
- `GET /dispatches/:externalId`

### `models/Knowledge/knowledge.routes.js`

- `GET /knowledges/deleted/list`
- `POST /knowledge`
- `GET /knowledges`
- `GET /knowledge/:id`
- `PUT /knowledge/:id`
- `DELETE /knowledge/:id/soft`
- `DELETE /knowledge/:id/permanent`
- `POST /knowledge/:id/restore`
- `PUT /knowledge-status/:id`
- `POST /knowledge-search`

### `models/LeadsModel/leads.routes.js`

- `GET /leads`
- `GET /lead/:lead_id`
- `PUT /lead/:lead_id`
- `PUT /leads/bulk-update`
- `GET /leads-summary/:lead_id`
- `POST /lead-summary-bulk`
- `DELETE /lead/:lead_id/soft`
- `GET /leads/deleted/list`
- `POST /lead/:lead_id/restore`
- `DELETE /lead/:lead_id/permanent`

### `models/LiveChatModel/livechat.routes.js`

- `POST /live-chat`
- `GET /live-chats`
- `GET /history-chats`
- `POST /live-chat/claim`
- `PUT /live-chat/assign`
- `GET /live-chats/agents`

### `models/ManagementModel/management.routes.js`

- `POST /register`
- `POST /login`
- `GET /profile`
- `GET /preferences`
- `PUT /preferences`
- `GET /list`
- `GET /pricing`
- `POST /pricing`
- `PUT /pricing/:id`
- `DELETE /pricing/:id`
- `GET /ai-pricing`
- `POST /ai-pricing`
- `PUT /ai-pricing/:id`
- `DELETE /ai-pricing/:id`
- `GET /:id`
- `PUT /:id`
- `POST /refresh-token`
- `DELETE /:id/soft`
- `GET /deleted/list`
- `PUT /:id/restore`
- `DELETE /:id/permanent`
- `POST /forgot-password`
- `POST /verify-otp`
- `POST /reset-password`
- `GET /wallet/:tenant_id/status`
- `POST /wallet/credit`

### `models/MentorsModel/mentors.routes.js`

- `POST /courses/mentors`
- `GET /courses/mentors`
- `GET /courses/mentors/:mentor_id`
- `PUT /courses/mentors/:mentor_id`
- `DELETE /courses/mentors/:mentor_id`

### `models/Messages/messages.routes.js`

- `GET /chats`
- `GET /chats/:phone`
- `POST /chats/send`
- `POST /chats/send-template`
- `PUT /chats/mark`
- `POST /chats/suggest`
- `POST /chats/send-test`

### `models/ModuleAccessModel/moduleAccess.management.routes.js`

- `GET /industries`
- `POST /industries`
- `PATCH /industries/:industryId`
- `DELETE /industries/:industryId`
- `GET /saas-modules`
- `POST /saas-modules`
- `PATCH /saas-modules/:moduleId`
- `DELETE /saas-modules/:moduleId`
- `GET /plans`
- `POST /plans`
- `PATCH /plans/:planId`
- `DELETE /plans/:planId`
- `GET /industries/:industryId/saas-modules`
- `PATCH /industries/:industryId/saas-modules`
- `GET /plans/:planId/saas-modules`
- `PATCH /plans/:planId/saas-modules`
- `GET /tenants/:tenantId/dynamic-access`
- `PATCH /tenants/:tenantId/dynamic-access`

### `models/ModuleAccessModel/moduleAccess.tenant.routes.js`

- `GET /dynamic-access`
- `GET /dynamic-navigation`

### `models/OtpVerificationModel/otpverification.routes.js`

- `POST /whatsapp-otp/send`
- `POST /whatsapp-otp/verify`
- `GET /whatsapp-otp/status/:phone`

### `models/PaymentModel/payment.routes.js`

- `GET /payment/saved-method`
- `DELETE /payment/saved-method`
- `POST /payment/razorpay-webhook`
- `POST /payment/order`
- `POST /payment/invoice-order`
- `POST /payment/verify`
- `GET /payment/history`

### `models/Playground/playground.routes.js`

- `POST /playground/chat`
- `POST /playground/inbound`
- `GET /playground/knowledge-sources`

### `models/SpecializationModel/specialization.routes.js`

- `GET /specializations`
- `GET /specializations/deleted`
- `PATCH /specialization/:id/restore`
- `DELETE /specialization/:id/permanent`
- `GET /specialization/:id`
- `POST /specialization`
- `PUT /specialization/:id`
- `PATCH /specialization/:id/status`
- `DELETE /specialization/:id`

### `models/SuperAdminDashboardModel/superAdminDashboard.routes.js`

- `GET /dashboard`

### `models/TenantFeatureAccessModel/tenantFeatureAccess.management.routes.js`

- `GET /tenant/:tenantId/features`
- `PATCH /tenant/:tenantId/features`

### `models/TenantFeatureAccessModel/tenantFeatureAccess.tenant.routes.js`

- `GET /features`

### `models/TenantInvitationModel/tenantinvitation.routes.js`

- `GET /invite/verify`
- `POST /invite/accept`
- `POST /invite/reject`
- `POST /invite/set-password`

### `models/TenantModel/tenant.routes.js`

- `GET /invitations`
- `GET /onboarded`
- `GET /deleted-list`
- `POST /`
- `POST /validate-openai-key`
- `GET /list`
- `PUT /:id/status`
- `DELETE /:id/soft`
- `POST /:id/restore`
- `DELETE /:id/permanent`
- `POST /:tenant_user_id/resend-invite`
- `GET /:id/webhook-status`
- `GET /settings/general`
- `PATCH /settings/ai`
- `GET /settings/timezones`
- `GET /:id`
- `PUT /:id`

### `models/TenantUserModel/tenantuser.routes.js`

- `POST /user/create`
- `POST /user/login`
- `GET /user/profile`
- `GET /user/preferences`
- `PUT /user/preferences`
- `PUT /user/profile`
- `PUT /user/organization`
- `GET /user/list`
- `GET /user/:tenant_user_id`
- `PUT /user/:tenant_user_id`
- `DELETE /user/:tenant_user_id/soft`
- `GET /user/deleted/list`
- `PUT /user/:tenant_user_id/restore`
- `DELETE /user/:tenant_user_id/permanent`
- `POST /user/forgot-password`
- `POST /user/verify-otp`
- `POST /user/reset-password`

### `models/WhatsappAccountModel/whatsappAccount.routes.js`

- `GET /whatsapp/oauth/callback`
- `POST /whatsapp-account/manual`
- `GET /whatsapp-account`
- `GET /whatsapp-account/tier-limit`
- `POST /whatsapp-account/test`
- `PUT /whatsapp-account`
- `PUT /whatsapp-account/token`
- `POST /whatsapp-account/activate`
- `DELETE /whatsapp-account`
- `DELETE /whatsapp-account/permanent`
- `POST /whatsapp-account/subscribe-webhooks`

### `models/WhatsappCampaignModel/whatsappcampaign.routes.js`

- `GET x-campaign-event-secret`
- `POST /whatsapp-campaign`
- `POST /whatsapp-campaign/estimate-cost`
- `GET /whatsapp-campaign/list`
- `POST /whatsapp-campaign/upload-media`
- `GET /whatsapp-campaign`
- `GET /whatsapp-campaign/deleted/list`
- `GET /whatsapp-campaign/diagnostics`
- `POST /whatsapp-campaign/retry-recipients`
- `GET /whatsapp-campaign/:campaign_id`
- `GET /whatsapp-campaign/:campaign_id/export`
- `POST /whatsapp-campaign/:campaign_id/execute`
- `POST /whatsapp-campaign/:campaign_id/restore`
- `PATCH /whatsapp-campaign/:campaign_id/status`
- `POST /whatsapp-campaign/:campaign_id/status`
- `PATCH /whatsapp-campaign/:id/status`
- `POST /whatsapp-campaign/:id/status`
- `POST /whatsapp-campaign/event`
- `GET /whatsapp-campaign/:campaign_id/stats`
- `DELETE /whatsapp-campaign/:campaign_id/soft`
- `DELETE /whatsapp-campaign/:campaign_id/permanent`
- `POST /campaigns`
- `GET /campaigns`
- `GET /campaigns/:campaign_id`
- `PATCH /campaigns/:campaign_id/status`
- `POST /campaigns/:campaign_id/status`
- `DELETE /campaigns/:campaign_id`

### `models/WhatsappTemplateModel/whatsapptemplate.routes.js`

- `POST /whatsapp-template`
- `GET /whatsapp-templates/deleted/list`
- `POST /whatsapp-template/:template_id/submit`
- `GET /whatsapp-template/:template_id/sync`
- `POST /whatsapp-templates/sync`
- `GET /whatsapp-templates`
- `GET /whatsapp-template/:template_id`
- `PUT /whatsapp-template/:template_id`
- `POST /whatsapp-template/:template_id/resubmit`
- `POST /whatsapp-template/generate-ai`
- `POST /whatsapp-template/upload-media`
- `DELETE /whatsapp-template/:template_id/soft`
- `DELETE /whatsapp-template/:template_id/permanent`
- `POST /whatsapp-template/:template_id/restore`
- `POST /templates`
- `GET /templates`
- `GET /templates/:template_id`
- `PUT /templates/:template_id`
- `DELETE /templates/:template_id`

### Dashboard component inventory

- `Whatnexus-frontend/components/views/superAdminDashboard/aiPlatformUsage.tsx`
- `Whatnexus-frontend/components/views/superAdminDashboard/messageVolumeChart.tsx`
- `Whatnexus-frontend/components/views/superAdminDashboard/platformActivityFeed.tsx`
- `Whatnexus-frontend/components/views/superAdminDashboard/platformHealthPanel.tsx`
- `Whatnexus-frontend/components/views/superAdminDashboard/platformLiveOpsPanel.tsx`
- `Whatnexus-frontend/components/views/superAdminDashboard/quickActionsBar.tsx`
- `Whatnexus-frontend/components/views/superAdminDashboard/recentTenantsList.tsx`
- `Whatnexus-frontend/components/views/superAdminDashboard/revenueIntelligence.tsx`
- `Whatnexus-frontend/components/views/superAdminDashboard/subscriptionHealthPanel.tsx`
- `Whatnexus-frontend/components/views/superAdminDashboard/superAdminCommandBar.tsx`
- `Whatnexus-frontend/components/views/superAdminDashboard/superAdminDashboardView.tsx`
- `Whatnexus-frontend/components/views/superAdminDashboard/superAdminKpiLayer.tsx`
- `Whatnexus-frontend/components/views/superAdminDashboard/tenantGrowthChart.tsx`
- `Whatnexus-frontend/components/views/superAdminDashboard/topTenantsList.tsx`
- `Whatnexus-frontend/components/views/superAdminDashboard/whatsappQualityMap.tsx`

### Backend package scripts (names and commands)

```json
{
  "build": "npm install",
  "start:dev": "nodemon src/app.js",
  "seed:superadmin": "node src/scripts/seedSuperAdmin.js",
  "db:truncate": "node src/scripts/truncateAllTables.js",
  "seed:allprice": "node src/scripts/seed_all_pricing.js",
  "debug:campaign": "node src/scripts/debugCampaign.js",
  "debug:campaign:failed": "node src/scripts/debugCampaignFailed.js",
  "start:campaign-workers": "node src/scripts/startCampaignWorkers.js",
  "test:billing": "node --experimental-vm-modules node_modules/jest/bin/jest.js tests/billingAccess.service.test.js --runInBand",
  "test:pulseos": "node --experimental-vm-modules node_modules/jest/bin/jest.js tests/pulseos.unit.test.js tests/pulseos.dispatch.test.js tests/metaWebhook.test.js --runInBand",
  "test:pulseos:mysql": "node --experimental-vm-modules node_modules/jest/bin/jest.js tests/pulseos.mysql.test.js tests/pulseos.webhook.mysql.test.js tests/regression.mysql.test.js --runInBand --forceExit"
}
```

### Integration test inventory

- `invictus-chatbot/tests/appointmentEducationIntake.test.js`
- `invictus-chatbot/tests/appointmentTenantAccess.test.js`
- `invictus-chatbot/tests/billingAccess.service.test.js`
- `invictus-chatbot/tests/metaWebhook.test.js`
- `invictus-chatbot/tests/pulseos.dispatch.test.js`
- `invictus-chatbot/tests/pulseos.mysql.test.js`
- `invictus-chatbot/tests/pulseos.onboarding.mysql.test.js`
- `invictus-chatbot/tests/pulseos.pairing.test.js`
- `invictus-chatbot/tests/pulseos.readiness.test.js`
- `invictus-chatbot/tests/pulseos.unit.test.js`
- `invictus-chatbot/tests/pulseos.webhook.mysql.test.js`
- `invictus-chatbot/tests/regression.mysql.test.js`
