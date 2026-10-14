# OPEN-QUESTIONS.md — unresolved decisions only

Closed/superseded decisions now codified in `server/IMPLEMENTATION/`:

- Bootstrap admin is allowlist/config controlled; non-bootstrap users remain pending/viewer and are never auto-promoted.
- Role set is fixed for v1: `system_admin`, `club_admin`, `tournament_director`, `scorekeeper`, `player`, `viewer`.
- Local app records are authoritative; Challonge is external sync provider.
- v1 scope is 15-Ball Rotation only.
- v1 registration is director-managed (public self-registration deferred).
- Realtime transport is SSE for read-heavy/public/OBS updates; REST handles mutations.
- Match result and correction policy is fixed (assigned scorekeeper/director/admin submit; reopen requires director/admin + reason + immutable audit).
- A correction that reaches an already-played match keeps the played result and flags the match for review (`matches.needs_review`); the director replays it and clears the flag explicitly.
- Tournaments/entrants use archive semantics; audit history is never hard-deleted.

## Still unresolved

### Which result version is "the current winner" after a reopen and re-submit?

**Status:** open — found while testing the review-flag repair path; code left as
shipped (writing `match_results.superseded_by` is option 2's machinery and was
explicitly kept out of that change).

**Evidence.** `SubmitResult` (`server/internal/api/scoring.go:53-133`) appends a new
`match_results` row on every submission and never marks the previous one superseded,
so after the correction path (`completed → reopened → completed`) a match holds
**two** rows with `superseded_by IS NULL`. `ListMatches` assumes otherwise — "there
is exactly one such row per completed match" (`server/internal/api/matches.go:151-165`)
— and resolves the winner by scanning those rows into a map with no `ORDER BY`, so
`winnerEntrantId` can come back as the *superseded* winner. Reproduced: submit v1
(winner A) → `POST …/reopen` → submit v2 (winner B); `GET …/matches` reports A, while
`GET …/matches/{id}/history` reports both versions with B latest.
`bracket_review_test.go` reads corrections from the version list for this reason.

**Why it matters now.** The documented repair path ends by clearing the review flag;
the director then reads the corrected match from `listMatches` (and the console
renders `winnerEntrantId`), where the winner shown can be the one that was corrected
away.

**Options.**
1. Mark the previous row `superseded_by = <new result id>` when a new result is
   appended — small, and it is what the schema and the "current row" convention
   already assume; but it writes the field option 2 (invalidate-and-replay) would
   share.
2. Keep the rows append-only as they are and derive the current winner from
   `MAX(result_version)` per match in the read paths — no write-path change, but
   every reader of "current winner" must change with it.
3. Leave the ambiguity (not recommended): it is silent, and already visible in the
   console after any correction.

## Resolved 2026-10-14 — reopen collision (option 3: record, don't cascade)

- **Reopening an upstream match whose winner already played downstream** →
  **allow the reopen, keep the played result, record the inconsistency**: bracket
  propagation writes the corrected winner into the slot (otherwise the corrected
  pairing could not be replayed) while leaving the downstream match's state, result
  rows and winner untouched, and sets `matches.needs_review` with a
  `match: review_required` audit row and a `match.review_required` event in the same
  transaction. A director resolves it by reopening the flagged match, re-submitting
  the corrected result and clearing the flag
  (`POST …/matches/{matchId}/clear-review`, audited + `match.review_cleared`).
  Codified in `03-state-machines.md` ("Match review flag"),
  `05-schema-contract.md` (migration 0017), `04-api-contracts.md`,
  `06-realtime-contract.md` and `09-acceptance-tests.md` §I.
  Neither of the other options was taken: the reopen is not blocked, and nothing is
  invalidated or replayed automatically (`match_results.superseded_by` is untouched).

## Resolved 2026-09-05 (see DECISIONS/019)

- **[was BLOCKING] Challonge auth model** → **OAuth2 Connect client-credentials** (already
  built + verified live; not the legacy API key). Env + token-refresh + idempotency-key
  scheme in DECISIONS/019 §D1.
- **[was NON-BLOCKING] Public visibility default** → **private by default**; public
  endpoints 404 private tournaments. DECISIONS/019 §D2.
