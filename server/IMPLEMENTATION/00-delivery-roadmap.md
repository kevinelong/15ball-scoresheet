# 00 — Delivery roadmap (bounded, deterministic)

See also: [01-domain-glossary.md](./01-domain-glossary.md), [02-role-permission-matrix.md](./02-role-permission-matrix.md), [09-acceptance-tests.md](./09-acceptance-tests.md).

## Scope guardrails for this roadmap

- v1 backend scope is **15-Ball Rotation only**.
- Local app data is authoritative; Challonge is an external sync target.
- Registration is director-managed in v1 (public self-registration is deferred).
- External API calls are done only via outbox jobs.
- Every state change writes an immutable audit row.

## Vertical slices

### Slice A — Policy and roles

- **Prerequisites:** none.
- **Allowed modules/files:** `server/internal/auth/*`, `server/internal/policy/*`, `server/internal/audit/*`, `server/migrations/*`, `server/IMPLEMENTATION/*`.
- **DB/API changes:** role columns/tables, bootstrap-admin allowlist flow, `GET /api/v1/me`, auth endpoints.
- **Non-goals:** tournament editing, scoring, Challonge sync.
- **Definition of done (tests):** auth + role enforcement scenarios in [09-acceptance-tests.md](./09-acceptance-tests.md) pass.

### Slice B — Tournaments and divisions

- **Prerequisites:** Slice A.
- **Allowed modules/files:** `server/internal/tournaments/*`, `server/internal/audit/*`, `server/migrations/*`, tests + docs.
- **DB/API changes:** tournament records, division records, archive semantics, list/detail endpoints.
- **Non-goals:** entrants check-in, bracket scoring.
- **Definition of done (tests):** tournament create/update/archive/read tests pass with audit verification.

### Slice C — Entrants and check-in

- **Prerequisites:** Slices A–B.
- **Allowed modules/files:** `server/internal/entrants/*`, `server/internal/tournaments/*`, `server/internal/audit/*`, migrations, tests + docs.
- **DB/API changes:** entrant table/state, check-in endpoints, soft-delete/archive flags.
- **Non-goals:** match result submission.
- **Definition of done (tests):** entrant state machine success/failure tests pass.

### Slice D — Brackets and matches

- **Prerequisites:** Slices A–C.
- **Allowed modules/files:** `server/internal/brackets/*`, `server/internal/matches/*`, `server/internal/audit/*`, migrations, tests + docs.
- **DB/API changes:** canonical local bracket/match records; no direct Challonge ownership.
- **Non-goals:** realtime fan-out, OBS payloads.
- **Definition of done (tests):** match lifecycle and invalid transition tests pass.

### Slice E — Scoring and corrections

- **Prerequisites:** Slices A–D.
- **Allowed modules/files:** `server/internal/scoring/*`, `server/internal/matches/*`, `server/internal/audit/*`, tests + docs.
- **DB/API changes:** result submission endpoint, reopen endpoint requiring reason, immutable result history.
- **Non-goals:** external synchronization.
- **Definition of done (tests):** only assigned scorer/director/admin can submit; reopen/correct flow fully audited.

### Slice F — SSE and OBS overlay data

- **Prerequisites:** Slices A–E.
- **Allowed modules/files:** `server/internal/realtime/*`, `server/internal/public/*`, tests + docs.
- **DB/API changes:** SSE stream endpoints, snapshot retrieval endpoint, normalized OBS/public payload projection.
- **Non-goals:** WebSocket transport.
- **Definition of done (tests):** SSE reconnect/snapshot scenarios and envelope contract tests pass.

### Slice G — Challonge sync

- **Prerequisites:** Slices A–F.
- **Allowed modules/files:** `server/internal/challonge/*`, `server/internal/outbox/*`, `server/internal/audit/*`, migrations, tests + docs.
- **DB/API changes:** sync mapping tables, outbox jobs, sync status endpoints.
- **Non-goals:** direct live external mutations during tests.
- **Definition of done (tests):** idempotent sync/retry/reconcile tests pass against fakes only.

### Slice H — Public views and reporting

- **Prerequisites:** Slices A–G.
- **Allowed modules/files:** `server/internal/public/*`, `server/internal/reports/*`, `server/internal/realtime/*`, tests + docs.
- **DB/API changes:** public read-only endpoints and pagination for reporting views.
- **Non-goals:** registration or score mutation.
- **Definition of done (tests):** public-read authorization and reporting pagination tests pass.
