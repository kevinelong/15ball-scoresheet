# 05 — Schema contract (v1)

See also: [03-state-machines.md](./03-state-machines.md), [04-api-contracts.md](./04-api-contracts.md), [07-challonge-sync-contract.md](./07-challonge-sync-contract.md).

## Core tables

1. `users` (id, email_normalized unique, created_at, last_login_at, pending_role boolean).
2. `user_roles` (user_id, role enum, granted_by, granted_at, revoked_at nullable).
3. `tournaments` (id, slug unique, name, game=`15ball_rotation`, state, archived_at nullable, created_by, created_at, updated_at, version).
4. `divisions` (id, tournament_id FK, name, format, state, archived_at nullable, unique(tournament_id,name)).
5. `entrants` (id, tournament_id FK, division_id FK nullable, display_name, state, check_in_at nullable, archived_at nullable, created_at, updated_at, version).
6. `matches` (id, tournament_id FK, division_id FK nullable, bracket_round, side, state, assigned_scorekeeper_user_id nullable, reopened_from_result_id nullable, version, scheduled_at, started_at, completed_at).
7. `match_results` (id, match_id FK, result_version int, winner_entrant_id, loser_entrant_id, payload_json, submitted_by, submitted_at, superseded_by nullable).
8. `audit_log` (id, entity_type, entity_id, action, actor_user_id nullable, reason nullable, before_json, after_json, request_id, created_at).
9. `outbox_jobs` (id, kind, aggregate_type, aggregate_id, payload_json, status, attempts, next_attempt_at, last_error, idempotency_key, created_at, updated_at).
10. `challonge_tournaments` (tournament_id PK/FK, provider_tournament_id unique, provider_url, sync_state, last_synced_at, last_provider_hash).
11. `challonge_participant_map` (tournament_id, entrant_id, provider_participant_id, unique(tournament_id,entrant_id), unique(tournament_id,provider_participant_id)).
12. `challonge_match_map` (tournament_id, match_id, provider_match_id, unique(tournament_id,match_id), unique(tournament_id,provider_match_id)).
13. `idempotency_keys` (key, scope, request_hash, response_json, status_code, created_at, expires_at).
14. `sse_event_log` (event_id, tournament_id, event_type, event_version, payload_json, created_at).

## Key constraints and indexes

- Enforce FK integrity on all mapping and transition tables.
- Partial index for active scorekeeper assignment uniqueness per match where `state IN ('assigned','in_progress','reopened')`.
- Indexes:
  - `tournaments(state, updated_at desc)`
  - `entrants(tournament_id, state, archived_at)`
  - `matches(tournament_id, state, updated_at)`
  - `audit_log(entity_type, entity_id, created_at desc)`
  - `outbox_jobs(status, next_attempt_at)`
  - `sse_event_log(tournament_id, event_id)`

## Immutable fields

- `users.id`, normalized email.
- `tournaments.id`, `tournaments.game`.
- `match_results` rows are append-only; never UPDATE payload to “correct” history.
- `audit_log` rows are append-only.
- Provider IDs in mapping tables are immutable once set; changes require explicit remap workflow + audit row.

## Soft-delete and archive rules

- `tournaments` and `entrants` use `archived_at` + `archived_by`; never hard-delete in v1.
- Query defaults exclude archived rows unless explicitly requested.
- Archiving writes audit entries and SSE notifications.

## Migration rules

1. Expand-then-backfill-then-enforce for new required columns.
2. Never rewrite or delete historical audit/result rows in migrations.
3. Data migrations must be idempotent and re-runnable.
4. Any state enum addition requires:
   - schema change,
   - state machine doc update ([03-state-machines.md](./03-state-machines.md)),
   - acceptance test updates ([09-acceptance-tests.md](./09-acceptance-tests.md)).
