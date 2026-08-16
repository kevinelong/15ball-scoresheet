# Deploying kball-server (Alpine + OpenRC, same-origin under codeonline.io/kball)

The target VPS is **Alpine Linux (musl) + OpenRC + doas**, nginx fronting several
sites. The service runs on loopback `127.0.0.1:8093` and is exposed same-origin at
`https://codeonline.io/kball/api/` (no CORS). Reconciliation #1/#3/#14/#17.

## Build (static, pure-Go SQLite)
```sh
cd server && sh scripts/build.sh          # -> server/bin/kball-server (CGO_ENABLED=0 linux/amd64)
```

## One-time host setup
```sh
doas addgroup -S kball
doas adduser  -S -D -H -s /sbin/nologin -G kball kball
doas mkdir -p /opt/kball/bin /var/lib/kball/backups /etc/kball
doas chown -R kball:kball /var/lib/kball
# secrets: root:root 0600 — add SMTP_* and CHALLONGE_* here when those slices land
printf 'LISTEN_ADDR=127.0.0.1:8093\nDATABASE_PATH=/var/lib/kball/data.db\nBASE_URL=https://codeonline.io/kball\n' \
  | doas tee /etc/kball/kball.env >/dev/null
doas chown root:root /etc/kball/kball.env && doas chmod 600 /etc/kball/kball.env
# OpenRC service
doas cp server/openrc/kball.initd /etc/init.d/kball && doas chmod 755 /etc/init.d/kball
doas rc-update add kball default
```

## Deploy / update
```sh
doas rc-service kball stop
doas cp server/bin/kball-server /opt/kball/bin/kball-server
doas rc-service kball start
curl -s http://127.0.0.1:8093/api/health      # {"status":"ok"}
```

## nginx (in the codeonline server block)
Both blocks need `^~`. GOTCHA: with the static alias `location ^~ /kball/`, a
*plain* `location /kball/api/` is shadowed by it — the API path must also be
`^~` so the longer `^~` prefix wins. Order does not matter; the modifier does.
```nginx
# API first (longer ^~ prefix wins over the static alias below)
location ^~ /kball/api/ {
    proxy_pass http://127.0.0.1:8093/api/;   # /kball/api/health -> :8093/api/health
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;   # loopback-only upstream; trusted client IP
    proxy_set_header X-Forwarded-Proto $scheme;
}
# Static frontend from the repo clone (git pull updates live)
location = /kball { return 301 /kball/; }
location ^~ /kball/ {
    alias /home/kevin/kball-scoresheet/;
    index index.html;
    location ~ /\.(?!well-known) { return 404; }   # keep the clone's .git private
}
```
Always `doas nginx -t` before `doas rc-service nginx reload`.

## Backups (reconciliation #3, TODO slice)
Nightly `sqlite3 /var/lib/kball/data.db ".backup /var/lib/kball/backups/kball-$(date +%F).db"`
at 04:17, prune >30 days, periodic `PRAGMA integrity_check`. Needs `apk add sqlite`
(the CLI is not installed by default; the server itself does not require it).
