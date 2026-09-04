# 09 — Acceptance tests (scenario level)

See also: [03-state-machines.md](./03-state-machines.md), [04-api-contracts.md](./04-api-contracts.md), [07-challonge-sync-contract.md](./07-challonge-sync-contract.md).

## A. Auth and roles

1. **Bootstrap admin success**: allowlisted email signs in and receives configured admin role.
2. **Non-bootstrap pending**: non-allowlisted user signs in as pending/viewer only.
3. **No auto-promotion**: repeated sign-ins never elevate pending user.
4. **Role update**: admin grants/revokes role; audit row created.

## B. Tournament lifecycle

5. Director creates tournament in `draft`.
6. Viewer cannot create tournament (`403`).
7. Director cannot start tournament before registration close + bracket readiness (`409`).
8. Tournament completion only when all matches terminal.
9. Archiving hides tournament from default list but remains queryable with archived filter.

## C. Entrants

10. Director creates entrant, checks in entrant, then archives entrant.
11. Duplicate entrant display name in same tournament rejected.
12. Check-in invalid after tournament completed.

## D. Matches and scoring

13. Director assigns scorekeeper to match.
14. Unassigned scorekeeper cannot submit result.
15. Assigned scorekeeper submits result successfully; result version row appended.
16. Viewer/player cannot submit results.
17. Completed match reopen requires director/admin + non-empty reason.
18. Re-corrected result creates new version, keeps prior immutable.

## E. Audit invariants

19. Every successful mutation yields exactly one audit row with actor + action.
20. Audit rows are immutable (update/delete attempts fail).

## F. SSE and snapshots

21. SSE stream sends ordered sequence and valid envelope.
22. Reconnect with valid `Last-Event-ID` replays missed events.
23. Reconnect with expired/missing event id yields `snapshot_required` then snapshot recovery.
24. Public overlay endpoint returns normalized state schema.

## G. Challonge sync

25. Sync request enqueues outbox job and returns `202`.
26. Duplicate sync request for same version is idempotent.
27. Sync overlap returns `409 sync_in_progress`.
28. Retryable provider errors back off and eventually recover.
29. Permanent provider errors mark job failed and emit audit + SSE notification.
30. Tests verify no live external mutations (fake provider only).
