# OPEN-QUESTIONS.md — unresolved decisions only

Closed/superseded decisions now codified in `server/IMPLEMENTATION/`:

- Bootstrap admin is allowlist/config controlled; non-bootstrap users remain pending/viewer and are never auto-promoted.
- Role set is fixed for v1: `system_admin`, `club_admin`, `tournament_director`, `scorekeeper`, `player`, `viewer`.
- Local app records are authoritative; Challonge is external sync provider.
- v1 scope is 15-Ball Rotation only.
- v1 registration is director-managed (public self-registration deferred).
- Realtime transport is SSE for read-heavy/public/OBS updates; REST handles mutations.
- Match result and correction policy is fixed (assigned scorekeeper/director/admin submit; reopen requires director/admin + reason + immutable audit).
- Tournaments/entrants use archive semantics; audit history is never hard-deleted.

## Still unresolved

### [BLOCKING] Challonge auth/profile contract to implement first

- **Question:** Should v1 sync use legacy API-key auth (`CHALLONGE_API_KEY`) from reconciled docs or OAuth2 app credentials from later implementation notes?
- **Why blocking:** endpoint shape, credential config, and error/retry handling differ; implementers cannot safely code provider client until this is fixed.
- **Needed decision format:** pick one auth model and define required env vars + token refresh behavior.

### [NON-BLOCKING] Public visibility default per tournament

- **Question:** Are tournaments public-readable by default, or private unless explicitly published?
- **Why non-blocking:** internal organizer/scorer flows can be implemented first; only public endpoint defaults and UI copy depend on this.
- **Current temporary assumption for planning docs:** public endpoints require explicit tournament visibility flag.
