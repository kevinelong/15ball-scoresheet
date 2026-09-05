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

*(none — both prior items resolved in `DECISIONS/019-impl-locked-2026-09-05.md`.)*

## Resolved 2026-09-05 (see DECISIONS/019)

- **[was BLOCKING] Challonge auth model** → **OAuth2 Connect client-credentials** (already
  built + verified live; not the legacy API key). Env + token-refresh + idempotency-key
  scheme in DECISIONS/019 §D1.
- **[was NON-BLOCKING] Public visibility default** → **private by default**; public
  endpoints 404 private tournaments. DECISIONS/019 §D2.
