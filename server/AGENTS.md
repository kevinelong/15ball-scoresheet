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

## Where the work stands (handoff, 2026-10-14)

Last shipped (branch `test-coverage-hardening`, tip `1d6e753`, on `main`):

- **Review flag — option 3 of the reopen collision.** A corrected upstream result still
  reaches the downstream slot (otherwise the corrected pairing could never be replayed),
  but a played result is never rewritten: the match keeps its state, its result rows and
  its winner, and is flagged (`matches.needs_review`, migration 0017) with a
  `match: review_required` audit row and a `match.review_required` event in the same
  transaction. All propagation goes through one guarded write path (`advanceSlot`):
  `advanceDouble`'s winner advance, its losers-bracket drop, `advanceBracket` and
  `resolveByes`. Cleared only by `POST /api/v1/tournaments/{id}/matches/{matchId}/clear-review`
  (director+, audited, `match.review_cleared`); the repair path is reopen → re-enter the
  result → clear. Nothing cascades and `match_results.superseded_by` is untouched.
  Semantics: `IMPLEMENTATION/03-state-machines.md` ("Match review flag").
- **Real single elimination.** Server field sizing (nextPow2 + archived BYE placeholder at
  the `seedOrder` position, every round created up front with `feeds_winner_*` edges) and
  the console's third format `single_elim`; the shipped `single` (single *final*) and
  `double` are untouched.
- **Coverage with falsification.** Scenarios 31–48 of `IMPLEMENTATION/09-acceptance-tests.md`
  are covered by tests, each new guard shown biting (guard removed → red → restored). Four
  new Node suites live beside the files they cover (see `README.md` → Testing).

Next up (decisions, not gaps):

- `OPEN-QUESTIONS.md`: **which result version is "the current winner" after a reopen and
  re-submit** (two `match_results` rows end up with `superseded_by IS NULL`). Until it is
  decided, read a corrected result from `matchHistory().versions`, not
  `listMatches().winnerEntrantId` (see `IMPLEMENTATION/12-frontend-integration-guide.md` §9).
- Scope B remainder: disciplines beyond 15-ball.
- The console has no "clear review" control yet — the endpoint and the client method exist
  and are tested; the button (placement, confirmation, wording) is a UI decision.

### Per-discipline score sheets — ported forward (branch `per-discipline-sheets-v2`, 2026-10-14)

`per-discipline-sheets` (3 unpublished commits, cut before the single-elim and review-flag
rounds) held the only per-discipline sheet work, and its `app.js`/`index.html` predated
them. The wanted parts were ported onto today's `main` as new commits on
`per-discipline-sheets-v2`; the old branch was left untouched (not pushed, not deleted).

- **`sheets.js`** — one spec per discipline (rack geometry, column labels, goal presets,
  final label, and how the discipline is measured) with a DEFS/ALIASES id map that resolves
  both the console's own ids (`fifteenBall`, `14_1`, `onepocket`, `banks`) and the server's
  canonical ones (`15ball_rotation`, `straight_14_1`, `one_pocket`, `bank_pool`). This is a
  **live bug fix**: a server-imported tournament carries a canonical game id, which the
  old `gameOf()` fell back on, so it silently opened the 15-Ball sheet.
- **14.1 gets a real sheet** — 14 balls per rack, 8 racks, `RUNNING TOTAL`,
  `FINAL MATCH TOTAL`, goals 75/100 — and the race disciplines get a games tally inside the
  same sheet chrome instead of the second counter modal (`#counterModal` is gone).
- **Docs**: 14.1's paper sheet and plain-English rules PDF plus the two Python builders
  under `docs/` (the paper sheet is the QR target the in-app sheet points at), and
  `DECISIONS/021-per-game-sheets.md`. `.gitattributes` marks `*.pdf` binary so
  `core.autocrlf` cannot corrupt a generated PDF's xref offsets on checkout.

**One model per game, and no quick-add control (2026-10-14).** How a discipline is scored
is data now, not an inference about a number: `Sheets.spec(game).measure` is `"balls"`
(marked one at a time — a rack grid) or `"wins"` (stepped — a tally against the race
target), and `Sheets.kind(game)` (the body a sheet renders, and the `_kind` a saved sheet
stores) is derived from it, so the two cannot disagree. All twelve `+5`/`+10`/`−5`
controls are gone — the six in the old counter modal went with the modal, the six in the
ported race body are deleted here — along with the `pointsMode` heuristic
(`raceTo >= 50`) that used to gate them, its delegate case and its dead CSS. Every
discipline declares `quickAdd: []`, and the race tally is clamped to its target, so a race
to 7 cannot read 8 (let alone 15 with the winner auto-selected, which the audit
reproduced). Tests: `sheets.test.js` (measure ↔ body, no jumps declared),
`app-render.test.js` (no `+5`/`+10`/`−5` in any dialog for any discipline; nine steps on a
race to 7 leave 7). Frontend only.

**Swipe to step the tally (2026-10-14).** The console had no gesture; the Android scorer has
had one since it shipped (`SwipePanel.java`), and it is now the same gesture in the browser:
a mostly-vertical drag past 48 CSS px on either half of the games tally is one step for that
side (up +1, down −1), taken from the child — the panel keeps the pointer and cancels the
click, so a drag that starts on `+` scores exactly once. It is gated to touch/pen pointers
(a vertical mouse drag must keep scrolling), the panel is hidden with the tally so the
ball-marked sheets have no gesture, and it calls the very same `raceInc`/`raceDec` the ±
buttons call: the buttons, the ball taps and the winner box all remain, and the gesture is
never the only way to score. `navigator.vibrate(10)` where the platform offers haptics,
silently where it does not; `.race` gets `touch-action: pan-x` so a real phone delivers the
drag instead of scrolling it. Docs: `DECISIONS/022-swipe-to-score.md`. Tests:
`app-render.test.js` drives real pointer events (one step per gesture, the half test, the
threshold, horizontals and diagonals, the mouse gate, and the cancelled button press), each
guard falsified. Frontend only.

Nothing in this turn changes what a running deployment must pick up: no migration, no server
behaviour, no deploy step.

## Deployment (Kevin's, not the implementing agent's)

**A pushed commit is not a deployed one.** The live service picks changes up when Kevin
pulls and restarts it: `cd /home/kevin/15ball-scoresheet && git pull` + service restart.

- Pending on the next service start: migration **`0017_match_review_flag.sql`** (adds
  `matches.needs_review`; additive, `DEFAULT 0`, no backfill — existing rows read back as
  clear). The review flag is inert until that migration has run.
- No other deploy step changed this round; no tag, release or deploy is performed from this
  branch.

## Turn discipline

- Create the branch **before** the first commit of a turn; never commit a turn's work
  straight onto `main`. (Cost us a correction on 2026-10-14 — the branch was created at the
  tip after the fact.)
- One turn, one change, one commit, one push — never batch a turn into the next turn's push.
- End every turn by updating `README.md`, this handoff and `IMPLEMENTATION/BACKLOG-STATUS.md`
  with what changed and what is next, and leave `OPEN-QUESTIONS.md` current: a resolved
  decision reads as resolved, with the date and what was chosen.
- Say explicitly when a turn changes what a running deployment must pick up (see above).
- `per-discipline-sheets` stays untouched (3 unpublished commits) — its wanted parts were
  ported forward to `per-discipline-sheets-v2`, but the old branch is not pushed or deleted.

