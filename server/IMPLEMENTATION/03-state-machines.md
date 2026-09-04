# 03 — State machines and transition contracts

See also: [02-role-permission-matrix.md](./02-role-permission-matrix.md), [04-api-contracts.md](./04-api-contracts.md), [05-schema-contract.md](./05-schema-contract.md).

## Tournament state machine

States: `draft` → `registration_open` → `registration_closed` → `in_progress` → `completed` → `archived`.

| From | To | Allowed roles | Guards | Side effects | Invalid examples |
|---|---|---|---|---|---|
| draft | registration_open | system_admin, club_admin, tournament_director | required metadata + at least 1 division | audit row `tournament.opened_registration` | opening with missing format |
| registration_open | registration_closed | system_admin, club_admin, tournament_director | none | audit row | closing by scorekeeper |
| registration_closed | in_progress | system_admin, club_admin, tournament_director | bracket generated + entrants checked in >= min | initialize round-1 matches, audit row, SSE event | start without bracket |
| in_progress | completed | system_admin, club_admin, tournament_director | all matches terminal | freeze standings, audit row, SSE event | complete with open matches |
| completed | in_progress | system_admin, club_admin, tournament_director | required reopen reason | audit row `tournament.reopened` | reopen without reason |
| any non-archived | archived | system_admin, club_admin, tournament_director | none | set archived fields, audit row | archive twice |
| archived | draft/in_progress/etc. | none (forbidden) | n/a | n/a | any unarchive in v1 |

## Entrant state machine

States: `pending` → `registered` → `checked_in` → (`eliminated` or `withdrawn` or `disqualified`) and optional `archived` flag.

| From | To | Allowed roles | Guards | Side effects | Invalid examples |
|---|---|---|---|---|---|
| pending | registered | system_admin, club_admin, tournament_director | entrant profile valid, unique display name per tournament | audit row | player self-registering |
| registered | checked_in | system_admin, club_admin, tournament_director | tournament state `registration_open` or `registration_closed` | audit row, SSE event | check-in after tournament completed |
| checked_in | withdrawn | system_admin, club_admin, tournament_director | no active match assignment | mark unavailable, audit row | withdraw during active match |
| checked_in | disqualified | system_admin, club_admin, tournament_director | reason required | audit row with reason | DQ without reason |
| checked_in | eliminated | system-driven | bracket loss condition met | audit row, standings update | manual elimination without match result |
| any non-terminal | archived=true | system_admin, club_admin, tournament_director | none | soft-delete timestamp + audit row | hard delete entrant |

## Match state machine

States: `scheduled` → `assigned` → `in_progress` → `completed`; correction path `completed` → `reopened` → `in_progress|completed`.

| From | To | Allowed roles | Guards | Side effects | Invalid examples |
|---|---|---|---|---|---|
| scheduled | assigned | system_admin, club_admin, tournament_director | both entrants resolved, scorekeeper selected | assignment row + audit + SSE | assign nonexistent scorekeeper |
| assigned | in_progress | system_admin, club_admin, tournament_director, assigned scorekeeper | assignment active | audit + SSE | unassigned scorekeeper starting |
| in_progress | completed | system_admin, club_admin, tournament_director, assigned scorekeeper | result payload valid | immutable result version row, advance bracket, audit + SSE + outbox enqueue for sync | viewer submitting result |
| completed | reopened | system_admin, club_admin, tournament_director | correction reason required | mark reopen metadata, audit + SSE | reopen by scorekeeper |
| reopened | in_progress | system_admin, club_admin, tournament_director, assigned scorekeeper | assignment active or reassigned | audit + SSE | start without assignment |
| reopened/in_progress | completed | system_admin, club_admin, tournament_director, assigned scorekeeper | result payload valid | append next immutable result version + audit + outbox enqueue | overwrite prior result row |

### General transition invariants

1. Every successful transition writes exactly one audit entry in the same transaction.
2. No transition deletes prior audit or result history.
3. External side effects are represented by outbox jobs created transactionally.
4. Invalid transitions return deterministic `4xx` codes; never auto-fix state.
