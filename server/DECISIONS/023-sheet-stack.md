# DECISION 023 — The score sheet is a saved stack; the race lives in the bracket

**Status:** Implemented (2026-10-14), frontend + server. Supersedes the earlier idea of
showing a score on the bracket card.

**Owner surface:** server (`migrations/0018_race_to.sql`, `internal/api/games.go`,
`divisions.go`, `matches.go`, `cmd/fifteenball-server/main.go`) and frontend
(`sheet-payload.js` + `sheet-payload.test.js`, new; `live.html`/`live.js`, `api-client.js`,
`index.html`/`app.js`, `overlay-bracket.test.js`, new).

## Problem

Three things were tangled and none of them was right:

1. **The race had nowhere to live.** A tournament's game is immutable after create and the
   server had no column for "race to 11", so the target travelled in the opaque result
   payload — the temporary fixture said so in as many words ("There is nowhere on the
   server to put 'race to 11', which is the whole point of this fixture"). A scorer on a
   second device could not know what the match was being played to, and the paper sheet
   this system imitates has the race printed on it *before* anyone scores.
2. **The sheet was not a record.** The offline console wrote its sheet to `localStorage`
   and nothing else; the server console recorded a winner and a loser with no sheet at
   all. Nothing read `match_results.payload_json` back, so a saved sheet could not be
   retrieved by anyone, including the director who needed to check it.
3. **The bracket was carrying a score it should not.** The console printed the match's
   final totals on the bracket card, which is a summary the sheet already holds and the
   bracket's own model (win/loss) does not.

## Decision

**The bracket records win/loss and carries the race. The score sheet is a saved artifact,
kept like a paper sheet pulled off a pile: one per match, appended, retrievable, with who
saved it and when.**

### The race is bracket data

| field | meaning |
|---|---|
| `divisions.race_to` INTEGER NULL | the division's race target (games for win-measured disciplines, points for the ball-measured ones); NULL = the game's own default |
| `matches.race_to` INTEGER NULL | an optional per-match override (a longer final); NULL inherits the division |

- The **match payload exposes `raceTo`** — resolved `match ?? division ?? the game's own
  default`, always a number — and `raceFrom` naming which layer supplied it
  (`match`/`division`/`default`). `GET /tournaments/{id}/matches` is where a scorer reads
  it.
- The **division payload exposes `raceTo`** = `division ?? game default`.
- The server's own catalog is the fallback: `15ball_rotation` 25, `straight_14_1` 100,
  `8ball`/`9ball`/`10ball` 7, `one_pocket` 3, `bank_pool` 5 (`internal/api/games.go`,
  mirroring `GAMES[*].defaultRaceTo` in `app.js`), so a tournament that never set a race
  still reports a sensible one.
- Creating or patching a division accepts `raceTo` (director+), validated 1–999; absent ≠
  null (an explicit `null` clears the division's value, absence leaves it alone). The
  per-match override goes through `PATCH /tournaments/{id}/matches/{matchId}` (director+
  only — an open scoring link must not retune the race).
- **A scorer never invents a race.** The console reads it from the match payload; only a
  match the server did not resolve at all (an older server) falls back to the game's local
  default, and the sheet then records `raceFrom: "local"`.

### The sheet is one record

One shape, `sheet-payload.js`, is the *only* thing the result endpoint's `score` field
carries when a console records a match:

| field | meaning |
|---|---|
| `payloadVersion` | 1; bumped when a reader must change to keep reading |
| `kind` | the sheet body the discipline calls for: `rack` \| `race` (= `Sheets.kind()`) |
| `sheetKind` | the **instrument** that produced the number: `rack` \| `tally` |
| `discipline` | canonical id (`15ball_rotation`, `straight_14_1`, `9ball`, …) |
| `measure` | `balls` \| `wins` |
| `goals` | a rack discipline's usual targets; empty for a tally (its goal is its race) |
| `raceTo`, `raceFrom` | the race as printed on the sheet (a snapshot) and where it came from (`bracket` \| `local` \| `override`) |
| `racks` | per rack, per side: the balls marked, fouls, and the two numbers the paper sheet adds up (`made`, `net`); a tally carries no `racks` at all |
| `racksPlayed`, `ballsPerRack` | what the rack grid covered |
| `finals` | `{a, b}` |
| `winner` | `"A"` \| `"B"` \| `null` — never guessed |
| `names` | `{a, b}` |
| `app`, `appVersion` | what produced the number |

- **One write path.** The server console (`live.js`) is the host: it can reach the API and
  the endpoint's permission rule (assigned scorekeeper or director+; anyone when
  `OpenMatchEditing`) is satisfied there. It submits once per result via the existing
  `POST …/matches/{matchId}/result` with an `Idempotency-Key` — no second writer, no new
  endpoint. The one-tap "record this player as the winner" control is gone: the sheet is
  the record, so the sheet is what submits.
- **The offline console says so.** `index.html`/`app.js` has no API client and its
  tournaments have no server id; it keeps its local draft (unchanged shape, unchanged
  `localStorage`) and now states plainly that the sheet is **saved on this device**,
  instead of implying it was recorded.

### The stack is the read side

- `GET …/matches/{matchId}/history` returns the append-only versions newest-first-able,
  each now carrying its own `payload` (the `payload_json` that version wrote), `submittedBy`,
  `submittedByEmail` and `submittedAt`.
- The console lists a played match's saved sheets newest first with who saved them and
  when, and shows the selected version's sheet — a director opening a played match sees the
  sheet that was saved for it. Nothing is rewritten: a correction is a *new* version
  (reopen → re-submit), and the earlier sheet stays in the stack.

### The instrument is named, and the phone's number is legible

`sheetKind` says what produced the number. The Android app posts `discipline` and
`app: "score-android"` but its number is a plain games tally, not a rack sheet, and it has
no `sheetKind`: the console reads such a payload as a **tally** (and its hand-typed race as
an explicit `override`) instead of guessing it is a grid. The convention for the phone —
add `sheetKind: "tally"` (and `payloadVersion`) when it next ships — is documented in
`server/AGENTS.md`; the Java app is unchanged.

### Bracket and overlay stay win/loss only

The bracket card no longer prints a score (`app.js`), and the OBS overlays keep rendering
win/loss only. Both are pinned by tests, not by prose: `app-render.test.js` (a decided card
carries the winner/loser markup and no score text) and `overlay-bracket.test.js` (a decided
overlay slot carries the win mark and no numeric score, even when the match record it was
handed carries one).

## Non-goals

- A separate `/sheets` endpoint (the result endpoint already stores the sheet verbatim,
  append-only, versioned, audited, idempotent).
- Storing a score in the bracket model, or rendering one on a bracket card or an overlay.
- Any change to the Android app's Java; only the marker convention is documented for it.
- A console UI for the per-match race override (a longer final): the server supports it and
  it is tested there; nothing in either console sets it yet.
- Migrating older sheets already stored in a browser's `localStorage` — that draft shape is
  unchanged and stays a draft.
- `overlay.html` (the standalone per-match broadcast scoreboard fed by
  `BroadcastChannel`/`postMessage`, `OBS-OVERLAY.md`) is untouched: it is a live scoreboard
  for a match in progress, not the tournament's record, and its feed contract is its own.

## Test coverage required

- `sheet-payload.test.js` (new): the record's shape for both instruments (a rack record
  carries per-rack detail, a tally carries none), canonical ids, race snapshot + origin,
  the Android payload read as a tally, an empty/unknown winner never guessed, junk payloads
  read without throwing, and the stack's one-line wording.
- `live-console.test.js`: the tally's target and label come from the **match payload**, a
  match the server did not resolve falls back to the local default and says so, no result is
  submitted without a sheet, one Save submits exactly one result with the right record (and
  a double Save still submits once), the stack lists versions newest first with who and
  when, reads a phone payload as a tally, and can show an older version.
- `api-client.test.js`: the new `patchDivision`/`patchMatch` requests.
- `app-render.test.js`: a decided bracket card renders no score; the per-discipline hints
  advertise only reachable targets; One Pocket's two models are separate; the 14.1 PDFs are
  linked from the header; the offline sheet says it is saved on this device.
- `overlay-bracket.test.js` (new): the overlay renders win/loss only.
- Go: the resolution order (override beats division beats default), clearing an override,
  the unknown-game default, `raceTo` bounds, who may set each, and the history read-back
  carrying `payload`/`submittedByEmail`.

## Falsification

Every new guard was broken, shown red, and restored: the resolution's match layer; the
division's explicit-null clear; the director-only match patch; the record's `sheetKind`; the
no-score bracket card; the overlay's win/loss-only slot; the tally reading the local default
instead of the match; a result submitted without a sheet; the busy guard; the stack's
ordering; the reachability of the advertised targets.
