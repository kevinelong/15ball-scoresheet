# 12 — Frontend ↔ Backend integration guide

Audience: the frontend/overlay agent. Companion to
[04-api-contracts.md](./04-api-contracts.md), [02-role-permission-matrix.md](./02-role-permission-matrix.md),
[06-realtime-contract.md](./06-realtime-contract.md). The drop-in client is
`api-client.js` at the repo root.

## 0. Where things stand
- The live app (`index.html` + `app.js` + `bracket.js` + `tables.js`) is a
  standalone **localStorage** client and makes **no** backend calls today.
- The backend (`/api/v1`, deployed as service `fifteenball`) is complete and
  tested (acceptance suite in `09-acceptance-tests.md`: scenarios 1–30 plus §H for
  bracket generation) but unused by the UI.
- **Chosen v1 scope: B — grow the backend to match the frontend** (double
  elimination + all disciplines). The bracket half has landed — double elimination
  is the default and single elimination works for any field size — so disciplines
  beyond 15-ball are what remains. See §7 for the detail and the two format
  vocabularies; slices 1–3 below do not depend on it and can start now.

## 1. Model / ground rules
- **Same-origin, no CORS.** The app is served under `/15ball/`; the API is
  `/15ball/api` (nginx proxies `/15ball/api/` → backend `/api/`). The client
  defaults `base = /15ball/api`.
- **Auth = cookie session** (`fifteenball_session`), set by the magic-link flow.
  Every request must send `credentials: 'include'` (the client does this).
- **CSRF:** all mutations require the header `X-CO: 1` (client adds it to every
  non-GET). GETs don't need it.
- **Idempotency:** `POST …/result`, `…/reopen`, and `…/challonge/sync` require an
  `Idempotency-Key` header; the client generates one when you don't pass it.
- **Optimistic concurrency:** tournaments/entrants/matches carry a `version` that
  increments on write. Surface stale-write conflicts (409) to the user.
- **Error envelope:** non-2xx returns `{ "error": { "code", "message" } }`; the
  client throws `FBApiError` with `.status` and `.code`.

## 2. Using the client
```html
<script src="api-client.js"></script>
<script>
  const api = FB.createClient();                  // base defaults to /15ball/api
  try {
    await api.requestLink('director@club.test');  // magic link emailed
    // …after the user clicks the emailed link (see §3)…
    const me = await api.me();                     // { userId, email, roles[], pending }
    const { items } = await api.listTournaments();
  } catch (e) {
    if (e.code === 'forbidden') /* hide the action */;
  }
</script>
```

## 3. Auth flow (magic link)
1. User enters email → `api.requestLink(email)` → 202 (always, to avoid account
   enumeration). Show "check your email."
2. The email links to the backend's **scanner-safe GET landing**
   (`/15ball/api/auth/verify?...`). That page (served by the backend) posts the
   confirm with `X-CO` and sets the session cookie — the SPA does **not** handle
   the token itself.
3. Back in the app, call `api.me()`:
   - `pending: true` or `roles: ['viewer']` → read-only UI.
   - `roles` includes `tournament_director`/`club_admin`/`system_admin` → show
     director actions.
4. `api.signout()` clears the session.

## 4. Role gating (see 02-role-permission-matrix)
| Capability | Roles |
|---|---|
| View tournaments / public overlay | any signed-in (public overlay needs no session) |
| Create/edit tournaments, divisions, entrants, assign, reopen | `tournament_director`+ |
| Submit result | assigned `scorekeeper`, or director+ |
| Grant/revoke user roles | `club_admin` / `system_admin` |
Drive visibility off `api.me().roles`; the server still enforces, so treat UI
gating as UX only.

## 5. Screen → endpoint map (build order = thin vertical slices)
**Slice 1 — Auth shell:** sign-in form, `requestLink` → `me` → role-gated chrome.
**Slice 2 — Tournaments:** `listTournaments` (list), `createTournament` (director),
`getTournament` (detail), `patchTournament` (state transitions), `archiveTournament`.
**Slice 3 — Entrants:** `listEntrants`, `createEntrant`
(`{displayName, phone, notifyOptIn}` — this feeds the SMS opt-in), `patchEntrant`,
`checkInEntrant`, `archiveEntrant`.
**Slice 4 — Bracket/matches/scoring:** move to `in_progress` via `patchTournament`
(server generates the bracket), `listMatches`, `assignMatch`
(`{scorekeeperUserId, tableRef}` — setting a table **fires the match-ready SMS**),
`startMatch`, `submitResult`, `reopenMatch`, `clearMatchReview` (see §10 — a match can
come back flagged for review), `matchHistory`.
**Slice 5 — Live:** `api.events(id)` (EventSource) for the scoreboard; point
`overlay.html` at `publicOverlay(id)` + `events(id)` for OBS.
**Slice 6 — Migrate:** push existing localStorage tournaments to the server (see §8).

## 6. Live updates (SSE)
```js
const es = api.events(tournamentId);
es.addEventListener('message', (e) => applyEvent(JSON.parse(e.data)));
es.addEventListener('snapshot_required', async () => {          // missed too much
  render(await api.snapshot(tournamentId));                     // full re-sync
});
// browser auto-reconnects with Last-Event-ID; on 'snapshot_required' re-fetch.
```
The same endpoint serves the OBS overlay for a **public** tournament (no session).
Event ordering, `Last-Event-ID` replay, and `snapshot_required` semantics are in
06-realtime-contract.

