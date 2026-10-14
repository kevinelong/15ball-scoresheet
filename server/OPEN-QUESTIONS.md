# OPEN-QUESTIONS.md — unresolved decisions only

Closed/superseded decisions now codified in `server/IMPLEMENTATION/`:

- Bootstrap admin is allowlist/config controlled; non-bootstrap users remain pending/viewer and are never auto-promoted.
- Role set is fixed for v1: `system_admin`, `club_admin`, `tournament_director`, `scorekeeper`, `player`, `viewer`.
- Local app records are authoritative; Challonge is external sync provider.
- v1 scope is 15-Ball Rotation only.
- v1 registration is director-managed (public self-registration deferred).
- Realtime transport is SSE for read-heavy/public/OBS updates; REST handles mutations.
- Match result and correction policy is fixed (assigned scorekeeper/director/admin submit; reopen requires director/admin + reason + immutable audit).
- Tournaments/entrants use archive semantics; audit history is never hard-deleted.

## Still unresolved

### Reopening an upstream match whose winner already played downstream

**Status:** open — product decision, so documented rather than implemented.

**Collision.** `ReopenMatch` (`server/internal/api/scoring.go:137-182`) moves a
completed match to `reopened` (reason + audit row) and does nothing else.
Re-submitting then propagates the new winner unconditionally — `advanceDouble`
(`server/internal/api/bracket.go:302`, writing the slot at `:335`) for double
elimination, `advanceBracket` (`scoring.go:187-216`) for single elimination —
overwriting the downstream match's slot. If that downstream match was already
played it keeps its `completed` state, its result row and its `winnerEntrantId`
while its slot now names the other player: a completed match whose winner is not
one of its two entrants. Single elimination no longer escapes this by luck —
every round is now created up front with `feeds_winner_*` edges
(`server/internal/api/matches.go:74`), so the downstream match always exists.

**Not specified.** `grep -rn -i 'downstream|invalidat' server/IMPLEMENTATION`
returns nothing. `03-state-machines.md:34,41-43` only requires the correction path
`completed → reopened → in_progress|completed` with a reason, an appended
immutable result version and an audit row; `04-api-contracts.md` documents
`reopen` only as `{reason}` → `200`, `400 reason_required`, `409`. Nothing states
what happens to results that already depended on a reopened match.

**Options.**
1. **Block the reopen** while the match's winner has already been used downstream
   (downstream slot populated and/or a `match_results` row exists). Cost: lowest —
   one guard plus one error code (`409`, e.g. `downstream_played`), no state or
   schema change, needs a doc row and one acceptance scenario. Cost against: a
   genuine scoring error can no longer be corrected once the next round has
   started — precisely the case reopen exists for.
2. **Invalidate and replay downstream**: reopening clears the affected downstream
   slots and results recursively, marks those matches `reopened` with the reason
   carried over and requires them to be played again. Cost: highest — recursive
   invalidation, new audit actions, standings/overlay handling, cascade tests, and
   a decision on superseding played results (`match_results.superseded_by` exists
   in the schema but is never set by the submit/reopen paths — only the seed
   fixture writes it). Cost against: one correction can invalidate much of a
   finished bracket, and reopening is currently `200` in a single transaction.
3. **Correction flag**: allow the reopen, keep the downstream result, record the
   inconsistency (flag + audit + SSE) for a human to resolve. Cost: medium — a new
   column/flag, UI surfacing, and a documented manual repair path; no cascade
   logic. Cost against: the bracket stays provably inconsistent until someone
   acts, and the overlay/standings must render that state.

Until one is chosen, reopen behaves exactly as shipped: no guard, no cascade.

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

## Resolved 2026-09-05 (see DECISIONS/019)

- **[was BLOCKING] Challonge auth model** → **OAuth2 Connect client-credentials** (already
  built + verified live; not the legacy API key). Env + token-refresh + idempotency-key
  scheme in DECISIONS/019 §D1.
- **[was NON-BLOCKING] Public visibility default** → **private by default**; public
  endpoints 404 private tournaments. DECISIONS/019 §D2.
