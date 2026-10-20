# DECISION 021 — One score sheet per discipline (game-specific sheets)

**Status:** Implemented (2026-10-12); ported onto `main` and its controls reworked 2026-10-14 —
see "How a discipline is measured is data" and "No quick-add control" under Rules. Frontend only;
no server change. Its spec table is now what the *printed* sheet is built from too (2026-10-15,
decision 018 — see "The printed sheet" at the end).

**Owner surface:** frontend (`index.html`, `app.js`, `styles.css`, new `sheets.js` + `sheets.test.js`).

## Problem

Clicking a match in the bracket opened the right sheet only for 15-Ball Rotation. Every other
discipline — 8/9/10-Ball, One Pocket, Straight Pool (14.1), Bank Pool — fell through to a separate
"counter" modal: two numbers and a +/− pair, with an auto-winner at the race target
(`openMatch` branched on `GAMES[game].sheetType === "counter"`). For the games-won disciplines that
instrument was roughly right and merely looked generic; for the two *ball-marked* disciplines it was
wrong — 14.1 is played to 75/100 points and its paper sheet records 14 balls a rack with a running
total, none of which the counter could express. The paper-sheet visual language the app already had
(message 018: "reuses the paper-sheet visual language from `docs/_scoresheet_draw.py`") was therefore
reachable for exactly one of the seven disciplines.

## Decision

The match click always opens the sheet modal, and the sheet's *body* is chosen by the tournament's
game. 15-Ball Rotation keeps the sheet it had, byte for byte in behaviour; 14.1 gets its own rack
sheet (14 balls, 8 racks, RUNNING TOTAL, goals 75/100); the games-won disciplines get a tally body
*inside the same sheet chrome* — names, signatures, winner box, brand — instead of a second modal.

The per-discipline facts live in one small module, `sheets.js`, as data:

| game (canonical id) | measure | balls/rack | racks | goals | final label |
|---|---|---|---|---|---|
| `15ball_rotation` | balls | 15 | 4 | 25 / 50 | FINAL GAME TOTAL |
| `straight_14_1` | balls | 14 | 8 | 75 / 100 | FINAL MATCH TOTAL |
| `8ball`, `9ball`, `10ball`, `one_pocket`, `bank_pool` | wins | — | — | — | — |

## Rules

- **`sheets.js` resolves both spellings of a game.** The app has always used its own ids for some
  disciplines (`fifteenBall`, `14_1`, `onepocket`, `banks`) while the tournament server uses
  canonical ones (`15ball_rotation`, `straight_14_1`, `one_pocket`, `bank_pool`). `Sheets.id()`
  resolves both, plus the `kball` id the app renamed in place, so a tournament imported from the
  server and one built in the app get the same sheet. An unknown game falls back to 15-Ball Rotation.
- **Pool-ball faces only where the number is the point value.** 15-Ball Rotation marks specific balls
  (solid/stripe faces, `ballKind`); straight pool marks a *count*, so its circles are plain — the same
  choice the paper sheet makes.
- **14.1 gets 8 racks** because 8 × 14 = 112 balls and a match to 100 needs them. The paper sheet is
  built the same way (`docs/build_141_paper_sheet.py`).
- **The winner is still the desk's call.** A race sheet auto-selects the winner when a side reaches
  the race target; a rack sheet auto-selects when a side reaches `raceTo`. Both can be overridden in
  the WINNER box below the signatures, and a sheet can be saved with no winner (the bracket then does
  not advance) exactly as before.
- **Stored sheet shape is unchanged for existing data.** A rack sheet is `{racks:[…], finalA, finalB,
  winner, …}` (no `_kind`, as before); a race sheet is `{_kind:"race", finalA, finalB, winner, …}` —
  the shape the counter modal already wrote, so sheets saved before this decision reload correctly.
  New rack sheets also carry `_kind:"rack"`; readers must treat a missing `_kind` as a rack sheet.
- **No second modal.** `#counterModal`, its styles' markup, its action cases and its save/clear pair
  are gone. The race body is the counter's `+/−`/target markup and CSS inside the sheet, because a
  tally is the right instrument for a race.
- **How a discipline is measured is data, and it decides the controls.** `Sheets.spec(game).measure`
  is `"balls"` (marked one at a time — the sheet is a rack grid) or `"wins"` (stepped — the sheet is a
  tally against the race target). The sheet body (`Sheets.kind(game)`, `"rack"` / `"race"`, also the
  `_kind` a saved sheet stores) is derived from it, so the body and the measurement cannot disagree,
  and an unknown game measures as rotation. Nothing infers the controls from a number any more: the
  console used to guess "points mode" from `raceTo >= 50`, which was wrong both ways — a small points
  target got no controls, and a win-measured race got jumps.
- **No quick-add control, for any discipline.** `Sheets.spec(game).quickAdd` lists the jump controls a
  tally offers, and every discipline offers none: a jump is one tap that can overshoot the race it is
  scoring (three taps took a race to 7 to 15, and the winner was selected for the desk). The step is
  the instrument. The field stays in the spec so "which controls this discipline gets" is declared
  with the rest of the discipline, and `app-render.test.js` asserts both the empty declaration, for
  every discipline, and that no `+5`/`+10`/`−5` control or wrapper survives in the markup.
