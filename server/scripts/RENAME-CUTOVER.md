# VPS cutover: kball-server → fifteenball-server

One-time migration of the deployed backend on `codeonline.io` from the old
`kball` names/paths/URL to the new `fifteenball` names, `/15ball/` URL, and
`fifteenball_session` cookie. Run these steps on the VPS as `doas` root.

The frontend static site is served from `/home/kevin/15ball-scoresheet/`
(the local git remote is already pointed at the renamed GitHub repo, so a
`git pull` there will refresh the checkout). Only the backend service and
nginx need coordinated changes.

Estimated downtime: **~30–60 seconds** (service stop → cp binary → nginx
reload → service start).

## Pre-flight (safe to do ahead of time)

```sh
# On the VPS: fresh git pull under the new repo name.
# GitHub keeps the old kball-scoresheet URL as a redirect, so the existing
# remote in the clone still fetches. Update the remote for clarity:
cd /home/kevin/kball-scoresheet
doas -u kevin git remote set-url origin https://github.com/kevinelong/15ball-scoresheet.git
doas -u kevin git fetch --all
# Don't pull to main yet — that will publish the new frontend before nginx flips.

# Confirm no crontab or systemd timer references old paths:
crontab -l -u kevin 2>/dev/null | grep -iE "kball|/opt/kball|/var/lib/kball" || echo "no user crons touch kball"
doas find /etc/cron.* /etc/periodic /etc/init.d -maxdepth 2 2>/dev/null | xargs -r doas grep -l "kball" 2>/dev/null || echo "no system crons touch kball"
```

## Cutover

### 1. Stop the old service

```sh
doas rc-service kball status
doas rc-service kball stop
```

### 2. Rename system user, group, and directories

The database file, backup dir, log file, env file, service binary, and OpenRC
init script all move under the new name. `mv` is atomic within a filesystem;
UIDs/GIDs stay the same so file ownership survives.

```sh
# --- user + group ---
# groupmod renames the group; usermod renames the user AND their primary group
# home won't need renaming (nologin, no home dir).
doas groupmod -n fifteenball kball
doas usermod  -l fifteenball kball

# --- directories (data + logs + config + install) ---
doas mv /var/lib/kball    /var/lib/fifteenball
doas mv /var/log/kball.log /var/log/fifteenball.log 2>/dev/null || true
doas mv /etc/kball        /etc/fifteenball
# The env file inside /etc/fifteenball keeps its original name until we
# rename it, and the init script now expects /etc/fifteenball/fifteenball.env.
doas mv /etc/fifteenball/kball.env /etc/fifteenball/fifteenball.env
doas mv /opt/kball        /opt/fifteenball
doas mv /opt/fifteenball/bin/kball-server /opt/fifteenball/bin/fifteenball-server 2>/dev/null || true

# --- ownership refresh (usermod may leave the ownership intact but be paranoid) ---
doas chown -R fifteenball:fifteenball /var/lib/fifteenball /var/log/fifteenball.log
doas chown root:root /etc/fifteenball /etc/fifteenball/fifteenball.env
doas chmod 600 /etc/fifteenball/fifteenball.env
```

### 3. Update the env file

Edit `/etc/fifteenball/fifteenball.env` so `DATABASE_PATH` and `BASE_URL` match
the new paths and URL. The renamed binary still reads the same var names.

```sh
doas $EDITOR /etc/fifteenball/fifteenball.env
# Change:
#   DATABASE_PATH=/var/lib/kball/data.db
#   BASE_URL=https://codeonline.io/kball
# To:
#   DATABASE_PATH=/var/lib/fifteenball/data.db
#   BASE_URL=https://codeonline.io/15ball
```

### 4. Deploy the new OpenRC service

```sh
# Remove the old init script from the default runlevel first.
doas rc-update del kball default 2>/dev/null || true
doas rm -f /etc/init.d/kball

# Install the new one from the git checkout.
doas cp /home/kevin/kball-scoresheet/server/openrc/fifteenball.initd /etc/init.d/fifteenball
doas chmod 755 /etc/init.d/fifteenball
doas rc-update add fifteenball default
```

