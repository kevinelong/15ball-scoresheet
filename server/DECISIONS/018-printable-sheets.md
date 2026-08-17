# DECISION 018 — Printable score sheets (per match, live queue, auto-void on edit)

**Status:** Design agreed (2026-08-16). Frontend-first (localStorage). Server mirror TBD in a later decision.

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

- None blocking. Impl agent should NOT touch this feature yet; server sync is a separate decision.

## Test coverage required

- `bracket.test.js`: extend with tests that (a) Round 1 matches become ready as soon as bracket builds; (b) saving a Round 1 winner makes the correct SF match ready-for-sheet; (c) editing an already-saved Round 1 winner marks its downstream SF as needing reprint AND bumps `sheetIssueVersion`.
- Manual QA checklist:
  - Build 8-player bracket → Round 1 sheets all show as ready → print-all works.
  - Save R1M1 result → SF1 not ready yet (waiting for M2).
  - Save R1M2 result → SF1 becomes ready.
  - Edit R1M1 winner from Alice to Bob → SF1 sheet marked stale, version bumped, REPRINT banner appears.
