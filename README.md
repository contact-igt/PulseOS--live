# PulseOS

Patient Engagement and Revenue Intelligence Operating System for Indian hospitals. Project rules, locked decisions and
the design system live in [CLAUDE.md](CLAUDE.md); demo data in [docs/demo-environments.md](docs/demo-environments.md).

**Namokar Eye & Oculoplasty Centre pilot (V1):** own sign-in page `/login/namokar`, revenue tracking off, owner Performance view.
Every hospital workspace has its own branded sign-in (`/login/<slug>`, [architecture](docs/tenant-branded-login.md)). Start at [docs/namokar/README.md](docs/namokar/README.md) (workflow, roles, daily SOP, quick start, routing, website intake).

## Requirements

| Tool | Version |
|---|---|
| Node | 24 (locked in CLAUDE.md). The test suites and build were also verified on Node 22.22. |
| pnpm | 9.15 (`packageManager` in `package.json`) |
| PostgreSQL | 16 (a local database named `pulseos` or `pulseos_<suffix>` — the seed refuses anything else) |

## First run

```bash
pnpm install
cp apps/api/.env.example apps/api/.env      # set DATABASE_URL, DEMO_PASSWORD, SESSION_SECRET, CONNECTOR_ENCRYPTION_KEY
cp apps/web/.env.example apps/web/.env.local # NEXT_PUBLIC_API_URL (defaults to http://localhost:4310)
pnpm db:migrate
pnpm db:seed
pnpm dev                                     # API http://localhost:4310 · web http://localhost:3310
```

Health check: `curl http://localhost:4310/health`. Sign in at `http://localhost:3310/login` with a demo account
(`eyev1.admin@pulseos.local`, …) and the `DEMO_PASSWORD` you set. Never commit `.env` files.

## Checks

```bash
pnpm typecheck && pnpm lint && pnpm build
pnpm test                                    # unit + API integration (needs the seeded local database)
```

End-to-end (Playwright, `apps/web/e2e`) runs against the running dev servers and a seeded database:

```bash
cd apps/web
DEMO_PASSWORD=… E2E_DATABASE_URL=postgres://user:pass@localhost:5432/pulseos_dev npx playwright test
```

`PLAYWRIGHT_BASE_URL` (default `http://localhost:3310`) and `PLAYWRIGHT_API_URL` (default `http://localhost:4310`)
point the suite elsewhere. Screenshot specs write to `review-artifacts/` (gitignored).

## Time

Every "today", day boundary and displayed time is in the **hospital's** timezone (`tenants.timezone`, Asia/Kolkata for
the demo tenants) — never the server's or the browser's. The API test suite pins the process to UTC on purpose so a
server-clock bug cannot hide on an IST machine.
