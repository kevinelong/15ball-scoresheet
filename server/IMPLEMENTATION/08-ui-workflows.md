# 08 — First-release UI workflows

See also: [02-role-permission-matrix.md](./02-role-permission-matrix.md), [03-state-machines.md](./03-state-machines.md), [06-realtime-contract.md](./06-realtime-contract.md).

## Organizer workflow (system_admin / club_admin / tournament_director)

1. Sign in via magic link.
2. Create tournament (`draft`) and divisions.
3. Add entrants and mark check-in.
4. Close registration and start tournament (creates canonical local bracket/matches).
5. Assign scorekeepers to ready matches.
6. Monitor live state via organizer views + SSE updates.
7. Reopen/correct completed match only with required reason.
8. Trigger Challonge sync explicitly when desired.
9. Complete tournament and archive when finished.

## Scorer workflow (scorekeeper)

1. Sign in.
2. View only assigned match queue.
3. Start assigned match.
4. Submit result when complete.
5. If correction needed after completion, request director reopen; scorer cannot reopen directly.

## Public/OBS workflow (viewer/player/public)

1. Open read-only public bracket or overlay views.
2. Subscribe to SSE or pull snapshot for refresh.
3. No auth required for explicitly public tournament views.
4. No mutation controls rendered or accepted.

## UX invariants

- Any denied mutation shows deterministic auth/state error from API.
- Archive actions hide records from default lists but preserve history.
- Correction/reopen history is visible in match history and audit views.
