# PulseOS Greenfield Execution Amendment

- **Amends**: [2026-09-12-pulseos-greenfield-foundation-plan.md](2026-09-12-pulseos-greenfield-foundation-plan.md) (55 tasks, spread across M0–M16)
- **Purpose**: reach the first browser-judgeable UI faster by grouping compatible mechanical tasks into vertical execution groups, without dropping any test/acceptance criterion from the approved plan and without introducing new architecture.
- **Scope of this amendment**: only resequences/groups M0–M3 of the approved plan (workspace → auth → shell → Admin dashboard → Doctor dashboard). M4 onward (Patients, Journeys, Timeline, Tasks, Appointments, Treatment, Revenue, Inbox, Permissions, Adapters, Hardening) are unchanged and resume after Brain review of this checkpoint.

## Tech stack (locked per master execution prompt, supersedes the plan's "Changelog / Open Technical Choices")

- Node 24 LTS, pnpm workspaces, Turborepo
- Web: Next.js 16, React 19, TS strict, App Router, Tailwind CSS 4, Radix primitives, Lucide icons, TanStack Query + Table, React Hook Form, Zod, Recharts
- API: Fastify 5, TS strict, modular monolith, Zod validation, structured logging
- DB: PostgreSQL (local dev instance, already running), Drizzle ORM + migrations
- Testing: Vitest (unit/service/API), Playwright (critical browser flow)
- Auth: Argon2id password hashing, httpOnly session cookie, no localStorage/sessionStorage token

## Execution groups

| Group | Content (maps to plan tasks) | Commit boundary |
|---|---|---|
| 1 | Monorepo + quality baseline (M0.1–M0.4) | one or two commits |
| 2 | Postgres/Drizzle schema: Tenant, Branch, User, Role, Permission stub + API app skeleton (M0.2, part of M1.3) | one commit |
| 3 | Auth service (Argon2id, session cookie, role), seed script with demo tenant/branches/users (M1.3, M1.4) | one commit |
| 4 | Design tokens + UI primitives + Next.js app shell + login page + role-aware nav (M1.1, M1.2, M1.5) | one commit |
| 5 | Admin Command Centre: real aggregation schema (Patient/Journey/Task/Appointment minimal tables sufficient for real counts) + API + UI (M2.1–M2.5, using real minimal tables instead of throwaway stubs — this improves on the original plan's stub-then-repoint approach since we're grouping anyway) | one commit |
| 6 | Doctor Command Centre: aggregation API + UI (M3.1–M3.3) | one commit |
| 7 | Browser/E2E verification, screenshots, responsive/accessibility pass, quality gate | verification only, fix commits as needed |

**Ruling**: Group 5 builds real (not stub) minimal `Patient`, `Journey`, `Task`, `Appointment` tables — just enough columns for dashboard aggregation — rather than the original plan's disposable stub tables repointed later (M2.1's note, M4.4/M6.4/M8.3/M9.3 repoint steps). This is a pure implementation-efficiency ruling: it avoids writing and then discarding stub tables, and the full column sets for these entities are still added by the plan's own M4/M6/M8/M9 tasks when those modules run. No test or acceptance criterion is dropped — dashboard tests still assert against real seeded aggregate counts.

All test-first discipline, independent verification, and commit boundaries from the original plan are preserved within each group; each group still contains the same RED→GREEN→verify→commit cycle, just fewer standalone task write-ups.

First visual checkpoint = end of Group 7.

---

## Amendment 2 (2026-09-12): Marketing → Patient Journey Checkpoint

Product purpose refined per [north-star addendum](../specs/2026-09-12-pulseos-marketing-journey-northstar.md) — binding, supersedes any prior dashboard-as-generic-CRM framing. Base architecture (greenfield apps, dedicated `Journey` entity) unchanged.

Work for this checkpoint happens on an isolated worktree/branch (`worktree-marketing-journey-checkpoint`), not directly on `main`, per the process-gap fix from the first checkpoint's report.

New execution groups A–I (superseding the "next: M4" position from the first checkpoint's report):

| Group | Content |
|---|---|
| A | Process hardening — worktree isolation, ESLint config, Playwright config, this doc update |
| B | Marketing/attribution domain — `MarketingCampaign`, `CampaignTouchpoint`, `TimelineEvent`, `ConsultationOutcome`, `TreatmentOpportunity`, `RevenueEvent` tables + migration |
| C | Deterministic demo dataset extension + attribution formula service + formula tests |
| D | Admin Command Centre V2 — spend/funnel/spend-at-risk/source-performance |
| E | Patients + Patient 360 |
| F | Journeys + dashboard drill-down |
| G | Unified Timeline (persisted, displayed) |
| H | Doctor outcome workflow + attribution feedback loop |
| I | E2E + visual/content/accessibility polish + full checkpoint review |

Stops after Group I for Brain review, per instruction — M4.2 onward (Patients beyond what Group E covers, full M5–M16) resumes after that review.

---
🤖 Generated with [Claude Code](https://claude.com/claude-code)
