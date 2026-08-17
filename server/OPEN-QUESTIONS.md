# OPEN-QUESTIONS.md — Pending items for Kevin

Everything below is pending. The implementation agent MUST NOT implement across an unresolved item — see `AGENTS.md`. When Kevin answers, the design agent folds the answer into `SPEC-DESIGN-RECONCILED.md` (or a new `DECISIONS/` file) and removes the bullet here.

## Format

Each item:

- **Q:** the specific question
- **Why it matters:** what's blocked without an answer
- **Options considered:** short list; design agent's current lean marked `(lean)`
- **Impact if wrong:** what breaks or has to be redone

## Currently open

- **Q:** When an allowlisted email signs in for the first time, should the server auto-provision an `organization_memberships` row, and with what default `role` (`admin` / `director` / `scorer` / `viewer`)? Or are memberships seeded out-of-band (e.g. an admin-managed list / a migration), with sign-in refused until a membership exists?
  - **Why it matters:** the auth slice (shipped) creates the `users` row on confirmed sign-in but does **not** create a membership — it had no basis to pick a role. The tournaments/tables/export authorization slices are blocked on this: role determines who may create/edit/score/export.
  - **Options considered:** (a) auto-create membership as `viewer` on first sign-in, admins promote later; (b) auto-create as `director` (small trusted club) `(lean)`; (c) no auto-provision — seed memberships explicitly, sign-in without one yields an authenticated user with no club access (read-nothing).
  - **Impact if wrong:** too-permissive default hands club-wide edit/export to anyone allowlisted; too-restrictive means a fresh sign-in can't do anything until manual seeding. Raised by the implementation agent from `internal/auth` (users created without membership).

- **Q:** The Challonge export design (reconciliation #13 + config) assumes the **classic API v1 static `CHALLONGE_API_KEY`**. Kevin has instead decided to use a **Challonge Connect OAuth2** app. The reconciliation's Challonge auth model needs updating. Resolved technical facts (verified from Challonge docs, 2026-08-16):
  - **Grant:** `client_credentials` IS supported (machine-to-machine, no user interaction) — good fit for the single shared-club, headless server. No auth-code/consent, no redirect callback needed for server-side export.
  - **Flow:** POST `client_id`+`client_secret` with `grant_type=client_credentials` to the token endpoint → `access_token` (~1 week TTL) → `Authorization: Bearer <token>` on Tournament API calls. Cache the token and refresh on expiry/401.
  - **Scopes** available: `me tournaments:read tournaments:write matches:read matches:write participants:read participants:write`.
  - **App is currently SANDBOX** (500 requests/month) — export must stay well under that; a production upgrade is a later step.
  - **New env vars** (replace `CHALLONGE_API_KEY`): `CHALLONGE_CLIENT_ID`, `CHALLONGE_CLIENT_SECRET`, `CHALLONGE_TOKEN_URL`, `CHALLONGE_API_BASE` (sandbox vs prod), keep `CHALLONGE_SUBDOMAIN`. Secrets live only in `/etc/fifteenball/fifteenball.env` (VPS), never in the repo.
  - **VERIFIED live recipe (2026-08-17, implemented in `internal/challonge`):** token exchange returns a 7-day Bearer; **every app-scoped API call requires ALL of:** `Authorization: Bearer <t>`, `Authorization-Type: v2`, `Content-Type: application/vnd.api+json`, `Accept: application/json` (note: `application/json` in Accept — `vnd.api+json` in Accept is rejected 406). App resources live at `https://api.challonge.com/v2/application/tournaments.json` (JSON:API `{data,included,meta,links}`). The token scope MUST include `application:manage` or app requests 403. A client-credentials (application) token canNOT hit user-scoped `/v2/tournaments.json` (401) — only `/v2/application/...`. Deployed backend confirms `challonge: connected`.
  - **Design impact:** the idempotency design (#13, `challonge_exports` table, create-vs-update, resumable steps) is unchanged; only the auth layer swaps from a static key to a cached OAuth token. **Ask for the design agent:** confirm this OAuth2-client-credentials model and update the reconciliation's Challonge section + config accordingly. The export MAPPING (15-Ball tournament JSON → v2 create tournament + bulk participants + matches/scores) is the next impl sub-slice and needs the v2 create/participants JSON:API payload shapes + the 15-Ball tournament JSON schema.
  - **Impact if wrong:** implementing against the classic-key model would need rework; the concrete facts above let the export slice be built directly against Connect.

*(reconciliation covers everything else through 2026-08-16.)*

## Recently answered

*(none yet)*
