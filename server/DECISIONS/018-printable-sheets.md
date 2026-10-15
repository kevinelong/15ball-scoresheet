# DECISION 018 — Printable score sheets (per match, live queue, auto-void on edit)

**Status:** Implemented (2026-10-15), frontend only. The design below was agreed 2026-08-16 and half of it had already landed in `bracket.js` (the per-match lifecycle fields and primitives, wired into `clearDownstream`); the queue, the print page and the controls were built on top of it on 2026-10-15. See "Implementation (2026-10-15)" at the end, which also records the four things decisions 021/022/023 changed under this design, and the two gaps left.

**Owner surface:** frontend (`index.html`, `app.js`, `styles.css`, new `print.html` / `print.js`).

## Problem

Bracket desk needs pre-filled paper score sheets to hand to each table as matches become ready. Filling names + goal + table number by hand for every match wastes time and introduces spelling/goal errors. Kevin also wants a single click for the whole first round, then one-at-a-time as later matches receive both players.

## Decision

Frontend generates printable HTML score sheets on demand. Browser `window.print()` renders them to paper (no PDF library, no server dependency yet). Sheet issuance is event-driven: automatic for Round 1 as soon as the bracket is built, then per-match as each downstream match becomes ready. Editing a saved winner automatically voids and regenerates any downstream sheet whose player names changed.

## Rules

### Match sheet-state (per match, in-memory + persisted to localStorage)

Each match gains three fields:

- `sheetIssuedAt: ISO-8601 | null` — when a sheet was last generated for this match.
- `sheetIssueVersion: integer` — increments each regen (v1 first, v2 on first reprint, etc.).
- `sheetPlayersSnapshot: [name, name] | null` — the resolved names printed on the most-recently-issued sheet.

A match is **ready for sheet** when both `players[0]` and `players[1]` resolve to concrete player names (not `W1`/`L3` placeholders).

A match's issued sheet is **stale** when:

- `sheetPlayersSnapshot` differs from the current resolved `players`, OR
- an ancestor match's winner was edited after `sheetIssuedAt`.

Stale sheets auto-regenerate: `sheetIssueVersion += 1`, `sheetPlayersSnapshot` refreshes, `sheetIssuedAt` refreshes. The prior paper copy is implicitly void — the reprinted sheet carries a **"REPRINT — v{N}"** stamp with the new timestamp so the desk can visually distinguish.

### Round 1 batch print

When the bracket is built (or seeds change while still in Round 1), Round 1 matches transition to ready in one step. UI exposes a top-level `Print all Round 1 sheets` button that opens a print dialog for all Round 1 sheets at once (one sheet per printed page).

### Later-round matches

When a match result is saved:

1. Compute the downstream match's new `players` from the bracket rules (existing logic).
2. If it now has both players resolved AND `sheetIssuedAt` is null → mark newly-ready. UI shows a "Print sheet" button on that match card.
3. If it already had a sheet and the player names now differ → auto-regenerate (bump version, refresh snapshot + timestamp). UI shows an amber "Reprint (v{N})" button.

### UI surfaces

- **Bracket page (existing):** each match card gets a small `🖨 Sheet` button once ready. Amber `🖨 Reprint (v2)` when stale. Top of page: `🖨 Print all Round 1 sheets` shown while Round 1 has ≥1 unprinted ready sheet.
- **`/print/` page (new `print.html` at `15ball-scoresheet/print.html`):** live queue keyed by `?t=<tournamentId>` (URL hash `#t=<id>` also fine). Three sections:
  - **Ready to Print** — matches ready with no sheet yet OR with a stale sheet.
  - **Recently Printed** — collapsed, last 20 by timestamp.
  - **Voided** — historical audit trail of voided-then-regenerated sheets (optional; can render as a small counter chip on the Recently Printed row if space is tight).

  Refreshes across tabs via `window.addEventListener('storage', ...)`.

### Printable sheet content

Reuses the paper-sheet visual language from `docs/_scoresheet_draw.py` (single sheet, HOW TO SCORE strip and 15-BALL RULES SUMMARY retained on every printed sheet, 4 racks, totals, signatures) but rendered as HTML/CSS with `@page { size: letter; margin: 0.5in }`.

Pre-filled at print time:

- Player A name (from resolved bracket).
- Player B name.
- Goal checkbox pre-checked from bracket's format setting (25 rec / 50 pro).
- **Small header pill**: `Table {N} · {round-label} · Match {M}` (e.g. "Table 3 · R1 · Match 7").
- If `sheetIssueVersion > 1`: red **"REPRINT — v{N} · {timestamp}"** banner at the very top.

### State migration

Existing tournaments in localStorage without the new fields → treat as if never issued. First bracket-page render after upgrade populates the ready-list from scratch.

## Non-goals

