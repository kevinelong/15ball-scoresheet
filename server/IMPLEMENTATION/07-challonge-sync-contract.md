# 07 — Challonge sync contract

See also: [04-api-contracts.md](./04-api-contracts.md), [05-schema-contract.md](./05-schema-contract.md), [06-realtime-contract.md](./06-realtime-contract.md).

## Authority model

- Local tournament/division/entrant/match records are canonical.
- Challonge is external and eventually consistent with explicit sync operations.
- No client-side direct Challonge mutations.

## Sync execution model

1. API request creates/updates a `challonge_sync` intent row and outbox job.
2. Worker consumes outbox jobs serially per tournament.
3. Each outbound request includes deterministic idempotency key:
   - `challonge:{tournamentId}:{operation}:{localVersion}`.
4. Provider responses update mapping tables and sync checkpoints transactionally.

## Outbox job types

- `challonge.ensure_tournament`
- `challonge.sync_entrants`
- `challonge.sync_matches`
- `challonge.sync_results`
- `challonge.reconcile`

## Mapping and reconciliation

- Use local↔provider mapping tables from [05-schema-contract.md](./05-schema-contract.md).
- Reconciliation compares local canonical hash vs provider snapshot hash.
- Differences produce deterministic actions (`create`, `update`, `noop`, `manual_review`).
- Manual review path never mutates provider automatically when ambiguity exists.

## Retry and failure policy

- Retries: exponential backoff with jitter, max 8 attempts.
- Retryable: network timeout, 429, 5xx.
- Non-retryable: validation 4xx (except 409 conflict with known idempotent duplicate).
- After max attempts: job `dead_lettered`, tournament sync state `failed`, audit + SSE event emitted.

## Idempotency and concurrency

- Only one active sync job per tournament (`sync_in_progress` on overlap).
- Re-triggering same local version returns existing job status (idempotent).
- A newer local version can enqueue a new job; worker processes in version order.

## Test restrictions

- Automated tests must use HTTP fakes/stubs only.
- No live outbound calls or mutations to real Challonge tenants in CI/local tests.
