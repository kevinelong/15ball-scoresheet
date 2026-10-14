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

## H. Bracket generation (format-driven)

The generator is chosen from the primary division's `format` on the
`registration_closed → in_progress` transition (`tournaments.go: PatchTournament`):
`double_elimination` (default when a division has no format) or
`single_elimination`.

31. **Single elimination sizes the field to the next power of two**: a 6-player
    `single_elimination` division yields a size-8 bracket (W1: 4, W2: 2, W3: 1 = 7
    matches) with 2 byes, no losers-bracket and no grand-final match, and every
    match carries a NULL `bracket` (which is what routes its result down the
    single-elimination advancement path).
    (`bracket_single_test.go: TestSingleElimStructure6`)
32. **No checked-in entrant is dropped**: for n = 3, 5, 7 every entrant appears in
    a match (the unpaired seeds become archived BYE placeholders inserted at the
    `seedOrder` position), the byes auto-resolve at generation so exactly n−1
    matches are played, and the tournament plays through to `completed`.
    (`bracket_single_test.go: TestSingleElimNoEntrantDropped`)
33. **Double elimination keeps its shape**: 4- and 8-player structures, full
    playthrough, a GF2 reset when the losers champ wins GF1, and 3-player byes.
    (`bracket_double_test.go`)
34. **A 2-player double-elimination field degrades to one decisive match**: the
    double-elimination generator hands fields smaller than 3 to the single
    generator. (`matches_test.go: TestBracketGenerationAndMatchFlow`)

## I. Corrections, the review flag and the manual repair path

35. **A played result is never silently rewritten**: a director reopens an upstream
    match whose winner already played downstream and re-completes it with the other
    winner. The downstream match keeps its `completed` state, its result row and its
    `winnerEntrantId`; the corrected winner reaches its slot (so the match can be
    replayed at all); and the match is flagged with `needsReview`, an audit row
    (`match: review_required`) and an event (`match.review_required`). On the
    double-elimination path both the winners-bracket target and the played
    losers-bracket target are flagged, while the grand final the correction did not
    feed is left clean. One audit row and one event per flag, so repeating the same
    correction neither duplicates them nor moves a slot.
    (`bracket_review_test.go: TestReviewFlagOnCorrectedUpstreamSingleElim`,
    `TestReviewFlagOnCorrectedUpstreamDoubleElim`)
