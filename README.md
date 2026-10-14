# Columbia Cue Club Tournament — Double-Elimination Bracket + 15-Ball Rotation Score Sheet

Online tournament manager for seven pool disciplines. Enter a participant list, seed by Fargo rating, build a full double-elimination bracket, and click any match to open the paper-style score sheet for that tournament's game as a modal — a rack grid for the ball-marked disciplines (15-Ball Rotation, Straight Pool 14.1), a games tally inside the same sheet chrome for the race disciplines (8/9/10-Ball, One Pocket, Bank Pool). Totals flow back into the bracket as the match score, winners advance automatically, and everything persists in the browser or exports as JSON.

Zero dependencies — three JS/CSS/HTML files, no build step.

## What this is (intent)

At its core this project exists to **make running a real pool tournament effortless — and to let everyone in the room take part live from their own phone.** Turn a pool hall into a live, self-running bracket: build it, call players to their tables, score by tapping a winner, and put it on stream — without accounts, paperwork, or a laptop at the desk.

It ships in two layers that share one bracket model:

- **Static app (this folder)** — zero-dependency, offline, single-device double-elimination bracket + printable per-discipline score sheets. Runs anywhere static; nothing leaves the device.
- **Live cloud edition (`server/` + `live.html`)** — a multi-user backend and mobile console: magic-link sign-in, server-persisted double-elimination tournaments across several disciplines, real-time updates over SSE, role-gated setup, **open scoring links + QR** so anyone in the room can score from their phone, **SMS "your match is ready at table N"** alerts, Challonge sync, and a transparent **OBS overlay** (`overlay-live.html`) for streaming.

**Design philosophy:** remove every point of friction between "we're holding a tournament" and "it's running" — no installs, no accounts to score, short links/QR instead of typing, and the software fading into the background so the room just plays.

## What it does

### Tournament bracket
- Paste a participant list (one per line, optional Fargo rating in parentheses)
- **Sort by Fargo** or **Shuffle** to seed
- Build a full double-elimination bracket for any N &ge; 2 (byes auto-resolve)
- **Bracket format toggle**: Single Elimination (winners bracket only), Single Final, or Must Beat Twice (with the GF2 reset)
- Winners' bracket, losers' bracket, and Grand Finals sections rendered as cards you can tap
- Pending matches greyed out; playable ones highlighted; decided ones show score
- Champion banner when the last match is decided
- **Load Sept 7 Signups** shortcut fills the roster from the current Labor Day Showdown 2026 registration list

### Match score sheet (per match, modal — one sheet per discipline)
- The sheet's body comes from the tournament's game (`sheets.js`): **15-Ball Rotation** marks
  15 ball faces over 4 racks (GAME SUBTOTAL), **Straight Pool 14.1** marks 14 plain circles
  over 8 racks (RUNNING TOTAL, FINAL MATCH TOTAL, goals 75/100), and the race disciplines
  (8/9/10-Ball, One Pocket, Bank Pool) get a games tally in the same sheet chrome
- **Each discipline advertises its own targets, and only targets its own sheet can reach.**
  15-Ball Rotation offers 25/50 and says so ("a 4-rack sheet tops out at 60 balls"), instead of
  carrying 14.1's "multiple of 25 (25 / 50 / 100 / 150)" line across; 14.1 offers 75/100 (8 racks
  = 112 balls) and no longer advertises an unreachable 150. One Pocket's catalog line keeps its
  two models apart: the *match* is a race of games, and a *game* is won by pocketing 8 balls in
  your own pocket. The hint text and the goal presets are pinned against the sheet's own ceiling
  by `app-render.test.js`, so the copy cannot drift away from the geometry again.
- The 14.1 paper sheet and its rules ship with the 14.1 in-app sheet: the header links both
  (`docs/141-paper-sheet.pdf`, whose QR points at `docs/141-rules.pdf`)
- Live per-rack totals, running totals, and final totals
- Fouls per rack, aggregated per player
- Player names pre-populated from the bracket slot; goal presets pre-checked from the setup
- **How a discipline is scored is data** (`sheets.js` → `measure`): a ball-marked sheet marks balls
  one at a time, a win-measured race steps one game per press with the ± buttons and cannot pass its
  race target. There are no quick-add jumps anywhere — a jump could overshoot a race
