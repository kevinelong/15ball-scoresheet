# Deploying fifteenball-server (Alpine + OpenRC, same-origin under codeonline.io/15ball)

The target VPS is **Alpine Linux (musl) + OpenRC + doas**, nginx fronting several
sites. The service runs on loopback `127.0.0.1:8093` and is exposed same-origin at
`https://codeonline.io/15ball/api/` (no CORS). Reconciliation #1/#3/#14/#17.

## Build (static, pure-Go SQLite)
```sh
cd server && sh scripts/build.sh          # -> server/bin/fifteenball-server (CGO_ENABLED=0 linux/amd64)
```

## One-time host setup
```sh
doas addgroup -S fifteenball
doas adduser  -S -D -H -s /sbin/nologin -G fifteenball fifteenball
doas mkdir -p /opt/fifteenball/bin /var/lib/fifteenball/backups /etc/fifteenball
doas chown -R fifteenball:fifteenball /var/lib/fifteenball
# secrets: root:root 0600 — add SMTP_* and CHALLONGE_* here when those slices land
printf 'LISTEN_ADDR=127.0.0.1:8093\nDATABASE_PATH=/var/lib/fifteenball/data.db\nBASE_URL=https://codeonline.io/15ball\n' \
  | doas tee /etc/fifteenball/fifteenball.env >/dev/null
doas chown root:root /etc/fifteenball/fifteenball.env && doas chmod 600 /etc/fifteenball/fifteenball.env
# OpenRC service
doas cp server/openrc/fifteenball.initd /etc/init.d/fifteenball && doas chmod 755 /etc/init.d/fifteenball
doas rc-update add fifteenball default
```

## Deploy / update
```sh
doas rc-service fifteenball stop
doas cp server/bin/fifteenball-server /opt/fifteenball/bin/fifteenball-server
doas rc-service fifteenball start
curl -s http://127.0.0.1:8093/api/health      # {"status":"ok"}
```

## nginx (in the codeonline server block)
Both blocks need `^~`. GOTCHA: with the static alias `location ^~ /15ball/`, a
*plain* `location /15ball/api/` is shadowed by it — the API path must also be
`^~` so the longer `^~` prefix wins. Order does not matter; the modifier does.
```nginx
# API first (longer ^~ prefix wins over the static alias below)
location ^~ /15ball/api/ {
    proxy_pass http://127.0.0.1:8093/api/;   # /15ball/api/health -> :8093/api/health
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;   # loopback-only upstream; trusted client IP
    proxy_set_header X-Forwarded-Proto $scheme;
}
# Legacy /kball URL: 301 to the new /15ball/ path. Keep this as long as
# there are bookmarks or magic-link emails pointing at the old prefix.
location = /kball        { return 301 /15ball/; }
# rewrite (NOT `return 301 /15ball/`) so subpath + query survive:
# /kball/api/auth/verify?s=..&t=.. -> /15ball/api/auth/verify?s=..&t=..
location ^~ /kball/      { rewrite ^/kball/(.*)$ /15ball/$1 permanent; }
# Static frontend from the repo clone (git pull updates live)
location ^~ /15ball/ {
    alias /home/kevin/15ball-scoresheet/;
    index index.html;
    location ~ /\.(?!well-known) { return 404; }   # keep the clone's .git private
}
```
Always `doas nginx -t` before `doas rc-service nginx reload`.

## Backups (reconciliation #3, TODO slice)
Nightly `sqlite3 /var/lib/fifteenball/data.db ".backup /var/lib/fifteenball/backups/fifteenball-$(date +%F).db"`
at 04:17, prune >30 days, periodic `PRAGMA integrity_check`. Needs `apk add sqlite`
(the CLI is not installed by default; the server itself does not require it).

## Android App Links (player SMS score links)

Android opens a texted `https://codeonline.io/15ball/live.html?t=…&m=…` in the Score
app when it is installed, and in the browser when it is not. That is a verified App
Link, not a JavaScript redirect.

- Serve the association at the **domain root**:
  `https://codeonline.io/.well-known/assetlinks.json`. The reference copy is
  [`server/deploy/assetlinks.json`](../deploy/assetlinks.json); the live codeonline
  web root is `/home/kevin/codeonline`, so install it at
  `/home/kevin/codeonline/.well-known/assetlinks.json`.
- It names package `com.kevin.score` and the **release signing certificate** SHA-256
  `3B:72:3D:B8:B6:04:A7:12:68:11:BC:F0:DF:53:9C:17:7B:35:20:7B:5C:EE:E5:7F:73:AD:45:13:E6:DA:F1:29`.
  Rebuild the app with the same release key, or update this fingerprint.
- The app manifest already declares `autoVerify` for `https://codeonline.io/15ball/`
  (path prefix `/15ball/`). Android verifies at install; existing installs can be
  re-verified with `adb shell pm verify-app-links --re-verify com.kevin.score`.
- Check: `curl -sSI https://codeonline.io/.well-known/assetlinks.json` → 200,
  `application/json`, no redirect.
- Without the file Android may show a chooser instead of opening the app directly; the
  link still works.

## Player SMS (score links)

- Entrants carry `phone` + `notify_opt_in`; the live console captures both (single add,
  bulk paste, edit). Only opted-in entrants are texted.
- A match assigned to a table queues the alert; `StartMatch` retries the same enqueue
  (dedupe key prevents doubles). Body includes opponent, table, and
  `<BASE_URL>/live.html?t=<slug|id>&m=<matchId>`.
- `BASE_URL` in `/etc/fifteenball/fifteenball.env` is the public base
  (`https://codeonline.io/15ball`). Twilio creds are in the same root-only env file.
