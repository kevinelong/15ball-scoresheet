# Cue Club backend

A tiny Go service that pairs with the [Columbia Cue Club bracket app](../) to
provide authenticated tournament storage and a Challonge push endpoint.

## What it does

- **Magic-link auth.** No passwords. You enter your email, we send you a one-time link. Clicking it sets a session cookie (30 days, HttpOnly).
- **Tournament storage.** Save the full JSON state from the browser app to SQLite so it's not stuck in one browser's localStorage.
- **Challonge proxy.** The frontend hits `POST /api/export/challonge` with the tournament ID; the backend calls Challonge's REST API using the club's shared API key (from `.env`) and returns the created tournament URL.

## Why

The frontend runs statically on GitHub Pages, which is perfect for a solo user but hits three walls once you want more:

1. Local storage doesn't survive a browser cache clear.
2. Challonge's API can't be called directly from a browser (CORS + it'd leak the API key).
3. You can't share brackets between devices or club members.

This backend fixes all three without demanding a big framework.

## Stack

- **Go** stdlib `net/http` + `chi` router — one static binary, no runtime install on the VPS.
- **SQLite** via `modernc.org/sqlite` (pure Go, no CGo) — single-file database, easy backups.
- **Magic-link tokens** stored in-DB with 15-minute expiry.
- **Session cookies** signed with an HMAC secret (`SESSION_SECRET` env var).
- **Postmark** for outbound email (works with any SMTP if you swap the sender).

## Layout

```
server/
├── go.mod
├── main.go              # entry point + routing
├── config.go            # env loading
├── db.go                # SQLite schema + migrations
├── auth.go              # magic link flow + session cookie
├── tournaments.go       # CRUD endpoints
├── challonge.go         # /api/export/challonge proxy
├── email.go             # Postmark sender (SMTP fallback)
├── static/              # (optional) can also serve the frontend
├── data.db              # SQLite file (created at first run, gitignored)
└── deploy/
    ├── kball.service    # systemd unit file
    └── nginx.conf       # nginx reverse-proxy snippet
```

## Environment variables

Copy `.env.example` to `.env` and fill in:

```
LISTEN_ADDR=127.0.0.1:8080
BASE_URL=https://tournaments.columbiacueclub.com
DATABASE_PATH=/var/lib/kball/data.db

SESSION_SECRET=<64 hex chars, generate with: openssl rand -hex 32>
MAGIC_LINK_TTL_MINUTES=15
SESSION_TTL_DAYS=30

# Shared club Challonge account
CHALLONGE_API_KEY=<from https://challonge.com/settings/developer>
CHALLONGE_SUBDOMAIN=columbiacueclub   # optional; posts to columbiacueclub.challonge.com/<slug>

# Postmark (or use SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS)
POSTMARK_TOKEN=<from postmark>
EMAIL_FROM=tournaments@columbiacueclub.com

# Comma-separated allowlist of emails permitted to sign in.
# Leave empty to allow anyone (open sign-up).
ALLOWED_EMAILS=kevinelong@gmail.com
```

## Endpoints

| Method | Path | Body / Params | Notes |
|---|---|---|---|
| `POST` | `/api/auth/request-link` | `{email}` | Emails a magic link. Silent-successes even if the email isn't allowlisted, to avoid enumeration. |
| `GET` | `/api/auth/verify?token=...` | | Sets session cookie, redirects to `BASE_URL`. |
| `POST` | `/api/auth/signout` | | Clears cookie. |
| `GET` | `/api/me` | | Returns `{email}` or 401. |
| `GET` | `/api/tournaments` | | List tournaments the caller owns. |
| `POST` | `/api/tournaments` | full tournament JSON | Create or overwrite by client-supplied `id`. |
| `GET` | `/api/tournaments/{id}` | | Fetch one. |
| `DELETE` | `/api/tournaments/{id}` | | Delete. |
| `POST` | `/api/export/challonge` | `{tournamentId}` | Creates the Challonge tournament, bulk-adds participants, seeds matches, updates scores for decided matches. Returns `{challongeUrl}`. |

## Deployment (mid-sized VPS, shared with other projects)

Assumes an Ubuntu 22.04+ VPS with nginx already fronting other apps.

1. **Build.** On your dev machine: `cd server && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o kball-server ./...`
2. **Ship.** `scp kball-server user@vps:/opt/kball/` and `scp .env user@vps:/opt/kball/.env`
3. **Data dir.** `sudo mkdir -p /var/lib/kball && sudo chown you:you /var/lib/kball`
4. **Systemd.** Copy `deploy/kball.service` to `/etc/systemd/system/`, `systemctl daemon-reload`, `systemctl enable --now kball`.
5. **Nginx.** Add `deploy/nginx.conf` inside your existing server block (or as a new server block on `tournaments.columbiacueclub.com`). Reload nginx.
6. **DNS.** Point `tournaments.columbiacueclub.com` at your VPS. Let's Encrypt via certbot handles TLS.

## Frontend hookup

Once the backend is up, set `KBALL_BACKEND_URL` in the frontend build (or via a `<meta>` tag) to your backend base URL, and the app's "Push to Challonge" and "Cloud Save" buttons will light up. Until then the frontend runs 100% locally as it does today.