- **Flick to score, on a touch screen**: a mostly-vertical drag past ~48 px on either half of the
  games tally is one step for that player (up +1, down −1). It is an accelerator — the ± buttons and
  the ball taps remain the accessible and desktop path, and a mouse drag never takes the gesture
- Winner selection advances the bracket automatically on save (auto-selected at the target)
- **The bracket shows win/loss and nothing else** — a decided card marks the winner and the
  loser, and prints no score; the sheet is where the numbers live. Pinned by
  `app-render.test.js` (console card) and `overlay-bracket.test.js` (the OBS bracket overlay).
- **This console has no server link, and says so.** A sheet saved here is a local draft:
  the modal carries a "saved on this device … stays in this browser" note and the save toast
  repeats it, so a local save can never read as "recorded" somewhere. Submitting a sheet to a
  server tournament is the live console's job (see *Server*, below)

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

## Testing

Every suite is a plain Node script — no test runner to install. Run the ones next to the
code they cover:

```bash
node bracket.test.js        # bracket engine: single-elim spec, scale pinning, refusals
node sheets.test.js         # per-discipline sheet specs: id resolution, rack geometry, goals
node sheet-payload.test.js  # the saved sheet record: shape, instruments, the phone's payload
node overlay-bracket.test.js # OBS bracket overlay: win/loss only, never a score
node roster.test.js         # roster parsing
node tables.test.js         # table naming/parsing (25 tests)
node migration.test.js      # storage-key + legacy-state migration
node app-render.test.js     # console render: format labels, grand-final card, sheet replay
node live-console.test.js   # cloud console render + the SSE-driven review marker
node review-flags.test.js   # OBS overlay review flag vs overlay.reviewRequired
node api-client.test.js     # backend client requests (fetch stubbed)
```

The server side runs under Go (`cd server && go test ./...`, Go 1.22+; `go vet ./...` stays
clean). The review-flag and single-elimination work is covered by scenarios 31–48 of
`server/IMPLEMENTATION/09-acceptance-tests.md`.

## Server (live cloud edition) — state & deployment

- **Bracket shape.** Double elimination is the backend default
  (`divisions.format = double_elimination`); real single elimination
  (`single_elimination`) sizes a non-power-of-two field up to the next power of two with
  BYEs, so a checked-in entrant is never dropped. The static console's own vocabulary is
  `single_elim` (single elimination), `single` (double elimination settled by one decisive
  grand final) and `double` (with the GF2 reset) — see the two vocabularies in
  `server/IMPLEMENTATION/12-frontend-integration-guide.md` §7.
- **The score sheet is a submitted artifact; the bracket carries the race.** The bracket
  records win/loss and nothing else, but it carries each match's race target —
  `matches.race_to ?? divisions.race_to ?? the game's own default` — exposed on the match
  payload as `raceTo` and `raceFrom` (`"match"` | `"division"` | `"default"`) and on the
  division as a resolved `raceTo`. `GET /tournaments/{id}/matches` is where a scorer reads
  it: the live console's tally takes its target and label from the match and never invents
  one (only a director sets one, via `POST …/divisions` or `PATCH …/divisions/{divisionId}`,
  with an optional per-match `PATCH …/matches/{matchId}` override for a longer final).
  Scoring a match submits **one sheet record** through the existing
  `POST …/matches/{matchId}/result` (`sheet-payload.js` builds it; the payload carries the
  payload version, the discipline, the measurement, the goals, the race as printed on the
  sheet, the per-rack detail for a rack discipline, the finals, the winner, the app and its
  version — and `sheetKind`, which names the instrument that produced the number: `rack` or
  `tally`). Results stay append-only and versioned, so the match's history **is** the stack:
  `GET …/matches/{matchId}/history` returns each saved sheet with its payload, who saved it
  (`submittedByEmail`) and when, and the console lists them newest first and shows the
  selected version. A correction is a new version (reopen → re-submit), never a rewrite.
  Docs: `DECISIONS/023-sheet-stack.md`, `IMPLEMENTATION/04-api-contracts.md` (§divisions and
  §matches), `05-schema-contract.md` (migration 0018), `09-acceptance-tests.md` §K.