- Server-side persistence — deferred until Go backend ships (`impl` agent scope).
- Multi-tenant tournaments — same as current app assumption (one tournament at a time in localStorage).
- Printing arbitrary blank sheets — that's the existing paper-blank PDF; unchanged.

## Open questions

- None blocking. **Superseded 2026-10-15:** the one line here used to reserve the feature
  ("Impl agent should NOT touch this feature yet"); it is implemented now, and what is left
  open is listed under "The gaps, marked" below. The client-side sheet stack and its server
  read side arrived as decision 023.

## Test coverage required

- `bracket.test.js`: extend with tests that (a) Round 1 matches become ready as soon as bracket builds; (b) saving a Round 1 winner makes the correct SF match ready-for-sheet; (c) editing an already-saved Round 1 winner marks its downstream SF as needing reprint AND bumps `sheetIssueVersion`.
- Manual QA checklist:
  - Build 8-player bracket → Round 1 sheets all show as ready → print-all works.
  - Save R1M1 result → SF1 not ready yet (waiting on M2).
  - Save R1M2 result → SF1 becomes ready.
  - Edit R1M1 winner from Alice to Bob → SF1 sheet marked stale, version bumped, REPRINT banner appears.

## Implementation (2026-10-15)

### What was already there

Half the design was built in `bracket.js` when the deck landed and never had a UI:

- every match is born with `sheetIssuedAt: null`, `sheetIssueVersion: 0`,
  `sheetPlayersSnapshot: null` (and now `sheetRaceTo: null` — see the target change below);
- `isMatchReady(match)` (both slots concrete names — the design's "ready for sheet");
- `sheetIsStale(match, raceTo?)` (the snapshot no longer matches the slots);
- `markSheetIssued(match, now, raceTo?)` (version + 1 per issue, snapshot, stamp);
- `markSheetStaleIfIssued(match)`, called from `clearDownstream`, which is the design's
  **auto-void on edit**: editing an upstream winner clears the downstream slots and nulls the
  downstream snapshot, so the moment new names arrive that sheet reads as a reprint.
  `sheetIsStale` is the design's staleness rule, and the "or an ancestor's winner was edited
  after `sheetIssuedAt`" clause is the same fact seen from the other end: the edit changes the
  names that flow into the sheet.

So this decision was never a loose "unbuilt feature": what was missing was the queue, the
page that prints, and the controls.

### What this round added

| file | what |
|---|---|
| `sheet-queue.js` (new) | the queue over the lifecycle above: `state()` → `pending`/`ready`/`printed`/`stale`, `issue()`, `mark()`, `label()`, `entries()`, `roundOne()`, `voided()`, `queue()`, `selection()`, `uri()`, `restore()`, `adopt()`, `carry()`. Pure: no DOM, no storage, no clock of its own, so the bracket page, the print page and `node sheet-queue.test.js` all run the same code |
| `print.html`, `print.js`, `print.css` (new) | the queue page keyed `?t=<id>` (optionally `&m=<matchId>`, `&round=1`): **Ready to print** / **Recently printed** (collapsed, newest first, `RECENT_LIMIT` = 20) / the **voided** count as a chip, plus the paper sheets themselves — one per printed page, `@page { size: letter; margin: 0.5in }`, the queue chrome `no-print` |
| `app.js` | a control per match card (`Sheet`, or amber `Reprint (vN)`), the `Print all Round 1 sheets (N)` batch on the bracket page, the print-page opener, and the cross-page merge in `persist()` |
| `index.html`, `styles.css` | the batch button, `sheet-queue.js` in the script order, `.sheetbtn` |
| `bracket.js` | `sheetRaceTo` on every match, in the snapshot and in `sheetIsStale`'s optional second argument |

### Four things the later decisions changed under this design

1. **The sheet's body is the discipline's, and so is its target.** The design's "goal checkbox
   pre-checked from bracket's format setting (25 rec / 50 pro)" predates 021 (one sheet per
   discipline, geometry and columns from `sheets.js`) and 023 (the race is bracket data). The
   printed sheet therefore takes its body from `Sheets.spec(game)` — a rack grid for the
   ball-measured disciplines, a games tally for the race ones — and its target from the
   tournament's `raceTo` (pre-checked in the goal box when it is one of the discipline's own
   presets, else the discipline's first; the race body prints `RACE TO {n}`).
2. **A changed target voids the paper, like a changed name.** The design's snapshot was the two
   names. The paper now names the race too, so `markSheetIssued` records `sheetRaceTo` and
   `sheetIsStale` compares it when the caller knows the tournament's target: lowering a
   tournament's race from 25 to 15 must not leave 25 printed on a sheet the desk is still
   handing out.