- **A tally cannot pass its target.** `raceSet()` clamps to the race target, so a race to 7 reads at
  most 7 however the step is reached (a step, a tap, or a stored sheet whose target has since been
  lowered). The winner still auto-selects the moment a side reaches the target, and the desk can still
  override it in the WINNER box.
- **A hidden section must beat its own display rule.** `.racks` is `display:flex` and `.totals` is
  `display:grid`, so the bare `hidden` attribute did nothing until `.racks[hidden]`, `.race[hidden]`,
  `.totals[hidden]` and `.goalbox[hidden]` were added to `styles.css`. This was caught by screenshot,
  not by reading the DOM, and is the reason the checklist below asserts *visibility*.

## Non-goals

- Changing 15-Ball Rotation's sheet in any way (its rack geometry, goals, columns and total label are
  the ones it always had — this is a regression surface, covered below).
- Adding disciplines the server does not accept. The server's list is fixed at create:
  `15ball_rotation`, `8ball`, `9ball`, `10ball`, `straight_14_1`, `bank_pool`, `one_pocket`.
- Per-discipline *printed* sheets (message 018's print queue) — built 2026-10-15; see below and
  `018-printable-sheets.md`.

## Published PDFs — the sheet and its rules go together

Each paper sheet carries a QR to its own discipline's rules, so a PDF pair is only correct when
both halves are live: **`docs/<discipline>-paper-sheet.pdf` and `docs/<discipline>-rules.pdf` are
published together or not at all.** The 14.1 sheet's QR is hard-coded to
`https://kevinelong.github.io/15ball-scoresheet/docs/141-rules.pdf` (`RULES_PDF_URL` in
`docs/_scoresheet_141_draw.py`, read by `docs/build_141_paper_sheet.py`), which 404s — on a sheet
already in a player's hand, with no way to tell — until that file is on GitHub Pages. The 15-Ball
pair is the same rule with `docs/15ball-rules.pdf`.

GitHub Pages serves this repository's `main` branch at the site root
(`gh api repos/kevinelong/15ball-scoresheet/pages` → `source: { branch: "main", path: "/" }`), so
"published" means *committed to `main` and pushed*, nothing else — there is no separate publish
step and no `gh-pages` branch. As of 2026-10-15 both 14.1 files are on `main` and both resolve on
the live site (`docs/141-rules.pdf` and `docs/141-paper-sheet.pdf` → HTTP 200), so the 14.1 QR is
good; a change to either PDF must land with the other in the same push.

Background worth keeping: the QR is drawn by `draw_qr`, which raises rather than printing a
placeholder when `qrcode` is not installed — the 15-Ball pair in this repository still carries
placeholder squares from a build machine without it, so a 15-Ball sheet rebuilt today would print
a QR-shaped box that scans as nothing.

## The printed sheet (decision 018, built 2026-10-15)

The in-app sheet above is the *screen* sheet. The **paper** the desk hands out is `print.html`
(decision 018), and it takes its body from this same `sheets.js`: a rack grid for the ball-measured
disciplines with their own columns and total wording, a games tally for the race ones, and the
target printed from the tournament's race. Adding a discipline to `DEFS` here therefore changes
the printed sheet too — the two cannot drift, which is the reason the spec table is data.

## Test coverage required

- `sheets.test.js` (new, run `node sheets.test.js`): both spellings resolve, unknown games fall back,
  14.1 is 14 × 8 with a RUNNING TOTAL column and 75/100 goals, rotation is 15 × 4 with GAME SUBTOTAL
  and 25/50, exactly two disciplines mark balls, `goals()` returns a copy, `measure` and the rendered
  body agree for every discipline, every discipline declares its jump controls and none offers one.
- `app-render.test.js`: no dialog offers a `+5`/`+10`/`−5` control, for any discipline, and a
  win-measured race's goal selects the winner but does not cap a step (nor does a stray jump score).
- Existing suites must stay green: `node bracket.test.js`, `roster.test.js`, `tables.test.js`,
  `migration.test.js`.

Manual QA checklist (all run against Chromium, served from the repo root):

- **14.1** — click a bracket match: title "Straight Pool (14.1 Continuous)", 8 racks, **14** circles a
  side, columns BALLS MADE / FOULS / RACK TOTAL / **RUNNING TOTAL**, goals 75/100/OTHER with the
  tournament's target pre-checked, "FINAL MATCH TOTAL", no race body, no phantom rack grid.
- Marking 3 balls and 1 foul in rack 1 gives BALLS MADE 3, RACK TOTAL 2, RUNNING TOTAL 2, FINAL 2.
- **9-Ball** — click a match: the rack grid, the totals row and the goal boxes are hidden; the race
  body shows both names, "Race to 7" and the +/− step buttons, and **no** jump buttons; seven taps
  selects Player A as the winner and an eighth tap leaves the tally at 7; Save records
  `{_kind:"race", finalA:7, finalB:0, winner:"A"}` and advances the bracket.
- **15-Ball Rotation** — click a match: 4 racks, 15 circles a side with solid/stripe faces, GAME
  SUBTOTAL and FINAL GAME TOTAL, goals 25/50, race body hidden. Unchanged from before this decision.
- No page errors in the console on any of the three.
