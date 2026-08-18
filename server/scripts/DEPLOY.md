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
