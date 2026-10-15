# Backend backlog status (implementation agent, srv919932)

Durable tracker for the autonomous v1 build. Source of truth for work items is
`server/IMPLEMENTATION/*` + `DECISIONS/019`. Each slice is a full SDLC mini-cycle
(implement → unit test → build → deploy to the live `fifteenball` service → verify).
Legend: [ ] todo · [~] in progress · [x] done+deployed.

## Already live (pre-contract foundation)
- [x] config, migrated SQLite store, health, graceful shutdown, OpenRC service
- [x] magic-link auth (request-link/verify/confirm/me/signout), opaque DB sessions, X-CO CSRF, SMTP
- [x] Challonge Connect OAuth2 client (token cache + JSON:API Do + Ping), verified live

## Slice A — policy, roles, audit, idempotency
- [x] A1 migration: `user_roles`, `users.pending_role`, migrate old org roles → fixed set
- [x] A2 `GET /api/me` → `{userId,email,roles[],pending}`
- [x] A3 `RequireRoles(...)` middleware (403 on miss)
- [x] A4 `audit_log` table + transactional audit-write helper + request_id middleware
- [x] A5 `idempotency_keys` table + dedup middleware/helper (needed by E/G; foundational)

## Slice B — tournaments + divisions
- [x] B1 migration: normalize `tournaments` (slug/name/state/visibility/version/archived), `divisions`, drop old `tables`/`assignments`/`challonge_exports*`
- [x] B2 tournament CRUD `/api/v1/tournaments` [GET,POST] `/{id}` [GET,PATCH] `/{id}/archive` [POST]
- [x] B3 divisions `/api/v1/tournaments/{id}/divisions` [GET,POST]

## Slice C — entrants + check-in
- [x] C1 migration: `entrants`
- [x] C2 entrant CRUD + `/check-in` + `/archive`

## Slice D — brackets + matches
- [x] D1 migration: `matches`, `match_results`
- [x] D2 bracket generation on `in_progress` transition
- [x] D3 match list/assign/start/history endpoints

## Slice E — scoring + corrections
- [x] E1 result submission (immutable, versioned) + reopen (reason+director)
- [x] E2 idempotency dedup wired into E1 (+ creates)

## Slice F — SSE + snapshot + public/overlay
- [x] F1 migration: `sse_event_log`
- [x] F2 SSE stream endpoint (hello/replay/heartbeat/snapshot_required)
- [x] F3 snapshot endpoint (+ OBS overlay normalization)
- [x] F4 public read-only + overlay endpoints (visibility-gated)

## Slice G — Challonge sync
- [x] G1 migration: `challonge_tournaments`, `challonge_participant_map`, `challonge_match_map`, `outbox_jobs`
- [x] G2 outbox worker (poll + backoff + dead-letter; `errors.As` retry classification)
- [x] G3 sync/reconcile endpoints (`/challonge/sync` [POST,GET], `/challonge/reconcile` [POST])
- [x] G4 job executors (ensure_tournament + sync_entrants→participants; idempotent via mapping tables). Match/result sync deferred (documented; entrant+tournament sync live)

## Slice H+I — audit view, fixtures, tests, deploy
- [x] H1 `GET /api/v1/tournaments/{id}/audit`
- [x] I1 idempotent seed fixtures — `internal/seed` (7 users, 4 tournaments, mixed
      entrant/match states, corrected-match result versions, Challonge mapping
      success + partial + failed/dead-lettered paths); re-seed is a no-op (test-verified)
- [x] I2 acceptance test suite — `internal/api/acceptance_test.go` maps all 30
      scenarios (A1–G30); auth via auth pkg, sync via HTTP + fake provider (no live calls)
- [x] I3 final migration validation + deploy verification — full suite + vet green,
      CGO-free rebuild deployed to live `fifteenball`, health 200, sync endpoints gated,
      overlay 404 schema-valid, worker + Challonge up, migrations clean in logs

## Status: v1 backend COMPLETE — all slices A–I implemented, tested, deployed.

## Post-v1 enhancements (requested 2026-09-05)
- [x] Slice J — table assignment: `matches.table_ref`, wired through assign (COALESCE
      keeps prior), exposed on match JSON + overlay. Deployed (migration 0008).