- **Corrections.** Reopening a match whose winner already played downstream keeps the played
  result and flags the downstream match for review (`matches.needs_review`) with an audit row
  and an SSE event; a director replays it and clears the flag. Contract:
  `server/IMPLEMENTATION/03-state-machines.md` ("Match review flag").
- **Deployment is manual and belongs to the maintainer.** The live service is updated by
  pulling this repo on the server (`cd /home/kevin/15ball-scoresheet && git pull`) and
  restarting it — **a pushed commit is not a deployed one**. Two migrations apply
  automatically on the next service start, both additive with no backfill: 
  `0017_match_review_flag.sql` (the review flag, `DEFAULT 0`) and
  `0018_race_to.sql` (`divisions.race_to`, `matches.race_to`, both nullable — existing rows
  read back as "not set here" and resolve to the game's default / the division). Until 0018
  has run, the race resolution is inert and a match payload reports the game's own default.
- **Next.** The one open decision is in `server/OPEN-QUESTIONS.md` (which result version
  counts as the current winner after a reopen and re-submit); beyond that, disciplines other
  than 15-ball, a console control for clearing a review flag, and a console UI for the
  per-match race override (the server takes it; nothing sets it yet).

## Bracket engine (`bracket.js`)

Pure-function module, standalone testable. Exposes `BracketEngine.build(participants, { format })` and `BracketEngine.recordWinner(state, matchId, slotIdx, { score })`. `bracket.test.js` runs a small suite under Node: `node bracket.test.js`.

`format` is one of `single_elim` (real single elimination), `single` (the default: double elimination with a decisive GF1 — a single *final*, not a single bracket) or `double` (a GF2 reset when the losers-bracket player wins GF1). `recordWinner` refuses an unknown match, a slot index other than 0/1, and a slot that is empty or a BYE.

- Standard "seed vs. opposite" ordering: #1 meets #2 in the final if form holds
- Bracket size rounds up to the next power of 2, extra slots become BYEs
- BYEs auto-advance so real players face real opponents
- `single_elim` builds the winners rounds only — no losers bracket and no grand final, with the last W match as the decisive final
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
roster.js          # roster parsing
roster.test.js     # roster tests
migration.test.js  # storage-key + legacy-state migration tests
sheet-payload.js   # the score sheet as a record (the result payload + its reader)
sheet-payload.test.js  # the record's shape, its two instruments, the phone's payload
overlay-bracket.test.js # OBS bracket overlay: win/loss only
app-render.test.js     # console render tests (formats, grand final, sheet replay)
live-console.test.js   # cloud console render + SSE tests
review-flags.test.js   # OBS overlay review-flag tests
api-client.test.js     # backend client request tests
api-client.js      # drop-in backend client (see server/IMPLEMENTATION/12-…)
live.html / live.js          # cloud console (multi-user, server-backed)
overlay-live.html / overlay-live.js  # OBS overlay for streaming
server/            # Go backend + SQLite (see server/AGENTS.md)
docs/              # printable PDF guides + generators
LICENSE            # licence text (see LICENSE — the README's Licence section predates it)
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

## Could other clubs & venues use this?

Yes — two ways today, with an honest caveat on the third.

- **Self-host your own instance (works now).** The whole system is a single static frontend + one static Go binary + a SQLite file. A venue deploys its own copy and sets its own config — club name/branding, SMS sender, Challonge account, sign-in allowlist — and runs independently. Rules, brackets, scoring, SMS alerts, and the OBS overlay are all generic; only the "Columbia Cue Club" labels and the SMS compliance pages are club-specific text to swap.
- **The static bracket app is already universal.** `index.html` + `bracket.js` work for any club, any N players, fully offline — nothing is hard-wired to one venue.
- **A shared multi-tenant service is not built yet.** The live backend is currently **single-club**: one database, global roles, no per-club data isolation (an early `organizations` concept was intentionally dropped when the schema was normalized). Hosting many clubs on one instance would mean re-introducing club/org scoping — tournaments and roles scoped per club, per-club branding + config (SMS/Challonge), and tenant isolation. The foundation (auth, brackets, scoring, real-time, SMS, overlay) is reusable; the missing piece is the tenancy layer.

**Short version:** any club can run their own copy now; a shared "sign up your club" SaaS is a well-scoped addition, not a rewrite.

## License

MIT — © Columbia Cue Club. See `LICENSE`.
