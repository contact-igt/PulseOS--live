# PulseOS Workspace — Repository Boundaries

- **Status**: Established by Plan Task 1 (M0)
- **Date**: 2026-09-12
- **Purpose**: record the confirmed, safe repository boundaries for all PulseOS implementation work, and the hazard this record exists to prevent.

## PulseOS workspace repo

- **Path**: `/Users/sushil/Documents/CODE FILES SUSHIL/PulseOS`
- **Created**: this task, via `git init` at this exact path
- **Confirmed toplevel**: `git rev-parse --show-toplevel` run from this path now returns this path itself (verified after `git init`, no longer falls through to `/Users/sushil`)
- **Scope**: holds `docs/superpowers/**` and any future workspace-level (non-application) planning artifacts only
- **`.gitignore`**: excludes `backend/`, `frontend/`, `invictus-chatbot/`, `whatnexus-frontend/`, `node_modules/` — guarantees the four nested project repos can never be accidentally tracked by this workspace-level repo, even via a broad `git add -A`

## Hazard: `/Users/sushil`

`/Users/sushil` (the user's home directory) is itself a pre-existing git repository — remote `origin` = `https://github.com/contact-igt/igt.git`, zero commits, discovered during the PulseOS discovery audit. It is **not** a PulseOS project repository.

**Rule, binding for all future PulseOS work**: no `git add`, `git commit`, `git push`, `git reset`, `git clean`, `git checkout`, or worktree operation for PulseOS work is ever run with cwd at `/Users/sushil` or any path outside the five repositories named in this document (the four project repos, plus this new PulseOS workspace repo). This new workspace repo's creation directly removes the need to ever fall through to `/Users/sushil` for documentation work — verified above.

## The four project repositories

| Repo | Confirmed root (`git rev-parse --show-toplevel`) | Branch | HEAD |
|---|---|---|---|
| Lead Panel backend | `/Users/sushil/Documents/CODE FILES SUSHIL/PulseOS/backend` | `development` | `22b081198f54bb3f3a987b36c5c46dcb1a5175d0` |
| Lead Panel frontend | `/Users/sushil/Documents/CODE FILES SUSHIL/PulseOS/frontend` | `development` | `bf187207fcc1c6cc2dbe65709bd3a4f40a42524d` |
| PulseOS backend (WhatsNexus) | `/Users/sushil/Documents/CODE FILES SUSHIL/PulseOS/invictus-chatbot` | `main` | `19e75667b4060af245739a62bb668d86c6b906a6` |
| PulseOS frontend (WhatsNexus) | `/Users/sushil/Documents/CODE FILES SUSHIL/PulseOS/whatnexus-frontend` | `main` | `88b9dcce74809b41c20a2a2a65608f7dfdb0a1e8` |

Each of the four `git -C <repo> rev-parse --show-toplevel` commands resolves to that repo's own directory, confirming each is genuinely its own independent git repository and none fall through to `/Users/sushil` or to this new workspace repo.

## Pre-existing dirty state (captured before any PulseOS implementation)

All four repos carry pre-existing uncommitted changes from the earlier local-setup session (running `npm approve-scripts` to approve native-module install scripts), predating any PulseOS work:

| Repo | Dirty files | Nature of change |
|---|---|---|
| `backend` | `package.json` | adds an `"allowScripts"` block (`bcrypt@6.0.0`, `fsevents@2.3.3`) |
| `frontend` | `package.json`, `package-lock.json` | adds an `"allowScripts"` block; lockfile has an unrelated transitive dependency removal (`tailwindcss`'s nested `yaml`) |
| `invictus-chatbot` | `package.json` | adds an `"allowScripts"` block (`protobufjs`, `sharp`, `bcrypt`, `ffmpeg-static`, `fsevents`, `msgpackr-extract`) |
| `whatnexus-frontend` | `package.json` | adds an `"allowScripts"` block (`esbuild`, `fsevents`, `sharp`, `tesseract.js`, `unrs-resolver`) |

Full diffs were inspected (`git -C <repo> diff -- package.json package-lock.json`) and confirmed to contain **only** these `allowScripts` additions and the one unrelated lockfile entry noted above — no other content. This record exists so that no future PulseOS commit in `invictus-chatbot` or `whatnexus-frontend` (the two repos PulseOS implementation will touch) can be mistaken for having introduced these changes. Per the plan, isolating these into their own dedicated commits happens in Task 3, not this task — Task 1 only records and protects them; no file has been staged, committed, reset, stashed, or cleaned in any of the four repos by this task.

## Worktree isolation policy

- **Status**: Established by Plan Task 2 (M0)

**Detection performed**: confirmed the current session is not already inside an isolated worktree for either implementation repo — `invictus-chatbot/.git` and `whatnexus-frontend/.git` are both ordinary directories (`file invictus-chatbot/.git` / `file whatnexus-frontend/.git` → `directory`), not `gitdir:`-pointer files, which is what a worktree checkout would show instead.

**Native tooling availability**: Claude Code's native isolation tooling (`EnterWorktree` / `ExitWorktree`) is confirmed available and loadable in this environment. Per its own documentation, it creates a new git worktree inside `.claude/worktrees/` on a new branch, scoped to "the current repository or, in a multi-repo workspace, a repository nested inside it" — directly matching this workspace's shape (the PulseOS workspace repo containing four nested project repos).

**Policy, binding for all future code-touching tasks in this plan**:

1. `invictus-chatbot` and `whatnexus-frontend` are the only two repos this plan modifies with application code (per the approved spec's backend/frontend foundation decision). Every task that edits files inside either of them must first call `EnterWorktree`, scoped individually to that specific repo (cwd/context pinned to `invictus-chatbot` or to `whatnexus-frontend` respectively) — never to the PulseOS workspace root and never to `/Users/sushil`.
2. `backend` and `frontend` (Lead Panel) remain selective-port *reference* sources only, per the approved spec (§2.3 of the design spec, and Task 3/M0 of the plan) — no implementation task writes into them, so no worktree is needed for them under this plan.
3. **Fallback, only if native tooling is ever unavailable in a future execution context**: `git -C invictus-chatbot worktree add ../invictus-chatbot-pulseos-work -b pulseos/foundation` and the equivalent `git -C whatnexus-frontend worktree add ../whatnexus-frontend-pulseos-work -b pulseos/foundation`, with all implementation performed inside those worktree directories rather than the original clones. Any such fallback worktree directory must be verified as git-ignored/excluded from the PulseOS workspace repo's tracking before use (this workspace repo's `.gitignore` already excludes `invictus-chatbot/` and `whatnexus-frontend/` themselves; a sibling `../invictus-chatbot-pulseos-work` directory would sit outside the PulseOS workspace repo entirely and requires no additional ignore rule, but must still never be created inside `/Users/sushil` directly — always as a sibling of the existing repo clone).
4. No worktree of any kind is created by this task (Task 2) — this section records policy only, per the plan's exact Task 2 scope. The first task that actually enters a worktree is the first later task that edits application code inside `invictus-chatbot` or `whatnexus-frontend`.
5. No destructive git operation (`reset`, `clean`, force-checkout) is ever performed as part of entering or exiting a worktree under this policy.

## Worktree safety resolution (established before Task 5, prototype build loop)

Before any code-touching task began, the native-vs-manual worktree question from item 3 above was resolved:

- Checked `~/.claude/settings.json` for a `worktree.baseRef` override — **none found**, meaning `EnterWorktree` would run at its documented default, `fresh` (branches from `origin/<default-branch>`).
- Our two PulseOS baseline commits — `invictus-chatbot` at `0e27a1232adeb4d5738b203bed7b58ccfa915608` and `whatnexus-frontend` at `c327d1ca20c2edea6d95ac8e16927a091d2cef6d` — are **local-only, never pushed to origin**. A `fresh`-mode worktree would silently branch from `origin/main`, dropping both baseline commits (including the demo tenant seed script) from the isolated branch.
- Since `head` mode could not be positively confirmed as active, per the established fallback, both worktrees were created manually and deterministically instead: `git -C invictus-chatbot worktree add ../invictus-chatbot-pulseos-work -b pulseos/foundation` and `git -C whatnexus-frontend worktree add ../whatnexus-frontend-pulseos-work -b pulseos/foundation` — `git worktree add -b <branch>` with no explicit start-point always branches from that repo's current local `HEAD`, which is git's own documented, unambiguous default (no origin involved at all).
- Verified after creation: both worktrees sit exactly at their expected local baseline commits, on a new `pulseos/foundation` branch, working tree clean; the original clones (`invictus-chatbot/`, `whatnexus-frontend/`) remain untouched on `main`.
- `.gitignore` updated to add `invictus-chatbot-pulseos-work/` and `whatnexus-frontend-pulseos-work/`, so neither worktree directory is ever tracked by the PulseOS workspace repo.
- Each worktree's untracked runtime files (`.env`/`.env.local`, `node_modules/`) were copied from the corresponding original clone — worktrees share git history but not untracked files — and a dependency-resolution sanity check (`node -e "require(...)"` for core backend/frontend packages) passed in both.

| Worktree | Path | Branch | Rooted at |
|---|---|---|---|
| Backend implementation | `invictus-chatbot-pulseos-work/` | `pulseos/foundation` | `0e27a1232adeb4d5738b203bed7b58ccfa915608` |
| Frontend implementation | `whatnexus-frontend-pulseos-work/` | `pulseos/foundation` | `c327d1ca20c2edea6d95ac8e16927a091d2cef6d` |

**From here forward, all PulseOS implementation (Tasks 5–20 and beyond) happens inside these two worktree directories only** — never in the original `invictus-chatbot/`/`whatnexus-frontend/` clones (which stay on `main`, serving as the clean reference/rollback copies), never in `backend/`/`frontend/` (reference-only, untouched), and never at `/Users/sushil`.

## PulseOS baseline commits (established by Plan Task 3, M0)

The pre-existing `npm approve-scripts` dependency-approval changes (documented above) have been isolated into their own dedicated commits in the two repos PulseOS implementation touches. Full diffs were snapshotted to patch files before committing, for permanent attribution evidence: [`backend-pre-existing.patch`](backend-pre-existing.patch), [`frontend-pre-existing.patch`](frontend-pre-existing.patch), [`invictus-chatbot-pre-existing.patch`](invictus-chatbot-pre-existing.patch), [`whatnexus-frontend-pre-existing.patch`](whatnexus-frontend-pre-existing.patch).

| Repo | Isolating commit | New HEAD (= PulseOS baseline) |
|---|---|---|
| `invictus-chatbot` | `6852396 chore: capture pre-existing npm approve-scripts changes (not PulseOS work)` | `6852396f6aec75f9ae032520e46057f80d148ee3` |
| `whatnexus-frontend` | `c327d1c chore: capture pre-existing npm approve-scripts changes (not PulseOS work)` | `c327d1ca20c2edea6d95ac8e16927a091d2cef6d` |

Per the approved spec, `backend` and `frontend` receive no commits during PulseOS implementation — they remain selective-port reference sources only. Their pre-existing dirty `package.json`/`package-lock.json` changes remain uncommitted in their working trees exactly as before, unchanged by this task; their original HEAD hashes (`22b081198f54bb3f3a987b36c5c46dcb1a5175d0` for `backend`, `bf187207fcc1c6cc2dbe65709bd3a4f40a42524d` for `frontend`, both recorded above) are still current.

**Binding rule from here forward**: every subsequent PulseOS implementation task in `invictus-chatbot` diffs against `6852396f6aec75f9ae032520e46057f80d148ee3`, and every subsequent task in `whatnexus-frontend` diffs against `c327d1ca20c2edea6d95ac8e16927a091d2cef6d`. Any commit in either repo prior to these two hashes is pre-existing, non-PulseOS work; any commit after them is PulseOS work.

## Demo hospital tenant (established by Plan Task 4, M0)

Seeded in `invictus-chatbot` via `src/scripts/seedPulseOsDemoTenant.js` (`npm run seed:pulseos-demo`), reusing the existing `createTenantService`/`createTenantUserService`/`generateReadableIdFromLast` functions rather than hand-rolled logic. Idempotent — re-running the script detects the existing row by `owner_email` and skips, verified by re-run with no duplicate rows created.

| Field | Value |
|---|---|
| `tenant_id` | `TT001` |
| `tenant_user_id` (tenant_admin login) | `TTU001` |
| `tenants.type` | `hospital` |
| `tenants.industry_type` | `healthcare` |
| `tenants.subscription_plan` | `basic` (lowest existing tier, model default) |
| `tenants.status` | `active` |
| Demo admin email | `invictusautomation.igt+pulseos-demo@gmail.com` (env: `PULSEOS_DEMO_ADMIN_EMAIL`) |
| Demo admin credentials | see `invictus-chatbot/.env` (`PULSEOS_DEMO_ADMIN_*`, gitignored, not committed) |

Every later prototype task that needs a demo tenant/journey context reuses `tenant_id: "TT001"` and `tenant_user_id: "TTU001"` rather than seeding a second one.