- [x] Slice K — SMS match-ready alerts (Twilio): entrant `phone`+`notify_opt_in`,
      `notifications` outbox + Twilio sender (+ fake) + retry/backoff worker; enqueued
      on assign-to-table (idempotent per match+entrant), gated on `SMSConfigured()`.
      Deployed (migration 0009); dormant until `TWILIO_*` env set (see ops runbook).
      Live: API-key auth + hot-load from env file (DECISIONS/020); delivery pending
      Twilio toll-free verification.
- [x] Slice L — double-elimination bracket, **now the default** (scope B). Feeder-graph
      generator ported from FE `bracket.js` (winners/losers/grand-final + GF2 reset +
      byes); migration 0010 adds `bracket`/`match_label`/feeds_* columns. Format from
      the primary division (`double_elimination` default; `single_elimination` still
      supported — 2-player fields fall back to a single decisive match). Advancement
      routes W-losers to the losers bracket and eliminates only on losers/GF losses.
      Tests: structure (4/8-player), full playthrough, GF2 reset, byes (3-player).
      Deployed (migration 0010). Remaining scope-B: additional disciplines (game types).
- [x] Slice M — single-elimination field sizing + byes (server + console). The
      single-elimination generator paired only complete pairs, so a non-power-of-two
      field silently **dropped its last checked-in entrant**, never sized itself to a
      power of two, and `resolveByes` never saw those matches (its predicate was
      `bracket IN ('W','L')`, and single-elim matches carry a NULL bracket). Now the
      field is seeded through the shared `seedField`/`buildWinnersRounds` helpers
      (nextPow2 + archived BYE placeholder at the `seedOrder` position), every round
      is created up front with `feeds_winner_*` edges, and single-elim byes resolve.
      The console gained `single_elim` (real single elimination) beside the shipped
      `single` (single final) and `double`, exposed as a third option in the create
      form. Tests: `bracket_single_test.go` (structure, n=3/5/7 no-drop playthrough),
      `bracket.test.js` (spec, scale pinning, recordWinner refusals).
      Implemented + tested locally; **not deployed** — applies on the next `git pull` +
      service restart (Kevin's).
- [x] Slice N — review flag for a correction that reaches a played match (option 3 of the
      reopen collision). A corrected upstream result still lands in the downstream slot
      (otherwise the corrected pairing could not be replayed), but the played result is
      never rewritten: the match keeps its state, its result rows and its winner, and gets
      `needs_review` + a `match: review_required` audit row + a `match.review_required`
      event in the same transaction. All propagation shares one guarded write path
      (`advanceSlot`), so the winner advance, the losers-bracket drop, the single-elim
      advance and `resolveByes` behave the same. Cleared only by
      `POST …/matches/{matchId}/clear-review` (director+, audited, `match.review_cleared`);
      the repair path is reopen → re-enter the result → clear. `superseded_by` and any
      cascade invalidation were deliberately left alone. Migration
      **`0017_match_review_flag.sql`** (`matches.needs_review`, additive `DEFAULT 0`) —
      it applies automatically on the next service start, so this slice is **not live until
      Kevin deploys** (`cd /home/kevin/15ball-scoresheet && git pull` + restart).
      Docs: 03, 04, 05, 06, 09 §I, 12 §10, OPEN-QUESTIONS (resolved).
- [x] Slice O — test hardening for the above (no behaviour change). Every propagation path
      and every edge of the flag is covered, plus the console/overlay/client-library work
      from Slice M/N, with falsification evidence for each guard (remove the guard → red →
      restore): `bracket_review_paths_test.go`, `server/internal/store/store_test.go`
      (migration 0017 is additive against a populated database), `live-console.test.js`,
      `review-flags.test.js`, `api-client.test.js`, `app-render.test.js`. Scenarios 37–48.
      Two assertions were deleted because they could not fail (a second-granularity
      `updated_at` check, and a score that an empty slot never renders).
- [x] Slice P — per-discipline score sheets, ported forward from `per-discipline-sheets`
      (branch `per-discipline-sheets-v2`). `sheets.js` holds one spec per discipline and
      resolves **both** the console's ids and the server's canonical ones, which fixes the
      live bug where a server-imported tournament fell back to the 15-Ball sheet
      (`gameOf()`'s unknown-game fallback). 14.1 gets its own rack sheet (14 balls, 8 racks,
      RUNNING TOTAL, FINAL MATCH TOTAL, goals 75/100); the race disciplines get a games
      tally inside the sheet chrome and the second counter modal is gone. Docs: 14.1's paper
      sheet + rules PDF and their builders under `docs/`, `DECISIONS/021`, and
      `.gitattributes` marking `*.pdf` binary (CRLF corruption of a PDF's xref offsets).
      Tests: `sheets.test.js` (new); `app-render.test.js`'s harness now loads `sheets.js`,
      as `index.html` does. Frontend only — nothing new pending on a service restart.
- [x] Slice Q — one model per game, and every quick-add control deleted. `Sheets.spec(game).measure`
      ("balls" | "wins") is the declared way a discipline is scored and the only thing that decides
      its controls; `Sheets.kind(game)` (the body, and the `_kind` a saved sheet stores) is derived
      from it. All twelve `+5`/`+10`/`−5` controls are gone (six with the counter modal in Slice P,
      six from the ported race body here), with the `pointsMode` (`raceTo >= 50`) heuristic, its
      delegate case and its dead CSS (`counter-jumps`, `counter-jump`, `counter-check`,
      `modal-card-md`). Every discipline declares `quickAdd: []`, and `raceSet()` clamps the tally to
      the race target, so a step cannot carry a race to 7 past 7. Tests (red first, then green, each
      guard falsified): `sheets.test.js` measure/body/quickAdd pins; `app-render.test.js` no jump
      control in any dialog for any discipline + nine steps on a race to 7 leave 7 (`'9' !== '7'`
      with the clamp removed). Frontend only.
- [x] Slice S — the score sheet as a saved stack, and the race carried by the bracket
      (branch `sheet-stack`). **The race is bracket data**: migration `0018_race_to.sql` adds
      `divisions.race_to` and `matches.race_to`, resolved `match ?? division ?? game default`
      (`internal/api/games.go`, mirroring `GAMES[*].defaultRaceTo`), exposed on the match
      payload as `raceTo` + `raceFrom` and on the division as a resolved `raceTo`; the write
      paths are `POST …/divisions` (optional `raceTo`), new `PATCH …/divisions/{divisionId}`
      and `PATCH …/matches/{matchId}` — both director+ on their own routes, out of the
      open-scoring group, absent ≠ null. Resolution lives in `scanMatch`/`scanDivision`, so
      every surface (list, submit response, snapshot) reports it; `MatchHistory` versions now
      carry `payload` + `submittedByEmail`. **The sheet is one record**: `sheet-payload.js`
      (new) defines the payload the result endpoint stores verbatim — payload version 2 (v1
      sheets, whose origin key was the match payload's `raceFrom` word, still read: the reader
      maps the old key), kind
      (rack/race) and `sheetKind` (the instrument: rack/tally), discipline, measure, goals,
      the race snapshot + its `raceOrigin` (the record's own key — the match payload's
      `raceFrom` is the *layer*, `match`|`division`|`default`), per-rack detail where the
      discipline has racks, finals, winner, names, app + version — and the live console
      submits it once per result behind an
      `Idempotency-Key` (the one-tap winner control is gone; the sheet is the record, and an
      `in_progress` match opens it). The stack is the read side: the console lists a played
      match's saved sheets newest first with who saved them and when and shows the selected
      version; a correction is a new version (reopen → re-submit), never a rewrite. The phone's
      payload (`app: "score-android"`, a plain tally, no `sheetKind`) is read as a tally and its
      hand-typed race as an explicit override — the convention is documented in `AGENTS.md`,
      no Java changed. **Corrections**: 15-Ball Rotation's own targets/hint (25/50, 60-ball
      4-rack ceiling) instead of 14.1's copied line, 14.1 no longer advertises 150, One Pocket's
      race-of-games and 8-balls-in-your-own-pocket lines split, the 14.1 paper sheet + rules
      PDFs linked from both headers, the offline console saying it saves **on this device**, and
      the bracket card printing win/loss only. Tests: `sheet-payload.test.js` (new),
      `overlay-bracket.test.js` (new), `live-console.test.js`, `api-client.test.js`,
      `app-render.test.js`, `sheets.test.js`; Go `internal/api/race_to_test.go` (scenarios
      49–54). Every new guard falsified (break → red → restore). Docs: `DECISIONS/023`.
      **Deployment:** migration `0018_race_to.sql` applies on the next service start.
- [x] Slice R — swipe to step the tally, ported from the Android app's `SwipePanel`. A
      mostly-vertical drag past 48 CSS px on either half of the games tally is one step for that
      side (up +1, down −1), one step per gesture, taken from the child (the panel keeps the
      pointer and cancels the click, so a drag that starts on `+` scores exactly once), gated to
      touch/pen pointers so a mouse drag never hijacks scrolling, and wired to the same
      `raceInc`/`raceDec` the ± buttons call. Haptics only via `navigator.vibrate` where the
      platform offers it; `.race` gets `touch-action: pan-x` so a phone delivers the drag rather
      than scrolling it. Docs: `DECISIONS/022-swipe-to-score.md`. Tests: `app-render.test.js`
      drives real pointer events — one step per gesture however far the finger travels, the half
      test at the midpoint, a downward drag and its zero floor, a sub-threshold drag, a
      horizontal drag, a non-vertical-dominant diagonal, a mouse drag, and the cancelled button
      press — with all six guards falsified (remove threshold / dominance / pointer gate /
      one-step flag / click cancel / half test → the matching assertion fails). Frontend only.


- [x] Slice T — the printed-sheet queue (decision 018, unbuilt since 2026-08-16). The desk gets
      pre-filled paper: bracket.js has carried the per-match lifecycle since the deck landed
      (`sheetIssuedAt` / `sheetIssueVersion` / `sheetPlayersSnapshot`, `isMatchReady`,
      `sheetIsStale`, `markSheetIssued`, and `markSheetStaleIfIssued` wired into
      `clearDownstream` — the auto-void-on-edit), and this round built the queue on top:
      `sheet-queue.js` (new, pure) is the state (pending | ready | printed | stale, the issue
      record, Round 1's batch, the voided arithmetic, the print URL, and the two merges that
      keep the console and the print page from overwriting each other's records), `print.html` /
      `print.js` / `print.css` (new) are the queue page — Ready to print, Recently printed
      (collapsed, newest first, 20), the voided chip, and one paper sheet per page at
      `@page { size: letter; margin: 0.5in }` — and `app.js` carries a control per match card
      (`Sheet`, or amber `Reprint (vN)`) plus `Print all Round 1 sheets (N)`. Four things the
      design predated: the sheet body comes from `Sheets.spec` per discipline and its target from
      the tournament's `raceTo` (023); a changed target now voids the paper (`sheetRaceTo` in the
      snapshot); the Round 1 batch prints only what still needs paper, because every issue is a
      version; and the voided audit is the chip the design allowed. **Two gaps, marked in 018**:
      the table number prints blank — the data exists as the server's `matches.table_ref` (Slice
      J), but `print.html` builds from this console's localStorage, which has no assignment; and
      the queue's printed/voided markers are per browser (023 stores the sheets themselves on the
      server, so a played match's sheet is retrievable). Tests: `sheet-queue.test.js` (new, 74
      assertions, including the three bracket-propagation cases 018 demands — Round 1 ready at
      build, saving R1M1+R1M2 making SF1 ready, editing a saved winner making its downstream
      sheet a reprint with the version bumped by one — plus the console's own rebuild path) and
      `app-render.test.js` (+5: the ready control, the amber reprint at the version it will
      print as, a current sheet offering nothing, a save keeping a record the print page wrote,
      a rebuild keeping what it did not rebuild). Falsified guard by guard; observed live in
      headless Chromium against the repo root (9-ball tally: four ±1 controls, zero jump
      controls, seven taps → 7 + winner, an eighth tap still 7; 14.1: 8 racks × 14 circles,
      RUNNING TOTAL, FINAL MATCH TOTAL, 3 balls + 1 foul → RACK TOTAL 2 / FINAL 2; the queue
      recording v1 on the four Round 1 sheets and, after a rename, printing a sheet stamped
      `REPRINT - v3 - 2026-10-15T18:57:48.915Z`). Docs: `DECISIONS/018` (implemented),
      `DECISIONS/021` (the published-PDF pairing rule + the printed sheet's table).
