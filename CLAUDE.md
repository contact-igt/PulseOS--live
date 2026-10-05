# PulseOS — Project Rules

## Product north star

> **"PulseOS is the Patient Engagement and Revenue Intelligence Operating System for Indian hospitals — connecting every enquiry, conversation, appointment, consultation, treatment and follow-up into one continuous patient journey."**
> Supporting line: **"Know where every patient came from, what happened next, what needs attention, and what revenue was generated."**

PulseOS is the full daily operational loop (enquiry → patient → journey → follow-up → appointment → check-in/waiting → consultation → treatment decision → treatment → post-care → next action) with source/cost/conversion/revenue as a continuous thread through it — not a generic hospital CRM, not an EMR/HIS, and not only a marketing analytics dashboard. Marketing attribution (Spend At Risk, ROAS, source performance) is a first-class layer, not the sole product purpose — see [north-star addendum](docs/superpowers/specs/2026-09-12-pulseos-marketing-journey-northstar.md) for the binding detail (operational loop, dashboard hierarchy, spend-at-risk definition, attribution formulas).

Greenfield India-first Patient Engagement CRM / Hospital Operations Command Centre, built around that north star.
Source of truth: [docs/superpowers/specs/2026-09-12-pulseos-greenfield-foundation-design.md](docs/superpowers/specs/2026-09-12-pulseos-greenfield-foundation-design.md), [north-star addendum](docs/superpowers/specs/2026-09-12-pulseos-marketing-journey-northstar.md), [docs/superpowers/plans/2026-09-12-pulseos-greenfield-foundation-plan.md](docs/superpowers/plans/2026-09-12-pulseos-greenfield-foundation-plan.md), execution amendment in the same `plans/` directory.

## Locked decisions
- `apps/web`/`apps/api` are new — never scaffolded from `whatnexus-frontend`/`invictus-chatbot`/Lead Panel.
- `Journey` is a dedicated first-class entity. Never Lead-as-Journey.
- Patient != Journey. A patient can have multiple concurrent journeys.

## Reference repos (read-only, never a runtime dependency)
`backend`, `frontend` (Lead Panel), `invictus-chatbot`, `whatnexus-frontend` (WhatsNexus), and their `-pulseos-work` variants. Extraction rule: read → identify dependencies → extract smallest useful unit → adapt to PulseOS interfaces → write a failing test first → verify independently. Never import wholesale.

## Stack (locked)
Node 24, pnpm workspaces, Turborepo. Web: Next.js 16 / React 19 / TS strict / App Router / Tailwind CSS 4 / Radix / Lucide / TanStack Query+Table / React Hook Form / Zod / Recharts. API: Fastify 5 / TS strict / modular monolith / Zod / Drizzle ORM / PostgreSQL. Testing: Vitest + Playwright. Auth: Argon2id, httpOnly session cookie, no token in localStorage/sessionStorage.

No MUI. No generic admin template. No decorative animation libraries. No microservices. Shared `packages/*` only when ≥2 real consumers need them.

