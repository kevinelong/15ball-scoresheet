# Backend backlog status (implementation agent, srv919932)

Durable tracker for the autonomous v1 build. Source of truth for work items is
`server/IMPLEMENTATION/*` + `DECISIONS/019`. Each slice is a full SDLC mini-cycle
(implement → unit test → build → deploy to the live `fifteenball` service → verify).
Legend: [ ] todo · [~] in progress · [x] done+deployed.

## Already live (pre-contract foundation)
- [x] config, migrated SQLite store, health, graceful shutdown, OpenRC service
- [x] magic-link auth (request-link/verify/confirm/me/signout), opaque DB sessions, X-CO CSRF, SMTP
- [x] Challonge Connect OAuth2 client (token cache + JSON:API Do + Ping), verified live

## Slice A — policy, roles, audit, idempotency
- [x] A1 migration: `user_roles`, `users.pending_role`, migrate old org roles → fixed set
- [x] A2 `GET /api/me` → `{userId,email,roles[],pending}`
- [x] A3 `RequireRoles(...)` middleware (403 on miss)
- [x] A4 `audit_log` table + transactional audit-write helper + request_id middleware
- [x] A5 `idempotency_keys` table + dedup middleware/helper (needed by E/G; foundational)

## Slice B — tournaments + divisions
- [x] B1 migration: normalize `tournaments` (slug/name/state/visibility/version/archived), `divisions`, drop old `tables`/`assignments`/`challonge_exports*`
- [x] B2 tournament CRUD `/api/v1/tournaments` [GET,POST] `/{id}` [GET,PATCH] `/{id}/archive` [POST]
- [x] B3 divisions `/api/v1/tournaments/{id}/divisions` [GET,POST]

## Slice C — entrants + check-in
- [x] C1 migration: `entrants`
- [x] C2 entrant CRUD + `/check-in` + `/archive`

## Slice D — brackets + matches
- [x] D1 migration: `matches`, `match_results`
- [x] D2 bracket generation on `in_progress` transition
- [x] D3 match list/assign/start/history endpoints

## Slice E — scoring + corrections
- [x] E1 result submission (immutable, versioned) + reopen (reason+director)
- [x] E2 idempotency dedup wired into E1 (+ creates)

## Slice F — SSE + snapshot + public/overlay
- [x] F1 migration: `sse_event_log`
- [x] F2 SSE stream endpoint (hello/replay/heartbeat/snapshot_required)
- [x] F3 snapshot endpoint (+ OBS overlay normalization)
- [x] F4 public read-only + overlay endpoints (visibility-gated)

## Slice G — Challonge sync
- [ ] G1 migration: `challonge_tournaments`, `challonge_participant_map`, `challonge_match_map`, `outbox_jobs`
- [ ] G2 outbox worker (poll + backoff + dead-letter)
- [ ] G3 sync/reconcile endpoints
- [ ] G4 job executors (ensure_tournament/sync_entrants/sync_matches/sync_results/reconcile)

## Slice H+I — audit view, fixtures, tests, deploy
- [x] H1 `GET /api/v1/tournaments/{id}/audit`
- [ ] I1 idempotent seed fixtures (10-fixtures)
- [ ] I2 acceptance test suite (09-acceptance-tests A–G)
- [ ] I3 final migration validation + deploy verification
