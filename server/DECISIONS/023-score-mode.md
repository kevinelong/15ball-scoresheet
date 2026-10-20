# DECISION 023 — Score mode: the full-screen two-half tally

**Status:** Implemented (2026-10-20). Frontend only.

## Surface

A games-won match **opens in Score mode**, a fixed, non-scrolling overlay:

- Two halves side by side, on desktop and mobile. Each half is a vertical column:
  name, `▲ +`, the tally, `▼ −`. The arrows make the vertical axis (and the swipe)
  self-explanatory.
- The **score number is itself a `+` control**: tapping it adds a game, exactly like
  the arrow above it. The arrows are twice the old height (`16vh`, floored at 112px,
  capped at 160px), and the symbol is a **true cutout** in the chevron
  (`fill-rule="evenodd"`): white triangle, button-background `+`/`−`. That makes the
  tall control one readable glyph instead of a sparse `▲ +` pair; a short-landscape
  rule keeps both halves usable.
- Player names live in the halves. The bottom bar carries **View Score Sheet** on the
  left, the **goal** with a **winner chip** beneath it in the center, and Done / Save
  result on the right. Main bar buttons are at least 44px tall.
- Score mode is the scoring surface. The sheet is a detail view reached by View Score
  Sheet; its prominent **Back to Score Mode** returns, and a race sheet has no Save
  (Save lives in score mode). Done closes the match.
- The **whole half** is a swipe target (`wireSwipe`); the arrows take the same step.
  A gesture is one step, up `+1` / down `−1`, on the half it started in. A **mouse drag**
  works here too: the overlay never scrolls, while the sheet tally stays touch/pen so the
  modal keeps mouse scrolling.
- A drag past an 8px slop **cancels its release click** even when it is below the 48px
  step, so a wobble on the score or an arrow cannot add a game.
- The **winner chip** shows the current pick (`Winner: <name>` / `No winner`); tapping
  it cycles no winner → A → B → no winner. An automatic pick is cleared (or moved to the
  other side) when a correction invalidates it; a manual pick is never touched.
- The in-progress sheet **autosaves** (debounced) and flushes synchronously on Done,
  `pagehide`, and hidden visibility, so a reload resumes the tally.
- A tally may go **negative** and may finish **over the goal**: the goal selects the
  winner (first to reach it), it is not a ceiling — 14.1 and 15-ball runs may finish
  past it. The bar reads **Goal N**, not “Race to N”.
- The overlay fills `100dvh`; the app does **not** request fullscreen on open (the
  browser's own remains available). No scrolling: `overflow: hidden`,
  `overscroll-behavior: none`, `touch-action: pan-x`, safe-area insets, and the
  document scroll is locked while it is open.
- The score button's aria-label includes its value; a one-time toast explains the
  swipe on first use.
- The overlay reads and writes the sheet's own tally (`raceGet`/`raceSet`), so
  entering and exiting loses nothing.
- Ball-marked sheets have no Score mode: they mark balls, not games, and keep their
  own Save on the sheet.

## Palette (from the Android scorer)

- Panels at half saturation: A `#4b805f` / white (4.6:1); B `#8a574f` / `#ffe8a4`
  (4.8:1 at the 15px name). Colour is never the only signal: glyph, position and
  labels carry the meaning.
- Action tiles at 75% saturation: `+` `#1b6b39`, `−` `#852e21`.
- Utilities are neutral (`#121820` bar), not a third hue.

## Submitting without a declared winner

- A player who has **reached their own goal while the other has not** is the winner,
  handicap or not — e.g. A's goal 25 reached at 30 while B's goal 50 is only at 40,
  even though B is numerically ahead.
- Otherwise a sheet with a leader **assumes the player ahead** is the winner and
  advances the bracket.
- A **level score** assumes nothing.
- A **handicap with different goals** (rack sheets: `goalA !== goalB`) where neither
  side has reached its goal assumes nothing: "ahead" cannot decide a match whose
  sides race to different targets.
- In those two cases the desk is asked to save the sheet as in-progress (or to pick
  the winner). The live console's Save applies the same "ahead wins" rule; its model
  has one shared race target, so it has no handicap case.

## Scope

Score mode is for **games-won** (`WINS`) disciplines. Ball-marked disciplines (14.1 and
15-ball) use the rack sheet; their point totals are already uncapped and the goal is a
threshold there too.

## Non-goals

- Not forced app-wide: score mode opens when a games-won match is opened, while a
  ball-marked sheet keeps the rack grid. The sheet remains the admin/signature surface.
- No per-game jump controls; the `±1` step is the instrument that cannot overshoot.
