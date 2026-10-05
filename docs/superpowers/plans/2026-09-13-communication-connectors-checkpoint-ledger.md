# PulseOS — Communication Connectors Checkpoint Ledger

Branch: `feature/communication-connectors`, from `main` @ `dd51eb6` (post Hospital-Operations-checkpoint merge).

Scope: Connector architecture, Integrations UI, live WhatsApp transport, provider-neutral
telephony ingestion, human ownership integration with Inbox, Timeline integration,
production-shaped retry/idempotency/security foundations. See design spec §16 (Integration
Adapters) — `WhatsAppProvider`/`TelephonyProvider` were already anticipated there.

Explicitly out of scope this checkpoint: Meta/Google Ads, Google Business, live AI voice,
full AI agent runtime, HIS/EMR, mobile app.

## Groups

| Group | Scope | Status |
|---|---|---|
| R | Connector domain model, encrypted-secret boundary, adapter registry | pending |
| S | `/integrations` UI | pending |
| T | Live WhatsApp connector (Meta Cloud API adapter) | pending |
| U | Inbox live ownership (claim/assign/release, real transitions) | pending |
| V | Telephony provider foundation + Runo inbound adapter | pending |
| W | Call feedback → Next Action disposition mapping | pending |
| X | Reliability + security (idempotency, retry-safe, tenant isolation) | pending |
| Y | UI/E2E checkpoint verification + screenshots | pending |

## Key decisions log

- Reference repos (`invictus-chatbot`, `backend`/`frontend` for Runo/Lead Panel) are read-only —
  never a runtime dependency. Patterns are ported into PulseOS-native adapters.
- No live Meta/Runo credentials are available in this local dev environment — WhatsApp/Runo
  flows are verified against provider-shaped fixture webhook payloads, not real provider
  traffic. This will be reported explicitly as FIXTURE, never claimed as LIVE.
- Secrets: new `packages`-level (or `apps/api/src/domain/security`) AES-256-GCM
  encrypt/decrypt utility, keyed by a new `CONNECTOR_ENCRYPTION_KEY` env var — separate from
  `SESSION_SECRET`. Connector rows never store plaintext secrets.
