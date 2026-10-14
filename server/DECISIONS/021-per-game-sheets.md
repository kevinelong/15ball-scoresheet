# DECISION 021 — One score sheet per discipline (game-specific sheets)

**Status:** Implemented (2026-10-12). Frontend only; no server change.

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

| game (canonical id) | kind | balls/rack | racks | goals | final label |
|---|---|---|---|---|---|
| `15ball_rotation` | rack | 15 | 4 | 25 / 50 | FINAL GAME TOTAL |
| `straight_14_1` | rack | 14 | 8 | 75 / 100 | FINAL MATCH TOTAL |
| `8ball`, `9ball`, `10ball`, `one_pocket`, `bank_pool` | race | — | — | — | — |

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
  are gone. The race body reuses the counter's `+/−`/jump markup and CSS inside the sheet, because a
  tally is the right instrument for a race.
- **A hidden section must beat its own display rule.** `.racks` is `display:flex` and `.totals` is
  `display:grid`, so the bare `hidden` attribute did nothing until `.racks[hidden]`, `.race[hidden]`,
  `.totals[hidden]` and `.goalbox[hidden]` were added to `styles.css`. This was caught by screenshot,
  not by reading the DOM, and is the reason the checklist below asserts *visibility*.

## Non-goals

- Changing 15-Ball Rotation's sheet in any way (its rack geometry, goals, columns and total label are
  the ones it always had — this is a regression surface, covered below).
- Adding disciplines the server does not accept. The server's list is fixed at create:
  `15ball_rotation`, `8ball`, `9ball`, `10ball`, `straight_14_1`, `bank_pool`, `one_pocket`.
- Per-discipline *printed* sheets (message 018's print queue) — separate feature, still unbuilt.

## Test coverage required

- `sheets.test.js` (new, run `node sheets.test.js`): both spellings resolve, unknown games fall back,
  14.1 is 14 × 8 with a RUNNING TOTAL column and 75/100 goals, rotation is 15 × 4 with GAME SUBTOTAL
  and 25/50, exactly two disciplines mark balls, `goals()` returns a copy.
- Existing suites must stay green: `node bracket.test.js`, `roster.test.js`, `tables.test.js`,
  `migration.test.js`.

Manual QA checklist (all run against Chromium, served from the repo root):

- **14.1** — click a bracket match: title "Straight Pool (14.1 Continuous)", 8 racks, **14** circles a
  side, columns BALLS MADE / FOULS / RACK TOTAL / **RUNNING TOTAL**, goals 75/100/OTHER with the
  tournament's target pre-checked, "FINAL MATCH TOTAL", no race body, no phantom rack grid.
- Marking 3 balls and 1 foul in rack 1 gives BALLS MADE 3, RACK TOTAL 2, RUNNING TOTAL 2, FINAL 2.
- **9-Ball** — click a match: the rack grid, the totals row and the goal boxes are hidden; the race
  body shows both names, "Race to 7" and the +/− and jump controls; seven taps selects Player A as
  the winner; Save records `{_kind:"race", finalA:7, finalB:0, winner:"A"}` and advances the bracket.
- **15-Ball Rotation** — click a match: 4 racks, 15 circles a side with solid/stripe faces, GAME
  SUBTOTAL and FINAL GAME TOTAL, goals 25/50, race body hidden. Unchanged from before this decision.
- No page errors in the console on any of the three.