## 7. Scope B — backend growth needed for full parity
Both sides now support **double elimination** (the backend default) and real
**single elimination**; what is still missing is **multiple disciplines** — the
backend accepts only `game: 15ball_rotation` (`tournaments.go` `validGames`). The
schema already has the seams — `tournaments.game` and `divisions.format` — so the
API surface below does **not** change as the rest lands:
- **Bracket formats (done, server).** The generator is chosen on the
  `registration_closed → in_progress` transition from the primary division's
  `format`: `double_elimination` (default when a division has no format — winners,
  losers and grand-final matches, with the GF2 reset when the losers champ wins
  GF1) or `single_elimination` (winners rounds only; a field that is not a power of
  two is seeded through `seedOrder` with an archived BYE placeholder per missing
  seed, so no entrant is dropped, and the byes auto-resolve). `listMatches` rows
  carry `bracket` (`W`/`L`/`GF`; **null for single elimination**) and `matchLabel`
  (`W1M1`, `L2M1`, `GF1`), plus `feedsWinnerMatch`/`feedsWinnerSlot`/
  `feedsLoserMatch`/`feedsLoserSlot` — derive losers-bracket origin tags from the
  feeder edges instead of inferring them. Coverage: `09-acceptance-tests.md` §H;
  unresolved (do not assume either way): `OPEN-QUESTIONS.md` on reopening a match
  whose winner already played downstream.
- **Two vocabularies — do not conflate them.** The console (`index.html`,
  `bracket.js`, `app.js`) uses `single_elim` (real single elimination), `single`
  (double elimination settled by one decisive grand final) and `double` (with the
  GF2 reset). `divisions.format` uses `single_elimination` | `double_elimination`.
  When pushing a local tournament to the cloud, map `single_elim` →
  `single_elimination` and both `single` and `double` → `double_elimination`: the
  GF1/GF2 choice is **not** part of the division format, and
  `double_elimination` always resets on a losers-champ GF1 win. Request a format
  field if the cloud needs the console's Single Final semantics.
- **Disciplines:** accept `game` values beyond `15ball_rotation` (8/9/10-ball,
  14.1, bank, one-pocket) and their scoring/win-condition differences. Call-shot
  and rotation rules already generalize; 14.1-style vs winning-ball games differ in
  `submitResult`/advancement.
- Until the disciplines land, cloud tournaments are limited to 15-ball; the client
  works unchanged.

These are tracked as the next backend slices; the frontend can build slices 1–3
against the stable surface immediately.

## 8. Migrating localStorage tournaments
Reuse the existing **Import JSON** plumbing: add a "Push to cloud" that maps a
local tournament to `createTournament` → `createDivision` → `createEntrant` (×N).
A backend **bulk-import** endpoint can collapse this into one call if the per-item
fan-out is too chatty — request it and it'll be added.

## 9. Gotchas
- Send `credentials: 'include'` (client does) — without it there's no session and
  everything 401s.
- Don't put the CSRF value in a query param; it's the `X-CO` header.
- `submitResult`/`reopen` must reuse the **same** Idempotency-Key on retry, or you
  risk a duplicate; let the client generate one per user action and reuse it.
- Treat 409 as an optimistic-concurrency/transition conflict, not a hard error —
  re-fetch and let the user retry.
- After a `reopenMatch` + `submitResult`, `listMatches`' `winnerEntrantId` can still
  report the **superseded** winner: both result rows end up with `superseded_by NULL`
  and the read path picks one without ordering. Read the correction from
  `matchHistory(id, mid).versions` (ordered by `resultVersion`) until that is decided —
  see `OPEN-QUESTIONS.md`, "Which result version is the current winner after a reopen
  and re-submit?".

## 10. Match review flag — a correction that reached a played match

If a director reopens a match whose winner **already played downstream**, the
corrected winner is written into the downstream slot (otherwise the corrected pairing
could not be replayed), the downstream match keeps its state, its result rows and its
recorded winner, and it comes back flagged (`needsReview: true`) with an audit row
(`match: review_required`) and an SSE event (`match.review_required`). While the flag
is set, that match's `winnerEntrantId` may **not** be one of its two participants —
that difference is exactly what a human has to resolve. Semantics:
[03-state-machines.md](./03-state-machines.md) ("Match review flag"); decision:
`OPEN-QUESTIONS.md` → resolved, option 3.

- **Console (`live.js`)** — match list rows and bracket cards mark a flagged match
  next to its label (`needs review` pill, reusing `live.html`'s `.pill.warn`). Do not
  hide it and do not "fix" it client-side; `live.js` re-reads on any SSE event, so the
  flag appears on its own.
- **Overlay (`overlay-live.js`)** — the card carries a `Needs review: <labels>` tag
  whenever *any* match of the tournament is flagged, not just the featured one, and it
  is shown on the standing-by card too, so the stream never looks normal while a
  result is in doubt. `snapshot.overlay.reviewRequired` carries the same signal for a
  consumer that only reads the normalized state.
- **Repair procedure (director, in this order):**
  1. `reopenMatch(id, matchId, reason)` — the flag stays.
  2. `submitResult(id, matchId, {winnerEntrantId, loserEntrantId})` with the
     participants now in that match's slots; a new result version is appended and the
     earlier one is left untouched.
  3. `clearMatchReview(id, matchId, reason)` — the only thing that clears the flag:
     audited (`match: review_cleared`), emits `match.review_cleared`, leaves the
     recorded result alone, and answers `409 not_flagged` if there is nothing to clear.
  Until step 3 the match keeps saying it needs review, which is intended: the director
  states when the inconsistency is resolved.

These client behaviours are pinned by hand-run Node suites next to the files they cover:
`live-console.test.js` (console render + SSE) and `review-flags.test.js` (overlay) drive
the real modules in a DOM stub, `api-client.test.js` stubs `fetch` and asserts the
request the client builds, and `app-render.test.js` drives `app.js`'s own render path
(format labels, the grand-final card, the sheet-replay guard). Run them with
`node <file>.test.js`, like the other suites in the repo.

