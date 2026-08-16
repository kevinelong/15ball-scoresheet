# 15-Ball Rotation (K-Ball) — Online Score Sheet

Interactive online version of the Columbia Cue Club K-Ball paper score sheet. Zero dependencies — one HTML file, one stylesheet, one JS file. Runs anywhere: static hosting, USB drive, phone browser, iPad on the wall next to the table.

## What it does

- 4 racks × 2 players × 15 balls each — click a ball to record it pocketed
- Live per-rack totals, running totals, and final totals
- Fouls per rack, aggregated per player
- Player names, goals (25 / 50 / other), high run, signatures, winner
- Auto-saves to `localStorage` — refresh-safe
- **Copy Share Link** encodes the whole sheet into the URL hash, so you can text a match to another phone
- **Export / Import JSON** for archiving matches
- **Print / PDF** — a print stylesheet strips the toolbar and keeps the paper look
- Fully responsive down to phone width; keyboard accessible (Tab, Space/Enter to toggle balls)

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

1. Push this repo to `github.com/<you>/kball-scoresheet`
2. **Settings → Pages → Build from branch → `main` / root**
3. Site lives at `https://<you>.github.io/kball-scoresheet/`

Or point a custom subdomain (like `score.columbiacueclub.com`) at Pages via a `CNAME` file.

## Design decisions

- **Pure vanilla JS.** No React, no bundler, no npm install. The whole app is ~500 lines and loads instantly on 3G.
- **State everywhere.** `localStorage` for personal use, URL hash for sharing, JSON export for archives.
- **Accessible.** Balls are real `<button>` elements with `aria-pressed`, keyboard-focusable, and screen-reader-labeled.
- **Print-first mindset.** The layout matches the paper score sheet closely so a printed page looks identical to the original.
- **No server, no tracking.** Nothing leaves the device unless you explicitly export or share.

## File layout

```
index.html    # markup
styles.css    # design system + responsive + print styles
app.js        # state, rendering, persistence, share/export/import
LICENSE       # MIT
README.md     # you're reading it
```

## Roadmap ideas

- Optional break tracker + inning counter
- Sound effects on ball toggle (opt-in)
- Match history browser (list saved JSON files)
- QR code render of the share link so you can scan it from the table
- Tournament bracket wrapper that hosts multiple sheets

## License

MIT — © Columbia Cue Club. See `LICENSE`.
