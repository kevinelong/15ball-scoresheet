# Columbia Cue Club Tournament — Double-Elimination Bracket + 15-Ball Rotation Score Sheet

Online tournament manager for 15-Ball Rotation. Enter a participant list, seed by Fargo rating, build a full double-elimination bracket, and click any match to open the paper-style 15-Ball Rotation score sheet as a modal. Ball totals flow back into the bracket as the match score, winners advance automatically, and everything persists in the browser or exports as JSON.

Zero dependencies — three JS/CSS/HTML files, no build step.

## What it does

### Tournament bracket
- Paste a participant list (one per line, optional Fargo rating in parentheses)
- **Sort by Fargo** or **Shuffle** to seed
- Build a full double-elimination bracket for any N &ge; 2 (byes auto-resolve)
- **Grand Final format toggle**: Single Final vs. Must Beat Twice (with GF2 reset)
- Winners' bracket, losers' bracket, and Grand Finals sections rendered as cards you can tap
- Pending matches greyed out; playable ones highlighted; decided ones show score
- Champion banner when the last match is decided
- **Load Sept 7 Signups** shortcut fills the roster from the current Labor Day Showdown 2026 registration list

### 15-Ball Rotation match score sheet (per match, modal)
- 4 racks × 2 players × 15 balls each — click balls to record them pocketed
- Live per-rack totals, running totals, and final totals
- Fouls per rack, aggregated per player
- Player names pre-populated from the bracket slot
- Winner selection advances the bracket automatically on save
- Race-to target from tournament setup pre-fills both players' goals

### Persistence & sharing
- Auto-saves the entire tournament (bracket + every match sheet) to browser storage
- **Export JSON / Import JSON** for archiving or moving between devices
- **Print** a bracket-only view (toolbar and setup hidden by print stylesheet)
- Fully responsive down to phone width; keyboard accessible

## Running locally

Any static server works. No build step.

```bash
# any of these
python3 -m http.server 8000
npx serve .
open index.html    # or just double-click
```

Then browse to `http://localhost:8000/`.

## Deploying

Because it's a static site, drop it on GitHub Pages, Netlify, Cloudflare Pages, S3+CloudFront, or any web host. GitHub Pages recipe:

1. Push this repo to `github.com/<you>/15ball-scoresheet`
2. **Settings → Pages → Build from branch → `main` / root**
3. Site lives at `https://<you>.github.io/15ball-scoresheet/`

Or point a custom subdomain (like `score.columbiacueclub.com`) at Pages via a `CNAME` file.

## Bracket engine (`bracket.js`)

Pure-function module, standalone testable. Exposes `BracketEngine.build(participants, { format })` and `BracketEngine.recordWinner(state, matchId, slotIdx, { score })`. `bracket.test.js` runs a small suite under Node: `node bracket.test.js`.

- Standard "seed vs. opposite" ordering: #1 meets #2 in the final if form holds
- Bracket size rounds up to the next power of 2, extra slots become BYEs
- BYEs auto-advance so real players face real opponents
- W-bracket winners feed forward; W-bracket losers cross-side into the L-bracket
- L-bracket rounds alternate consolidate/drop-in for standard double-elim shape
- Grand Final always has GF1; GF2 exists only in double-final format and only
  seats players when the L-champ wins GF1

## Design decisions

- **Pure vanilla JS.** No React, no bundler, no npm install. The whole app is ~500 lines and loads instantly on 3G.
- **State everywhere.** `localStorage` for personal use, URL hash for sharing, JSON export for archives.
- **Accessible.** Balls are real `<button>` elements with `aria-pressed`, keyboard-focusable, and screen-reader-labeled.
- **Print-first mindset.** The layout matches the paper score sheet closely so a printed page looks identical to the original.
- **No server, no tracking.** Nothing leaves the device unless you explicitly export or share.

## File layout

```
index.html         # markup
styles.css         # design system + responsive + print styles
app.js             # state, rendering, persistence, share/export/import
bracket.js         # pure bracket engine (SE + DE builds, advancement)
bracket.test.js    # bracket engine tests
tables.js          # table roster parser + factory (see below)
tables.test.js     # table roster tests
docs/              # printable PDF guides + generators
LICENSE            # MIT
README.md          # you're reading it
```

## Tables (venue playing surfaces)

Every tournament owns a fixed roster of **tables** — the physical playing
surfaces in your venue. Tables are declared at tournament creation via two
fields on the setup form:

- **Number of Tables** — how many playing surfaces (default: `6`, Columbia
  Cue Club's setup)
- **Table Numbering** — optional. Three input styles:
  1. **Blank** → `Table 1, Table 2, …, Table N`
  2. **Offset range** like `7-12` → `Table 7, Table 8, …, Table 12`
     (useful when your venue's tables aren't numbered from 1)
  3. **Comma list** like `Stream, A, B` → `Stream, Table A, Table B`
     (bare numbers/letters get the `Table` prefix; multi-word tokens
     like `Stream` are used verbatim)

Each table becomes a record shaped like:

```js
{ id: "t_abc12345", name: "Table 1", state: "empty" }
```

Parsing lives in `tables.js` (`Tables.parseNaming`, `Tables.buildTables`).
Run `node tables.test.js` to verify the parser — 25 unit tests cover the
blank/range/comma paths plus edge cases (empty input, hyphens in names,
fractional counts).

### Roadmap: state machine

`state` is currently always `"empty"`. Phase 2 introduces a strict state
machine (`empty → reserved → active → dirty → empty`, plus a `locked`
escape hatch for director overrides) enforced through a single module,
which prevents the "ghost match" / double-assignment glitches that plague
other tournament platforms.

## Roadmap ideas

- Table assignment state machine + assign-to-open-table auto-queue
- Lock-table override with save-or-restart modal for in-flight matches
- Big-screen "venue view" URL for casting active matches + on-deck queue
- Optional break tracker + inning counter
- Sound effects on ball toggle (opt-in)
- Match history browser (list saved JSON files)
- QR code render of the share link so you can scan it from the table

## License

MIT — © Columbia Cue Club. See `LICENSE`.
