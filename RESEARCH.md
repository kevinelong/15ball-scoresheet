# Research: exports & rating submission

## FargoRate — no public API

Findings from https://fargorate.com, https://forums.azbilliards.com, and the r/billiards subreddit as of Aug 2026:

- **FargoRate has no public REST API for tournament submission.** Ratings only flow in through:
  1. **LMS (League Management Software)** — FargoRate's own product, for leagues only. Not applicable to a one-off tournament.
  2. **Mike Page's manual ingest** — email a public link to a bracket showing full match scores to `support@fargorate.com`. Mike Page or FargoRate staff manually pull the scores.
  3. **Salotto** — a paid third-party app that self-reports matches.
- **Approved workflow for one-off tournaments** (multiple confirmations on AZ Billiards, most recent 2026):
  1. Post the bracket publicly on **Challonge**, **CueScore**, **DigitalPool**, or **Ingenpool**.
  2. Ensure full match scores are visible (games won, not ball-spots) for each match.
  3. Email `support@fargorate.com` with the public bracket URL and a description of the tournament.
- **Data requirements:** Mike Page needs each match line as `winner_games - loser_games`. Game-spot handicaps have to be either explicit or converted to a pure games-won number. Ball-spot handicaps are not accepted.
- **Score aggregation:** for LMS-style submission, races are best aggregated (`4-2` instead of `1-0, 1-0, 1-0, 1-0, 0-1, 0-1`).

## Challonge — has a REST API (v1)

- **Base:** `https://api.challonge.com/v1/`
- **Auth:** API key from https://challonge.com/settings/developer, sent as `?api_key=...` query string OR HTTP Basic auth.
- **Rate limit:** 40 requests/minute.
- **Endpoints we need:**
  - `POST /v1/tournaments.json` — create a tournament (fields: `name`, `tournament_type` = `double elimination` or `single elimination`, `url`, `subdomain`, `game_name`, `description`, `open_signup: false`, `hold_third_place_match`, `start_at`).
  - `POST /v1/tournaments/{id}/participants/bulk_add.json` — bulk add participants (`participants[][name]`, `participants[][seed]`, `participants[][misc]` for Fargo).
  - `POST /v1/tournaments/{id}/start.json` — start the tournament (locks the participant list, generates matches).
  - `GET /v1/tournaments/{id}/matches.json` — list matches (Challonge assigns its own match IDs).
  - `PUT /v1/tournaments/{id}/matches/{match_id}.json` — set `scores_csv=25-10` and `winner_id`.
  - `POST /v1/tournaments/{id}/finalize.json` — finalize once all matches are decided.
- **Match score format:** `scores_csv=3-1` (winner's games/points first, comma-separate multi-set matches).
- **CORS:** Challonge's API historically does **not** support CORS from browser origins. Direct browser calls will hit a preflight rejection. Options:
  - Provide a JSON export the user pastes into an existing Challonge tournament via CSV import.
  - Provide a Python/Node script the user runs locally.
  - Use a lightweight proxy. For a GitHub Pages static site, the simplest path is **export a Challonge-ready CSV + a JSON payload** and give the user a one-click "copy curl command" to run from their terminal.

## DigitalPool

- **No documented public API.** The docs at https://docs.digitalpool.com cover the UI only.
- **v2 site** (https://v2.digitalpool.com) exists but no developer portal is listed.
- **Interop path:** the "Tournament Builder" supports manual creation from a bracket page. We can export a CSV/JSON that maps to their expected fields, but there's no automated push.
- Alternative venues also considered: **CueScore** and **Ingenpool** — both accept tournament URLs FargoRate can ingest.

## Decision for this app

1. **Game selector at the tournament level** — pick one of a curated list; the score-sheet modal adapts.
2. **Every match records winner + final score (games won or points, depending on the game).** 15-Ball Rotation keeps its ball-grid sheet; other games get a simpler counter sheet.
3. **Export menu** offers three destinations:
   - **Challonge (JSON payload + terminal command)** — user copies a `curl` block that creates the tournament, bulk-adds participants with seeds & Fargo in `misc`, starts it, updates each match with `scores_csv` and `winner_id`, and finalizes. API key entered into the modal is used inline in the command but never stored server-side (this is a static site — no server).
   - **FargoRate submission bundle** — CSV of matches formatted as `Winner, Loser, WinnerGames, LoserGames, Game, TableSize, Date` plus a prefilled email template pointing to the tournament's Challonge/DigitalPool URL, ready to send to `support@fargorate.com`.
   - **Generic JSON** — full state, importable back into this app or into a hand-rolled DigitalPool import script.

## Curated game catalog

| Game | Race convention | Sheet type | FargoRate reportable |
|---|---|---|---|
| 8-Ball | games won (race to N) | counter | yes |
| 9-Ball | games won (race to N) | counter | yes |
| 10-Ball | games won (race to N) | counter | yes |
| One Pocket | games won (race to N) | counter | yes |
| Straight Pool (14.1) | points (target 100/125/150) | counter | yes (points as games-substitute per Mike Page's guidance) |
| Bank Pool | games won (race to N) | counter | yes |
| 15-Ball Rotation | points-per-rack (rotation) | ball-grid (existing) | yes (as points) |
