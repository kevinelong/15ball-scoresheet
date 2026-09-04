# 10 — Fixtures and seeds

See also: [09-acceptance-tests.md](./09-acceptance-tests.md), [05-schema-contract.md](./05-schema-contract.md).

## Seed users

- `sysadmin@club.test` → `system_admin`
- `clubadmin@club.test` → `club_admin`
- `director@club.test` → `tournament_director`
- `scorer1@club.test` → `scorekeeper`
- `player1@club.test` → `player`
- `viewer1@club.test` → `viewer`
- `pending@club.test` → `viewer` + pending flag

## Seed tournament fixture

- `t_open_001` (registration open)
- `t_live_001` (in progress, active matches)
- `t_done_001` (completed)
- `t_arch_001` (archived)

Each tournament fixture includes:

- at least 8 entrants with mixed entrant states,
- at least 6 matches covering `scheduled`, `assigned`, `in_progress`, `completed`, `reopened`,
- at least one corrected match with two `match_results` versions,
- baseline audit entries and outbox rows.

## Seed Challonge mapping fixture

- One fully mapped tournament (`provider_tournament_id` present).
- One partially mapped tournament (tests reconciliation path).
- One failed sync record with retry metadata.

## Fixture invariants

- Fixture IDs are deterministic and stable across test runs.
- Seed scripts are idempotent.
- Fixtures include both success and failure path data for acceptance scenarios.