## Design system
`DESIGN_VARIANCE=7`, `MOTION_INTENSITY=4`, `VISUAL_DENSITY=8` (revised 2026-09-13 UI redesign checkpoint — supersedes the earlier 5/3/7). Tokens live in `packages/design-tokens` (`--color-*` re-declared in `apps/web/app/globals.css` for Tailwind's `@theme`, since Tailwind reads CSS vars, not the TS export — keep both in sync). **Visual direction (2026-09-29, supersedes the flat Blue Finish): Apple-like material depth + enterprise healthcare + blue/white brand.** Blue, white and cool blue-white neutrals only — no purple/pink/decorative orange-yellow-green; semantic warning/danger only for operational status, never as brand decoration, and status is never colour-only. **Glass is structural and selective**: sidebar (floating light pale-blue glass rail), TopBar, search, floating filters, segmented controls, toolbars, popovers, dialog/drawer *chrome* — one shared material (`.glass` / `.glass-strong` / `.glass-control` in `globals.css`, with an `@supports` solid fallback, reduced/removed blur below 768px). Data content stays crisp: tables, analytics and forms are solid/near-solid white — never strong blur behind dense text. Surface hierarchy (`Card tone`): glass (structural) · white (default data panel) · info (light-blue secondary context) · emphasis (blue, rare — one anchor KPI/key state). Environmental depth comes only from layered CSS gradients on the app canvas (no bitmaps, video, animated blobs or full-screen blur). Tokens (brand scale, canvas, surfaces, glass, lines, ink, radius shell/panel/card/control/chip, shadow-glass/shadow-panel) live in `packages/design-tokens` and are re-declared in `globals.css` `@theme` — a vitest contract test keeps them in sync. Motion: hover 100–140ms, press 80–120ms, popover 140–180ms, drawer 180–220ms, no springs or ambient animation, honour `prefers-reduced-motion`. Brand: `PulseLockup` (`packages/ui/src/Brand.tsx`) — the journey-line "P" mark + quiet BETA; no cross/heart/sparkle/ECG icons. Still avoid giant KPI cards, brochure layouts, card-grid overload, emoji icons and generic AI-dashboard/glassmorphism-template looks. Shell geometry: sidebar ~220–232px, topbar ~60–64px, content gutter 24px desktop / 16px tablet.

## Domain ownership
PulseOS core owns Patient, Journey, Timeline/TimelineEvent, Task/NextAction, Appointment, MarketingCampaign, CampaignTouchpoint, ConsultationOutcome, TreatmentOpportunity, RevenueEvent, CustomField*, Pipeline/PipelineStage, Consent, AuditEvent. External systems are adapters (`WhatsAppProvider`, `TelephonyProvider`, `AdsProvider`, `LLMProvider`, `StorageProvider`, `HISConnector`) — never `if provider === "runo"` inside domain logic.

## Content wording
Prefer: Patient, Journey, Consultation, Treatment, Next Action, Spend At Risk, Marketing Spend, Attributed Revenue, Cost per Treatment. Avoid "Lead"/"Opportunity" outside technical/admin contexts. Never call recoverable active journeys "Marketing Waste" — that term is reserved for `CONFIRMED MARKETING LEAKAGE` (definitively lost journeys); active-but-stalled journeys are always "Spend At Risk."

## Skills / process references (condensed — do not re-fetch full contents per task)
- Superpowers (github.com/obra/superpowers): TDD, systematic debugging, worktree isolation, subagent-driven development, code review discipline. Not installed as a Claude Code plugin in this environment (no marketplace/skill entry available) — its *process* is followed manually: failing-test-first, isolated worktree per feature, one-hypothesis-at-a-time debugging, independent verification before claiming done.
- Ponytail (github.com/DietrichGebert/ponytail): minimal-code/YAGNI discipline — already reflected in "no shared package until ≥2 consumers" above.
- Emil Kowalski skills, Taste skill, Anthropic frontend-design, Vercel agent-skills: UI motion/taste/React reference — reflected in the Design system section below (functional-only transitions, restrained palette, no decorative charts).

## Process
TDD: failing test → minimal implementation → green → verify → commit. No production code without a failing test first (visual-only CSS/tokens use browser verification instead). Systematic debugging on unexpected failures — reproduce, read the full error, trace the diff, one hypothesis at a time; after 3 failed attempts, stop and reconsider the approach rather than keep patching. No completion claim without fresh evidence (tests, typecheck, lint, build, browser check all run just before claiming done).

## Security
Tenant isolation mandatory — never trust `tenant_id` from a request body, always derive from session. Server-side role/permission enforcement, not UI-only. No secrets committed (`.env` is gitignored; demo password comes from `DEMO_PASSWORD` env var, never hardcoded). Fictional demo data only, never real patient data.

## Local dev
- DB: local Postgres, `apps/api/.env` (copy from `.env.example`) sets `DATABASE_URL` + `DEMO_PASSWORD`.
- `pnpm db:migrate` then `pnpm db:seed` to populate demo data.
- `pnpm dev` runs both apps via Turborepo.
- Three separate demo tenants (password = local `DEMO_PASSWORD` value; every tenant also has a `*.superadmin@` account). The Beta V1 edition demo is **Ophthalmology V1**: `eyev1.admin@`, `eyev1.frontdesk@` … (core CRM only — Inbox, Campaigns, marketing Analytics and spend/ROAS are gated server-side by `tenants.edition`). **Gynecology Demo**: `gyn.admin@pulseos.local` (Hospital Admin), `gyn.doctor@pulseos.local` / `gyn.doctor2@pulseos.local` (Doctor), `gyn.frontdesk@pulseos.local`, `gyn.coordinator@pulseos.local`. **Ophthalmology Demo (V2)**: the same roles as `eye.admin@`, `eye.doctor@` / `eye.doctor2@`, `eye.frontdesk@`, `eye.coordinator@pulseos.local`. Developer Login (`ENABLE_DEV_LOGIN=true`) has a demo-environment selector. Demo data, seed guarantees and the multi-line Runo limitation: see `docs/demo-environments.md`.

## Local Runtime Handoff

PulseOS is hosted locally only — Claude Code must never deploy it to Vercel/Railway/Render/Fly.io or any remote service unless explicitly asked. Every meaningful implementation session must end with the app running locally and left available for the user to open, not just "started":

1. Confirm the correct worktree/branch/HEAD before touching any process — `pwd && git rev-parse --show-toplevel && git branch --show-current`. Never start an obsolete worktree, another PulseOS branch, or a legacy reference repo (WhatsNexus/Lead Panel/invictus-chatbot).
2. Check `lsof -nP -iTCP -sTCP:LISTEN | grep -E '3310|4310'` before starting anything. If something already owns the port: reuse it if it's the correct current worktree's process; if it's a stale PulseOS process (including one running from the wrong checkout — this has happened, and is diagnosed via `lsof -p <pid> | grep cwd`), kill only that one and restart from the correct worktree; if it belongs to another project, never kill it — use a different port and report the real URL.
3. Start API + web (`pnpm dev`, or the two apps separately), verify with a fresh HTTP request to each (API health endpoint, web root/login), then open `/login` in a browser and confirm it actually renders (no `ERR_CONNECTION_REFUSED`, no server-error screen, CSS/JS loaded) before claiming it works. A successful build or Playwright run is not proof the dev server is still up afterward — check again, live, right before reporting.
4. Leave both dev servers running when the task ends. Do not kill them as "cleanup." The user must be able to open the reported URL immediately.
5. Report actual detected ports/URLs — never assume or invent them — plus safe demo credentials (see accounts above; never output DB passwords, provider tokens, API keys, or encryption keys).
