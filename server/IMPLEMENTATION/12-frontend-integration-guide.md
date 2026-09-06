# 12 — Frontend ↔ Backend integration guide

Audience: the frontend/overlay agent. Companion to
[04-api-contracts.md](./04-api-contracts.md), [02-role-permission-matrix.md](./02-role-permission-matrix.md),
[06-realtime-contract.md](./06-realtime-contract.md). The drop-in client is
`api-client.js` at the repo root.

## 0. Where things stand
- The live app (`index.html` + `app.js` + `bracket.js` + `tables.js`) is a
  standalone **localStorage** client and makes **no** backend calls today.
- The backend (`/api/v1`, deployed as service `fifteenball`) is complete and
  tested (30-scenario acceptance suite) but unused by the UI.
- **Chosen v1 scope: B — grow the backend to match the frontend** (double
  elimination + all disciplines). See §7 for the server work that unblocks full
  parity; slices 1–3 below do not depend on it and can start now.

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
`startMatch`, `submitResult`, `reopenMatch`, `matchHistory`.
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
The frontend supports **double elimination** and **multiple disciplines**; the
backend today is **single-elimination, 15-ball only**. The schema already has the
seams — `tournaments.game` and `divisions.format` — so the API surface below does
**not** change as these land:
- **Double elimination:** implement winner/loser bracket generation + advancement
  keyed on `divisions.format` (`single_elimination` | `double_elimination`),
  including grand-final logic. (Server work; `listMatches` gains loser-bracket rows
  but the shape is unchanged — add a `bracket` field like `winners`/`losers`.)
- **Disciplines:** accept `game` values beyond `15ball_rotation` (8/9/10-ball,
  14.1, bank, one-pocket) and their scoring/win-condition differences. Call-shot
  and rotation rules already generalize; 14.1-style vs winning-ball games differ in
  `submitResult`/advancement.
- Until these land, the client works unchanged; cloud tournaments are limited to
  15-ball single-elim (surface that in the create form).

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
