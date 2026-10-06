# Deploying the API on Railway — checklist

PulseOS is hosted by the team that runs it. This page lists what the **API service** needs. It names variables only;
never paste a value into a ticket, chat, commit or log.

## Required environment variables (API service)

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection. Production only — **never** point a local `.env` or a test run at it. |
| `SESSION_SECRET` | Session signing. |
| `WEB_ORIGIN` | The web app's origin (CSRF/CORS check). |
| `PUBLIC_API_BASE_URL` | Public API base URL shown in webhook URLs given to providers (CCS, Runo, WhatsApp). |
| `CONNECTOR_ENCRYPTION_KEY` | **Required whenever connector credentials are saved or read** — CCS IVR, Runo, WhatsApp, Google/Meta Ads, outbound webhooks. |
| `TRUST_PROXY`, `COOKIE_SAMESITE` | Behind Railway's proxy / cross-domain cookies. See `apps/api/.env.example` for the rest. |

### `CONNECTOR_ENCRYPTION_KEY`

- It encrypts every stored connector credential (AES-256-GCM). Stored credentials are only readable with the **same value**
  that saved them.
- **If it is missing** the API still starts, and logs `CONNECTOR_ENCRYPTION_KEY is not set` at startup. Saving a credential
  then answers `503 encryption_not_configured` (the screen says secure credential storage isn't set up), inbound CCS/Runo
  webhooks answer 503 so the provider retries, and ads sync reports the same code. This was the cause of the CCS IVR
  "Could not save: internal_error" on Railway.
- **If its value changes**, every previously stored credential becomes unreadable (`secrets_unreadable`): integrations show
  *Saved · unreadable*, inbound webhooks are refused and ads sync stops, until each credential is re-entered.

> **Changing this key requires connector-secret re-entry or an explicit key-rotation migration.** Do not rotate it casually,
> and do not "fix" a missing key by inventing a new value if credentials already exist — use the original value.

Setting it (manual step, by the person who holds the value): Railway → API service → Variables → add
`CONNECTOR_ENCRYPTION_KEY` → the service redeploys itself. No database migration is involved.

## CCS IVR (Express IVR) webhook authentication — fails closed

The CCS webhook (`/webhooks/ccs/<connector id>`) no longer accepts call reports it cannot authenticate:

- At least one of the **API Key / Secret Key / Integration Key** must be saved in Settings → Integrations → CCS IVR → Credentials.
  With none saved, the webhook is *Not ready* and refuses every request (401).
- Every call report must **present** a saved key: in a header (`x-api-key`, `secret-key`, `integration-key`) or in the
  query string/body (`api_key`, `secret_key`, `integration_key`). A wrong key is refused even if another one matches.
- If CCS Express IVR cannot add headers, append the key to the webhook URL pasted into CCS:
  `…/webhooks/ccs/<connector id>?api_key=<API key>`. PulseOS redacts credential query parameters from its request logs and
  never stores them with the event or call.
- **Cut-over check:** before relying on this build, make sure the webhook configured at ccs.ivrsms.com sends a saved key.
  Until it does, new call reports are refused (401) rather than silently accepted.

## Database migration 0043 (CCS call ingestion)

This release adds migration `0043_ccs_call_ingestion` (additive only: five nullable columns and one new table, no data rewritten).
Run `pnpm db:migrate` against the production database **before** the new API starts serving, from a trusted shell. It is the
operator's step: nothing in the repository or the test tooling runs it against production.
Order: take a backup or snapshot -> `pnpm db:migrate` -> deploy the API -> set up lines and agents under Integrations -> CCS IVR -> Lines & team.

## Before a release

- [ ] `CONNECTOR_ENCRYPTION_KEY` present on the API service (name only — check the Variables tab, don't print it).
- [ ] `pnpm db:migrate` run if the release contains a new migration (this one does: 0043, see above).
- [ ] Tests ran against a **local/disposable** Postgres. The API test runner refuses non-local hosts
      (`apps/api/src/test-setup`); set `PULSEOS_TEST_ALLOW_REMOTE_DB=1` only for a deliberately disposable remote DB.
- [ ] CCS webhook sends a saved key (see above).
