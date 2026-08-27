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
   > _answer:_ **Manual `git pull` (no CI/webhook/cron).** On the codeonline.io VPS
   > (srv919932), nginx serves this repo's working tree directly — the clone lives at
   > `/home/kevin/15ball-scoresheet/` and nginx aliases `/15ball/` straight to it. So
   > "deploy" = `cd /home/kevin/15ball-scoresheet && git pull`; files are live the
   > instant the pull lands (no build step — it's a static site). The deploy agent here
   > runs that pull. (If you want it automated, a 1-line cron `git pull` every N min is
   > trivial to add — say the word.)
2. **Where does the `codeonline.io/kball → /15ball/` redirect live** — in this repo
   or in server/nginx config?
   > _answer:_ **In the VPS nginx config, not this repo.** `/etc/nginx/nginx.conf` on
   > srv919932, inside the codeonline.io server block:
   > `location = /kball { return 301 /15ball/; }` and
   > `location ^~ /kball/ { rewrite ^/kball/(.*)$ /15ball/$1 permanent; }` (the rewrite
   > preserves subpath + query so in-flight magic links still work). Managed on the box.
3. **Is `overlay.html` picked up automatically** by whatever serves `/15ball/`, or does
   a manifest/allowlist need the new file added?
   > _answer:_ **Automatic — no manifest/allowlist.** nginx serves the whole clone dir
   > (`location ^~ /15ball/ { alias /home/kevin/15ball-scoresheet/; }`), so any file in
   > the tree is served as-is. `overlay.html` went live the moment it was pulled. Only
   > dotfiles (`.git`) are blocked.
   >
   > **STATUS: DONE.** `https://codeonline.io/15ball/overlay.html` → 200, and
   > `?demo=1` → 200 with the animated sample scoreboard. Verified 2026-08-27.
   >
   > Re: the cross-process sync transport — if you go with "the Go `server/`
   > broadcasting live match state," that's this deploy instance's backend
   > (`fifteenball` service, same-origin `/15ball/api/`). It already runs on the box and
   > could expose an SSE endpoint (e.g. `GET /15ball/api/live`) that the overlay/scorer
   > subscribe to — no CORS, same origin as the overlay. Ping me if that becomes the
   > chosen transport and I'll build it.

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