### 5. Deploy the new binary

Build on your dev machine (or in CI) with `sh server/scripts/build.sh`, scp
to the VPS, then:

```sh
doas cp fifteenball-server /opt/fifteenball/bin/fifteenball-server
doas chown root:fifteenball /opt/fifteenball/bin/fifteenball-server
doas chmod 755 /opt/fifteenball/bin/fifteenball-server
```

### 6. Update nginx

Edit the codeonline server block. Replace the old `/kball/` and `/kball/api/`
`location` blocks with the new `/15ball/` versions, and add a 301 legacy
redirect for old bookmarks:

```nginx
# API first (longer ^~ prefix wins over the static alias below)
location ^~ /15ball/api/ {
    proxy_pass http://127.0.0.1:8093/api/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
}
# Static frontend from the repo clone
location ^~ /15ball/ {
    alias /home/kevin/15ball-scoresheet/;
    index index.html;
    location ~ /\.(?!well-known) { return 404; }
}
# Legacy /kball -> /15ball 301 redirect (keep for as long as bookmarks and
# already-sent magic-link emails might still hit the old path).
location = /kball        { return 301 /15ball/; }
location ^~ /kball/      { return 301 /15ball/; }
```

Also rename the frontend checkout so the alias line above is honest:

```sh
doas -u kevin mv /home/kevin/kball-scoresheet /home/kevin/15ball-scoresheet
```

Test and reload nginx:

```sh
doas nginx -t
doas rc-service nginx reload
```

### 7. Start the new service

```sh
doas rc-service fifteenball start
sleep 2
doas rc-service fifteenball status
curl -s http://127.0.0.1:8093/api/health          # expect {"status":"ok"}
curl -sI https://codeonline.io/15ball/api/health  # expect HTTP/2 200
curl -sI https://codeonline.io/kball/api/health   # expect HTTP/2 301 -> /15ball/api/health
```

## Post-cutover

- **Cookie invalidation is expected.** The session cookie name changed from
  `kball_session` (path `/kball/`) to `fifteenball_session` (path `/15ball/`).
  Every previously-signed-in user will be logged out and needs a fresh magic
  link. This is a one-time cost of the rename.
- **Magic-link emails already sent** point at `codeonline.io/kball/api/auth/verify?...`.
  The nginx 301 redirect above forwards them to `/15ball/api/auth/verify?...`
  with the query string preserved, so links in flight still work.
- **Backups.** The nightly backup script (once it lands per DESIGN.md #3) will
  now write to `/var/lib/fifteenball/backups/fifteenball-YYYY-MM-DD.db`. Old
  `kball-*.db` files under the moved dir keep their original names — leave
  them or rename in bulk with `rename 's/kball/fifteenball/' *.db` when
  convenient.

## Rollback (if the new service fails to start)

The rename is reversible so long as no data has been written to the new paths
by a broken service. Symmetric procedure:

```sh
doas rc-service fifteenball stop
doas rc-update del fifteenball default
doas rm -f /etc/init.d/fifteenball
doas mv /var/lib/fifteenball    /var/lib/kball
doas mv /var/log/fifteenball.log /var/log/kball.log
doas mv /etc/fifteenball        /etc/kball
doas mv /etc/kball/fifteenball.env /etc/kball/kball.env
doas mv /opt/fifteenball        /opt/kball
doas mv /opt/kball/bin/fifteenball-server /opt/kball/bin/kball-server
doas usermod -l kball fifteenball
doas groupmod -n kball fifteenball
# Restore the previous init script from git history:
git -C /home/kevin/15ball-scoresheet show HEAD~1:server/openrc/kball.initd \
  | doas tee /etc/init.d/kball >/dev/null
doas chmod 755 /etc/init.d/kball
doas rc-update add kball default
# Restore nginx to the previous /kball/ config block, `nginx -t`, reload.
doas rc-service kball start
```