3. **Round 1's batch prints what still needs paper, not every Round 1 sheet.** Printed through
   `markSheetIssued`, every issue is a version, so re-printing a sheet that is still current
   would void good paper and stamp it REPRINT. The batch's count and its label match exactly
   what it prints, and it hides at 0. A current sheet is still reprintable one at a time, from
   **Recently printed** ("Print another copy (vN)").
4. **The voided section is the chip.** The design allowed the audit list to be "optional; can
   render as a small counter chip"; it is the chip, and the count is the design's own
   arithmetic: every issue past a match's first superseded one paper copy, so the queue-wide
   voided count is `sum(sheetIssueVersion - 1)`.

### The gaps, marked

- **The table number is printed blank** (`Table ________ · R1 · Match 1 · …`). The design asks
  for a pre-filled `Table {N}`, and the console that prints has nothing to fill it from: its
  `tables[]` is the room's list of tables, not which match is on which, and nothing in
  `index.html`/`app.js` ever assigns a match to a table (checked: no `tableRef` anywhere on this
  side). A guessed table number on a sheet the desk hands to a table is worse than a blank to
  write in, because a wrong sheet gets scored by the wrong players.
  **The data does exist — on the other surface:** the server console assigns
  `matches.table_ref` (`POST …/matches/{id}/assign {tableRef}`, Slice J, migration 0008), it is
  on the match JSON, and it is what the SMS alert ("your match is at table N") and
  `overlay-live.js`'s table tag read. So this is blocked on the *printed sheet being the server
  console's*, not on the data: `print.html` builds from this console's `localStorage`, where
  there is no assignment.
  A printed sheet in `live.html` (which sees `tableRef`) or a table assignment added to this
  console would close it.
- **The queue's printed/voided state is per browser.** It rides on the bracket in
  `localStorage`, exactly as designed ("frontend-first (localStorage)"), so two desk devices
  have two queues and a cleared browser history forgets what was printed on paper. The
  *sheets themselves* are a different matter and are already server-side: 023 stores the sheet
  record through the result endpoint, so a played match's sheet is retrievable by anyone. Moving
  the print queue's markers to the server is a later decision with the queue's shape already
  fixed.
- Printing itself is `window.print()`: layout and pagination on real paper were not verified
  (the sheets were checked in a browser, and what `window.print()` receives was captured and
  read, but no printer was involved).

### Tests

- `sheet-queue.test.js` (new, 74 assertions) carries the three cases this decision requires —
  Round 1 ready the moment the bracket is built, saving a Round 1 winner making the right
  semi-final ready, editing a saved winner making the downstream sheet a reprint with
  `sheetIssueVersion` bumped by exactly one — **plus** the same three through the console's own
  edit path (rebuild from participants → `carry()` → replay), the sections of the queue, the
  newest-first cap, the voided arithmetic, `selection`, `uri`, `adopt`/`restore` and reading a
  record an older console left.
  Those three cases live here rather than in `bracket.test.js` (which this decision asks for)
  because the state they assert is the queue's: `bracket.test.js` stays the engine's own suite.
- `app-render.test.js` (+5 tests) drives the console's markup: a ready card's control, a stale
  card's amber `Reprint (v2)`, a current sheet offering nothing (and leaving the batch count),
  a save keeping a record the print page wrote, and a rebuild keeping what it did not rebuild.
- Falsification (break → red → restore): every guard in `sheet-queue.js` — the ready rule, the
  snapshot comparison, the target comparison, the version arithmetic, the pending guard, the
  `RECENT_LIMIT` cap and its ordering, the voided arithmetic, `adopt`'s newer-wins direction,
  `carry`'s id match, `uri`'s encoding — and in the console, the card control's state gate, the
  batch count, `adopt` on save and `carry` on rebuild.
- Observed live (headless Chromium, the console served from the repo root): 9-ball gives the
  tally with four ±1 controls and **zero** jump controls (seven taps → 7 and the winner
  selected, an eighth tap leaves it at 7); 14.1 gives 8 racks × 14 circles a side, RUNNING
  TOTAL, `FINAL MATCH TOTAL`, goals 75/100 with the tournament's 100 pre-checked, and 3 marked
  balls with 1 foul → RACK TOTAL 2, FINAL 2; the queue page shows the four Round 1 sheets, and
  printing them records v1 on all four, moves them to Recently printed and — after a rename —
  offers `Reprint (v2)` and prints a sheet whose captured markup carries
  `REPRINT - v3 - 2026-10-15T18:57:48.915Z`. A downstream sheet whose pairing has gone away — a
  printed sheet on a match whose slot an upstream correction cleared and nothing has refilled yet —
  is listed as `pairing not set · waiting on both players · nothing to print yet`, with **no** print
  control, is left out of the Ready-to-print count, and is not printed even when named with `&m=`: a
  sheet with no names on it never reaches paper.
