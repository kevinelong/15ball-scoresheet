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
    (`bracket_single_test.go: TestSingleElimStructure6`; console side: §J 43–44)
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
36. **The repair path resolves the flag, and only explicitly**: reopen the flagged
    match, submit the corrected result (appending a second result version — the first
    row stays as it was), then `clear-review`, which is the only thing that clears the
    flag: it is director+ only, audits (`match: review_cleared`), emits
    `match.review_cleared`, leaves the recorded result alone and answers
    `409 not_flagged` for a match that does not need review. The flag survives the
    replay, so the director states when the inconsistency is resolved.
    (`bracket_review_test.go: TestReviewFlagRepairPath`)
37. **Every propagation path records, none rewrites**: the guard covers `advanceDouble`'s
    winner advance, `advanceDouble`'s loser drop into the losers bracket, `advanceBracket`
    (single elimination) and `resolveByes` — the last driven directly on a crafted state,
    because no API sequence leaves a bye unresolved while its target is already played
    (defence in depth). Each path flags a played target exactly once, leaves its state,
    result and winner alone, and puts the corrected entrant in its slot so it can be
    replayed. (`bracket_review_paths_test.go: TestReviewFlagPropagationPaths`)
38. **One flag, no matter how many writes**: an identical re-correction, and re-submitting a
    winner that is already in the target slot, both change nothing — same flag, same row
    version, no second audit row, no second event. A second *different* write while the flag
    is already set (flipping the correction back, which does move the slot) still records one
    `review_required` audit row and one event for the match, and does not bump its version.
    (`bracket_review_paths_test.go: TestReviewFlagIdempotentAndInert`)
39. **The flag is a note, not a lock**: a flagged match still reopens, replays and
    completes, and the tournament still completes while it is flagged.
    (`bracket_review_paths_test.go: TestFlaggedMatchStillTransitions`)
40. **`clear-review` guards and idempotency**: a missing `Idempotency-Key` is `400`, a
    non-director `403`, an unknown match `404`, an unflagged match `409 not_flagged`; the
    clear audits `match: review_cleared` and emits `match.review_cleared`, and replaying
    the same key returns the cached response without a second audit row or event.
    (`bracket_review_paths_test.go: TestClearReviewGuardsAndIdempotency`)
41. **`needsReview` is exposed where clients read a match**: the match list, the
    single-match payloads the match actions return, and `snapshot.matches` — true for a
    flagged match, false for a clean one; and `snapshot.overlay.reviewRequired` (plus the
    public overlay endpoint) carries the bracket-level signal for the four states the OBS
    overlay renders, including a flagged bracket with nothing live.
    (`bracket_review_paths_test.go: TestNeedsReviewOnMatchPayloads`,
    `TestOverlayReviewRequired`)
42. **Migration 0017 is additive**: it applies to a database that already holds matches
    (existing rows read back as 0, inserts that never mention the column still land), the
    column is `NOT NULL DEFAULT 0`, and a fresh store records every embedded migration.
    (`server/internal/store/store_test.go: TestMigration0017IsAdditive`,
    `TestOpenAppliesMigrations` — `store`/`migrations` had no test convention before it,
    so it follows the runner's own rules.)

## J. Client rendering (console, overlay, client library)

43. **Format labels stay distinct**: `single_elim` reads "Single Elimination", while the
    shipped `single` still reads "Single Final" and `double` "Double Final", in the
    console's header. (`app-render.test.js`)
44. **Single elimination renders no grand-final card**, and the shipped formats still do.
    (`app-render.test.js`)
45. **The console marks a review-flagged match** in both the bracket tree and the flat
    match list, marks nothing when the bracket is clean, and picks the marker up from an
    SSE event without anyone calling a render function. (`live-console.test.js`)
46. **The overlay never looks normal with an outstanding review**: the card names every
    flagged match (including one that is not featured), the standing-by card names it too,
    and in all four states the rendered signal agrees with `overlay.reviewRequired`.
    (`review-flags.test.js`, plus `TestOverlayReviewRequired` for the server side)
47. **`clearMatchReview` sends the documented request**: POST `…/clear-review` with the
    CSRF header, an Idempotency-Key (generated when the caller omits one) and an optional
    reason body; a `409 not_flagged` surfaces as `FBApiError`. (`api-client.test.js`)
48. **Clearing a sheet rebuilds without replaying it onto a match that is not playable**:
    the surviving downstream sheet is skipped (no throw, final left undecided) instead of
    being replayed onto a match with an empty slot. (`app-render.test.js`)
