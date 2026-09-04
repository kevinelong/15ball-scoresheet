# AGENTS.md — server implementation handoff contract

This directory is coordinated between planning/design work and code-only implementation work.

## Canonical sources (read in this order before coding)

1. `server/IMPLEMENTATION/00-delivery-roadmap.md`
2. `server/IMPLEMENTATION/01-domain-glossary.md`
3. `server/IMPLEMENTATION/02-role-permission-matrix.md`
4. `server/IMPLEMENTATION/03-state-machines.md`
5. `server/IMPLEMENTATION/04-api-contracts.md`
6. `server/IMPLEMENTATION/05-schema-contract.md`
7. `server/IMPLEMENTATION/06-realtime-contract.md`
8. `server/IMPLEMENTATION/07-challonge-sync-contract.md`
9. `server/IMPLEMENTATION/08-ui-workflows.md`
10. `server/IMPLEMENTATION/09-acceptance-tests.md`
11. `server/IMPLEMENTATION/10-fixtures-and-seeds.md`
12. `server/IMPLEMENTATION/11-operations-runbook.md`
13. `server/OPEN-QUESTIONS.md`
14. `server/SPEC-DESIGN-RECONCILED.md` and `server/DESIGN.md` (historical context)

## Required implementation rules

- Do **not** guess unresolved product decisions. If blocked, add a concise item to `server/OPEN-QUESTIONS.md` and stop on that branch of work.
- Do **not** run live external mutations in automated tests (including Challonge). Use fakes/stubs.
- Every successful state-changing operation must create an immutable audit entry in the same transaction.
- Every external side effect must be represented by an outbox job created transactionally.
- Local records are canonical; external providers are sync targets.
- `tournaments` and `entrants` are archive/soft-delete only in v1; audit history is never hard-deleted.
- Only assigned scorekeeper/director/admin can submit match results.
- Reopening a completed match requires director/admin and a non-empty reason.

## Required update discipline

When behavior changes, update in the same PR:

1. corresponding implementation contract doc(s), and
2. affected scenario coverage in `server/IMPLEMENTATION/09-acceptance-tests.md`.

PRs that change behavior without docs/tests updates are incomplete.
