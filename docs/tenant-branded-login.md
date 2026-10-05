# Tenant-branded login architecture

Every PulseOS hospital workspace has a **dedicated branded login URL**: `/login/<slug>` (e.g. `/login/namokar`). It is **one approved page** for all hospitals; only safe, structured data differs. Namokar is not a special case.

## Parts

| Part | Where | Notes |
|---|---|---|
| Route | `apps/web/app/login/[tenant]/page.tsx` | **Server Component.** Resolves the branding from the slug on the server, then renders the layout. No static file per tenant. Unknown slug → `notFound()` (HTTP 404, generic "Workspace not found"). |
| Layout | `components/login/TenantBrandedLogin.tsx` | No state, no hooks. PulseOS blue panel + icy workspace + white card; below `lg` a compact blue hero above the card. Takes the form as `children`. |
| Form | `components/login/TenantLoginForm.tsx` | The only Client Component: email, password, show/hide, Remember me, Sign in. Sends only `{email, password, remember}` to `POST /auth/login/tenant/:slug`. |
| Branding fetch | `lib/tenantBranding.ts` | Server-side `fetch` of `GET /auth/tenants/:slug`, validated with a `zod` schema that strips unknown fields and refuses an over-long value or a logo outside `/brand/`. |
| Public endpoint | `GET /auth/tenants/:slug` | Display words only (see below). 404 `{"error":"not_found"}` for anything that is not a workspace. |
| Data | `tenants.login_slug` (unique, `^[a-z][a-z0-9-]{1,38}[a-z0-9]$`) + `tenant_login_configs` | One optional row per hospital. Every column optional; defaults fill the rest. |

## Branding configuration (`tenant_login_configs`)

| Field | Used for | Default |
|---|---|---|
| (`tenants.name`) | the large headline, the logo's alt text | — |
| `short_name` (≤ 40) | "PulseOS × **Namokar**", "Namokar's PulseOS workspace" | first word of the name |
| `logo_path` | an approved mark, shown instead of the name | none → typographic name |
| `headline` (≤ 120) | the large line on the blue panel | the full name |
| `tagline` (≤ 160) | one operational line | "Every enquiry, call, appointment and follow-up in one place." |
| `badge_label` (≤ 24) | the small badge ("V1 Pilot", "Beta V2") and the quiet note on the panel | none → no badge |
| `support_text` (≤ 160) | under the card | "Need help? Contact your administrator." |

**Safe data only.** No HTML, CSS, script or colours. Text is rendered as text. The PulseOS blue/white design is the master; there is no per-client colour. Limits are enforced by `CHECK` constraints, by the API's zod schema on the web side and by React's escaping.

## Logos

A logo is a file of this app's own `apps/web/public/brand/` folder (`/brand/<name>.svg|png|webp`); the database refuses any other path or an outside URL (this also keeps the Content-Security-Policy closed). Use the client's **approved file as supplied** — never stretch, recolour, redraw or generate a mark. The page shows it at a fixed height with its own aspect ratio on a white chip. **No approved logo? Leave `logo_path` empty: the typographic name is the fallback and nothing is blocked.**

## Security boundary

* The tenant comes **only from the validated slug, on the server**. The browser never supplies a tenant id; the login body is strict (a `tenantId` is refused). A user of another hospital cannot sign in; a shared email resolves to this hospital's account; unknown slug and wrong password look the same.
* The public endpoint returns display fields only — never ids, edition, users, capabilities, integrations or secrets.
* **Developer Access never appears** on a branded page (it exists only on the internal `/login` route, and only when `ENABLE_DEV_LOGIN=true` outside production). No hospital list, no demo credentials.
* Remember me: ON = a 7-day server session with a persistent httpOnly cookie; OFF = the standard 12-hour session and a session cookie. No token or credential in browser storage.
* Signing out (or an expired session) returns to the hospital's own page (the session carries `loginSlug`; only a well-formed slug is followed).

## New hospitals

Sign-up generates a clean unique slug from the hospital's name (`ABC Eye Hospital` → `/login/abc-eye-hospital`; collisions get `-2`, reserved words never become a slug), creates the (empty) config row, and returns `workspace.loginPath`. The page works immediately; Developer Access (development only) lists the new hospital through the existing database-driven mechanism. No code or deploy is needed.

## Edition / pilot badge

Driven by `badge_label` only — nothing is hardcoded in the component. A production client may have none.

## Not built (on purpose)

Page builders, theme/colour editors, custom HTML/CSS, SSO, domain mapping, white-label e-mail, and a Settings screen to edit these words (change them in the database or the seed for now).
