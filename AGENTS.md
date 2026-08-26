# AGENTS.md — repo-root handoff

> Backend agents: your protocol lives in [`server/AGENTS.md`](server/AGENTS.md). This
> root file is for **frontend / deploy** coordination between agents on different
> machines. Read the section addressed to you; answer inline by committing edits here.

---

## Handoff — OBS overlay deploy (2026-08-26)

**From:** Claude working with Kevin on **srv936626** (the mule247/bblcht box).
**To:** the Claude/agent instance that pulls this repo and publishes **`codeonline.io/15ball/`**.

### What I added
- **`overlay.html`** — a read-only broadcast scoreboard for streaming 15-Ball on OBS
  (transparent background, brand-matched, `?demo=1` to preview). It only *listens*
  for match state (`BroadcastChannel('fifteenball-live')` + `window.postMessage`);
  it never edits a match.
- **`OBS-OVERLAY.md`** — usage + the state contract.

### Requested actions (please do on your side)
1. **Deploy so `https://codeonline.io/15ball/overlay.html` serves the new file.**
   It is currently **404** at that URL even though `overlay.html` is committed to
   `main`. `codeonline.io/15ball/` appears to be a separate deployment from this repo
   — please publish it.
2. **After deploying, confirm** `codeonline.io/15ball/overlay.html` returns 200 and
   that `?demo=1` shows the animated scoreboard.

### Open questions — please answer here (commit your answers under each)
1. **How does `codeonline.io/15ball/` publish from this repo?** Auto (CI / webhook /
   cron `git pull`) or a manual step? What's the exact command/pipeline?
   > _answer:_
2. **Where does the `codeonline.io/kball → /15ball/` redirect live** — in this repo
   or in server/nginx config?
   > _answer:_
3. **Is `overlay.html` picked up automatically** by whatever serves `/15ball/`, or does
   a manifest/allowlist need the new file added?
   > _answer:_

### Context you may want
- The overlay's UI + state contract are **final**; the one deferred decision is the
  **cross-process sync transport** (OBS runs its own browser, so BroadcastChannel/
  postMessage only cover same-browser). Options on the table: a **local SSE/websocket
  relay** on the streaming PC (leading candidate), the Go **`server/`** broadcasting
  live match state, or a hosted pub/sub. Whichever is chosen, only the code that
  *calls* `postMessage`/BroadcastChannel changes — not the overlay.
- Separately, Kevin's **Columbia Cue Club** marketing site (repo
  `kevinelong/columbia-cue-club`) now links `https://codeonline.io/15ball/` and
  documents the overlay at `https://codeonline.io/15ball/overlay.html`, so getting
  the overlay live at that URL closes the loop.

_When done, leave a one-line note + date at the bottom of this section so the
srv936626 side knows it's live._
