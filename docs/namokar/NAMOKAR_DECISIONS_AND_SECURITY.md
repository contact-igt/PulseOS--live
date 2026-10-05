# Decisions and security notes

## Super Admin
`SUPER_ADMIN` in PulseOS is **per hospital** (it lives on a user of one tenant), not platform-wide. So Namokar's owner (`namokar.superadmin`) is a real Super Admin with full access **inside Namokar only**; tenant isolation is unchanged. No platform-global role was created or needed.

## Revenue
`REVENUE_TRACKING` is a tenant capability, on by default in every edition (other hospitals are unaffected) and **off for Namokar by the hospital's own setting** (a row in `tenant_capabilities`, which beats any edition default). Off means: no revenue event is written when a treatment completes; the Today strip, service lines, Patient 360, Journey, Treatments, Journeys list, Doctor Home and the procedures export carry no rupee figure (the API returns `null`, never `0`); revenue/ROAS analytics are refused (403) because marketing analytics now depend on revenue tracking. Only a Super Admin can change it.

## Tenant sign-in
Namokar uses the standard PulseOS tenant-branded login (one shared page, branding from `tenant_login_configs`); see [tenant-branded-login](../tenant-branded-login.md). `POST /auth/login/tenant/:slug`: the hospital comes from the route on the server (`tenants.login_slug`, unique, shape-checked); a user of another hospital cannot sign in; a shared email resolves to this hospital's account; the body is strict (a smuggled `tenantId` is refused); attempts are throttled per hospital + account; unknown slug and wrong password are indistinguishable. Sign-up and development hospitals have no slug and cannot be reached this way. Developer access (dev login) does not exist on this route and does not exist at all unless `ENABLE_DEV_LOGIN=true` outside production.

## Permissions added
`COMPLETE_CONSULTATION` (Doctor): complete **their own** visit only (checked on the server). Outcomes are recorded only for a **completed** visit, once, by the doctor it is with (or Super Admin).

## Treatment outcome
A workflow record, not a clinical one. Labels are fixed in code for the pilot (not yet editable per hospital) — that is a known limitation.

## Still open / not part of the pilot
Live Meta / Google ingestion, live Runo and WhatsApp credentials, CCS IVR, a production deployment target (none exists; localhost is not a deployment), hospital-editable outcome labels.
