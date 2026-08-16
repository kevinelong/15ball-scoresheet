<!-- ============================================================= -->
<!-- SUPERSEDED IN PLACES — read SPEC-DESIGN-RECONCILED.md first    -->
<!-- ============================================================= -->
> **📌 Read `server/SPEC-DESIGN-RECONCILED.md` before implementing.** It is the
> accepted single source of truth for backend decisions. All 17 `Decision:` items
> from `server/SPEC-REVIEW.md` are answered there, and both deploy blockers are
> resolved (OpenRC init instead of systemd; same-origin `/kball/` + `/kball/api/`
> → `127.0.0.1:8093` instead of GitHub Pages + separate absolute API origin).
>
> Sections of THIS document are being rewritten to match. Trust a section only
> when its box in the “DESIGN.md delta” checklist at the bottom of the
> reconciliation is checked (`[x]`); unchecked sections may still reflect the
> pre-reconciliation assumptions (systemd, separate API origin, no CSRF, signed
> session tokens, no rate limits, no health endpoint, best-effort Challonge
> export). See also `server/AGENTS.md` for the design/implementation handoff
> protocol between the two agents working on this repo.

## 1. Table roster + assignment state on the server side

The browser's `tables[]` array is a useful setup-time representation, but it is not authoritative once cloud save is enabled. The server owns the roster, table state, and assignment history. The tournament JSON continues to own the bracket graph and score-sheet payload for MVP; the relational tables below are the concurrency boundary around physical tables.

A table is immutable in identity after creation. Its display name may change only while it has no live assignment. The client-generated IDs (`t_<random>`) are acceptable import IDs, but new cloud tables should use server-generated UUID-like text IDs. Do not use a table position as identity: names and ordering can change, while assignments must keep referring to the same physical surface.

### State model

`tables.state` is the current operational state, not a value trusted from `state` in a submitted tournament JSON document.

| State | Meaning | Allowed next state |
|---|---|---|
| `empty` | Clean, unlocked, and available for a new match. | `reserved`, `locked` |
| `reserved` | A scorer or director has claimed the table for a specific playable match but play has not begun. | `active`, `dirty`, `locked` |
| `active` | The assigned match is being scored at this table. | `dirty` |
| `dirty` | The match has ended or was released; the table needs confirmation that it is ready for the next players. | `empty`, `locked` |
| `locked` | Administrative hold: repair, league use, or director-only reservation. No assignment may be created. | `empty` or `dirty` |

`locked` is a state, not a Boolean that can accidentally coexist with `active`. The normal lock endpoint refuses an active table. A director must first finish or release the assignment so the audit trail says why the table stopped being used. Unlocking returns to `empty` when there is no just-finished assignment to clean, otherwise `dirty`. In practice, `dirty` is the post-match state and should be acknowledged with a clean action before another assignment.

An assignment has its own lifecycle: `reserved`, `active`, `finished`, `released`, or `cancelled`. At most one assignment whose status is `reserved` or `active` may exist for a table, and at most one may exist for a match. `finished`, `released`, and `cancelled` records are retained. This makes it possible to answer "where was match W-3 played?" after a tournament and lets a director correct a result without losing history.

The bracket match ID is the existing `bracket.matches[matchId].id` string, for example `W-3`; the server validates that it is present and playable in the submitted/current tournament state before assigning it. It is intentionally stored as text instead of creating a duplicate match table in MVP. If bracket editing later moves fully server-side, `assignments.match_id` can become a foreign key without changing the table-assignment API.

### SQLite schema

The existing `tournaments` table remains the canonical owner of its JSON state. It must have `id TEXT PRIMARY KEY`; its `updated_at` is also used by the sync design below. Enable foreign keys on every connection.

```sql
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS tables (
    id                  TEXT PRIMARY KEY,
    tournament_id       TEXT NOT NULL,
    name                TEXT NOT NULL COLLATE NOCASE,
    state               TEXT NOT NULL DEFAULT 'empty'
                        CHECK (state IN ('empty', 'reserved', 'active', 'dirty', 'locked')),
    state_version       INTEGER NOT NULL DEFAULT 1 CHECK (state_version > 0),
    locked_reason       TEXT,
    locked_by_user_id   TEXT,
    created_at          INTEGER NOT NULL,
    updated_at          INTEGER NOT NULL,
    FOREIGN KEY (tournament_id) REFERENCES tournaments(id) ON DELETE CASCADE,
    FOREIGN KEY (locked_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
    UNIQUE (tournament_id, name)
);

CREATE INDEX IF NOT EXISTS tables_by_tournament_state
    ON tables (tournament_id, state, name);

CREATE TABLE IF NOT EXISTS assignments (
    id                  TEXT PRIMARY KEY,
    tournament_id       TEXT NOT NULL,
    table_id            TEXT NOT NULL,
    match_id            TEXT NOT NULL,
    status              TEXT NOT NULL
                        CHECK (status IN ('reserved', 'active', 'finished', 'released', 'cancelled')),
    assigned_by_user_id TEXT NOT NULL,
    assigned_at         INTEGER NOT NULL,
    activated_at        INTEGER,
    ended_at            INTEGER,
    ended_by_user_id    TEXT,
    note                TEXT,
    created_at          INTEGER NOT NULL,
    updated_at          INTEGER NOT NULL,
    FOREIGN KEY (tournament_id) REFERENCES tournaments(id) ON DELETE CASCADE,
    FOREIGN KEY (table_id) REFERENCES tables(id) ON DELETE RESTRICT,
    FOREIGN KEY (assigned_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
    FOREIGN KEY (ended_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
    CHECK (
        (status IN ('reserved', 'active') AND ended_at IS NULL) OR
        (status IN ('finished', 'released', 'cancelled') AND ended_at IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS assignments_by_tournament_match
    ON assignments (tournament_id, match_id, assigned_at DESC);

CREATE INDEX IF NOT EXISTS assignments_by_table
    ON assignments (table_id, assigned_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS one_live_assignment_per_table
    ON assignments (table_id)
    WHERE status IN ('reserved', 'active');

CREATE UNIQUE INDEX IF NOT EXISTS one_live_assignment_per_match
    ON assignments (tournament_id, match_id)
    WHERE status IN ('reserved', 'active');
```

The partial unique indexes are the backstop, not the primary control flow. Every transition runs in a short SQLite write transaction started with `BEGIN IMMEDIATE`. That obtains the single SQLite writer reservation before checking table state, checking that the match is unassigned, inserting/updating the assignment, updating `tables.state`, and bumping the tournament sync marker. This makes two phones pressing "Assign" at the same time deterministic: one transaction commits; the other rereads or hits a unique constraint and returns `409 Conflict`.

Do not store a `current_match_id` in both `tables` and `assignments`; that would create a second source of truth. To render a table board, join the one live assignment:

```sql
SELECT t.id, t.name, t.state, t.state_version, t.locked_reason,
       a.id AS assignment_id, a.match_id, a.status AS assignment_status,
       a.assigned_at, a.activated_at
FROM tables AS t
LEFT JOIN assignments AS a
  ON a.table_id = t.id
 AND a.status IN ('reserved', 'active')
WHERE t.tournament_id = ?
ORDER BY t.name COLLATE NOCASE, t.id;
```

### Go types and transaction boundary

Use typed request/response structures. Do not accept `state` from an untrusted client save payload.

```go
type TableState string

const (
    TableEmpty    TableState = "empty"
    TableReserved TableState = "reserved"
    TableActive   TableState = "active"
    TableDirty    TableState = "dirty"
    TableLocked   TableState = "locked"
)

type Table struct {
    ID            string     `json:"id"`
    TournamentID  string     `json:"tournamentId"`
    Name          string     `json:"name"`
    State         TableState `json:"state"`
    StateVersion  int64      `json:"stateVersion"`
    LockedReason  *string    `json:"lockedReason,omitempty"`
    Assignment    *Assignment `json:"assignment,omitempty"`
}

type Assignment struct {
    ID        string `json:"id"`
    TableID   string `json:"tableId"`
    MatchID   string `json:"matchId"`
    Status    string `json:"status"`
    AssignedAt int64 `json:"assignedAt"`
    ActivatedAt *int64 `json:"activatedAt,omitempty"`
}

type ExpectedTableVersion struct {
    ExpectedStateVersion int64 `json:"expectedStateVersion"`
}

type AssignTableRequest struct {
    MatchID              string `json:"matchId"`
    ExpectedStateVersion int64  `json:"expectedStateVersion"`
}

type LockTableRequest struct {
    Reason               string `json:"reason"`
    ExpectedStateVersion int64  `json:"expectedStateVersion"`
}
```

A single helper owns the mutation pattern. Open the `modernc.org/sqlite` database with `_txlock=immediate`, so `database/sql`'s `BeginTx` starts each write transaction with SQLite's immediate lock. It is acceptable for it to retry a transient `SQLITE_BUSY` once for a few milliseconds, but it must not turn a business conflict into a retry loop.

```go
// DATABASE_PATH is opened as:
// file:/var/lib/kball/data.db?_txlock=immediate&_pragma=busy_timeout(5000)
func (s *Store) withImmediateTx(ctx context.Context, fn func(*sql.Tx) error) (err error) {
    tx, err := s.db.BeginTx(ctx, nil)
    if err != nil { return err }
    defer func() {
        if err != nil {
            _ = tx.Rollback()
        }
    }()
    if err = fn(tx); err != nil { return err }
    return tx.Commit()
}
```

The important design constraint is that all reads used to decide a transition and all writes that enact it use the same immediate transaction. Do not accidentally read through `s.db` outside the transaction.

### Endpoint contracts

All routes require a valid session and authorization to the tournament. All mutation bodies include `expectedStateVersion`; a stale UI must not silently overwrite a newer table transition. JSON errors use:

```json
{
  "error": {
    "code": "table_not_empty",
    "message": "Table 3 is already reserved for W-3.",
    "table": { "id": "tbl_...", "state": "reserved", "stateVersion": 12 },
    "assignment": { "id": "asn_...", "matchId": "W-3", "status": "reserved" }
  }
}
```

| Method and route | Request | Success | `409 Conflict` cases |
|---|---|---|---|
| `GET /api/tournaments/{tournamentId}/tables` | none | `200` array of joined table board records | none |
| `POST /api/tournaments/{tournamentId}/tables` | `{name}` | `201` table in `empty` state | duplicate name; tournament has started and roster edits are disabled |
| `PATCH /api/tournaments/{tournamentId}/tables/{id}` | `{name, expectedStateVersion}` | `200` renamed table | stale version; table has a live assignment; duplicate name |
| `POST /api/tables/{id}/assign` | `{matchId, expectedStateVersion}` | `201` `{table, assignment}`; table becomes `reserved` | stale version; table is not `empty`; match is already live at another table; match is not playable or already decided |
| `POST /api/tables/{id}/activate` | `{assignmentId, expectedStateVersion}` | `200`; `reserved -> active` | stale version; assignment is not this table's live `reserved` assignment; table is locked or not reserved |
| `POST /api/tables/{id}/release` | `{assignmentId, expectedStateVersion, note}` | `200`; live assignment becomes `released`, table becomes `dirty` | stale version; assignment is not live on this table |
| `POST /api/tables/{id}/finish` | `{assignmentId, expectedStateVersion}` | `200`; live assignment becomes `finished`, table becomes `dirty` | stale version; assignment is not `active` |
| `POST /api/tables/{id}/clean` | `{expectedStateVersion}` | `200`; `dirty -> empty` | stale version; table is not `dirty` |
| `POST /api/tables/{id}/lock` | `{reason, expectedStateVersion}` | `200`; `empty|reserved|dirty -> locked` | stale version; table is `active`; requester lacks director role |
| `POST /api/tables/{id}/unlock` | `{expectedStateVersion}` | `200`; `locked -> empty` or `locked -> dirty` as recorded by the lock transition | stale version; table is not locked; requester lacks director role |

`POST /api/tables/{id}/assign` is deliberately table-addressed. A director selecting a match card and a table has one clear claim action, and the server can report whether the conflict is the table or the match. It validates the bracket match from the latest stored tournament JSON in the same transaction before it writes the assignment. An assignment never starts a pending match with a bye or missing player.

The transition pseudocode for assignment is:

```text
BEGIN IMMEDIATE
load table by id and tournament authorization
if table.state_version != request.expectedStateVersion: 409 stale_table_version
if table.state != empty: 409 table_not_empty
load tournament state JSON; if match is not playable or is decided: 409 match_not_assignable
if a live assignment exists for match: 409 match_already_assigned
INSERT assignments (..., status='reserved', ended_at=NULL)
UPDATE tables
   SET state='reserved', state_version=state_version+1, updated_at=?
 WHERE id=? AND state='empty' AND state_version=?
if rows affected != 1: 409 stale_table_version
advance tournament updated_at and commit
notify tournament watcher
```

If the partial unique index fires after the explicit checks, map its known constraint name to `409 match_already_assigned` or `409 table_not_empty`, rollback, then query the current table board for the response body. Do not return `500` for an expected double-click or a concurrent scorer.

Roster import from existing client state is one-time: create each row with the existing ID and name, force state to `empty`, and create no assignments. A client JSON `state` field must be ignored at import and thereafter. If a cloud tournament already has rows, server roster rows win and are returned alongside the document state so an old browser cannot erase a live assignment by posting a stale `tables[]` array.

**MVP decision:** Add relational `tables` and `assignments` now, use immediate SQLite transactions plus partial unique indexes, and expose the eight table-board routes. Keep bracket matches inside the tournament JSON document and defer a normalized `matches` table and automatic scheduling.

## 2. Multi-tenant scoping

MVP is one Columbia Cue Club deployment with one shared Challonge account and one key in the server environment. Do not build a club-management UI, per-owner encryption, or a tenant selector before there is a second real club. The deployment's `CHALLONGE_API_KEY` and optional `CHALLONGE_SUBDOMAIN` remain the only credentials used by `/api/export/challonge`.

The schema should nevertheless make every durable tournament-related record scope-ready today. Add an `organization_id` column as nullable during the first migration, then write the fixed Columbia Cue Club organization ID for every newly created row. This avoids an expensive rewrite of primary keys or public route IDs later. The application treats the fixed organization as implicit in MVP; no route accepts an organization slug yet.

```sql
CREATE TABLE IF NOT EXISTS organizations (
    id          TEXT PRIMARY KEY,
    slug        TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name        TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);

INSERT OR IGNORE INTO organizations (id, slug, name, created_at, updated_at)
VALUES ('org_columbia_cue_club', 'columbia-cue-club', 'Columbia Cue Club', 0, 0);

ALTER TABLE tournaments ADD COLUMN organization_id TEXT;
ALTER TABLE tables ADD COLUMN organization_id TEXT;
ALTER TABLE assignments ADD COLUMN organization_id TEXT;

UPDATE tournaments SET organization_id = 'org_columbia_cue_club'
 WHERE organization_id IS NULL;
UPDATE tables SET organization_id = 'org_columbia_cue_club'
 WHERE organization_id IS NULL;
UPDATE assignments SET organization_id = 'org_columbia_cue_club'
 WHERE organization_id IS NULL;

CREATE INDEX IF NOT EXISTS tournaments_by_organization
    ON tournaments (organization_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS tables_by_organization
    ON tables (organization_id, tournament_id);
CREATE INDEX IF NOT EXISTS assignments_by_organization
    ON assignments (organization_id, tournament_id);
```

SQLite cannot conveniently add all desired foreign keys through `ALTER TABLE`. When the schema is next rebuilt for a real tenancy feature, make `organization_id TEXT NOT NULL REFERENCES organizations(id)` in `tournaments`, `tables`, and `assignments`, and include it in indexes and uniqueness constraints where appropriate. The service must set it from the authenticated principal, never from an arbitrary request body.

Ownership is separate from tenancy. The current user-level ownership behavior remains:

```sql
-- Existing or first migration shape to retain.
-- One tournament has one creator/owner in MVP; sharing can be added later.
ALTER TABLE tournaments ADD COLUMN owner_user_id TEXT;
CREATE INDEX IF NOT EXISTS tournaments_by_owner
    ON tournaments (owner_user_id, updated_at DESC);
```

When the club needs shared director/scorer access, add membership and tournament role tables instead of duplicating tournaments or turning every owner into a tenant:

```sql
CREATE TABLE organization_memberships (
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role            TEXT NOT NULL CHECK (role IN ('admin', 'director', 'scorer', 'viewer')),
    created_at      INTEGER NOT NULL,
    PRIMARY KEY (organization_id, user_id)
);

CREATE TABLE tournament_memberships (
    tournament_id   TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role            TEXT NOT NULL CHECK (role IN ('director', 'scorer', 'viewer')),
    created_at      INTEGER NOT NULL,
    PRIMARY KEY (tournament_id, user_id)
);
```

Per-owner or per-organization Challonge configuration should be added only when more than Columbia Cue Club needs it. Keep keys out of `organizations`: normal application reads must never select a credential column. Use a separate one-to-one credentials table containing an encrypted ciphertext and a key identifier. Encryption key material stays in the VPS environment or a secret manager, never in SQLite or Git.

```sql
CREATE TABLE challonge_credentials (
    organization_id      TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
    account_label        TEXT NOT NULL,
    subdomain            TEXT,
    api_key_ciphertext   BLOB NOT NULL,
    encryption_key_id    TEXT NOT NULL,
    created_by_user_id   TEXT NOT NULL REFERENCES users(id),
    created_at           INTEGER NOT NULL,
    updated_at           INTEGER NOT NULL,
    last_verified_at     INTEGER,
    revoked_at           INTEGER
);
```

At that point, route authorization resolves `organization_id` from the session and membership, loads the active credential only in the export service, decrypts it in memory, performs the Challonge request, and discards it. There must be an explicit "test connection" and rotation path. Do not expose the key to browsers. The historical research supports proxying Challonge because browser CORS and key exposure are unsuitable; it does not justify inventing a FargoRate API integration.

The future URL shape may become `/api/orgs/{slug}/tournaments`, but preserve current `/api/tournaments/{id}` routes as aliases selected from the caller's only active organization. UUID-like tournament IDs keep that transition free of ID collisions. For MVP, every data access function takes an `organizationID` argument internally even though the middleware supplies the single constant. This is cheap discipline that prevents an accidental unscoped query later.

```go
type Scope struct {
    OrganizationID string
    UserID         string
    Role           string
}

func (s *Store) TournamentByID(ctx context.Context, scope Scope, id string) (Tournament, error) {
    // Always include organization_id in the WHERE clause.
    const q = `SELECT id, state_json, updated_at
                 FROM tournaments
                WHERE id = ? AND organization_id = ?`
    // ...
}
```

**MVP decision:** Operate as a single Columbia Cue Club tenant with the shared environment key. Add and populate an implicit `organization_id` now, but defer organization UI, memberships, credential encryption, and per-owner Challonge accounts until a second club requires them.

## 3. Deployment-target specifics

Deploy a single static Go `linux/amd64` binary to Kevin's existing Ubuntu 22.04+ VPS. Nginx owns public TLS and proxies only to loopback. SQLite, environment secrets, logs, releases, and the running binary have separate locations so upgrades do not touch data.

### Filesystem and account layout

```text
/opt/kball/
  bin/
    kball-server                  # current executable, owned by root:kball
  releases/
    v1.2.3/kball-server           # immutable downloaded release binaries
  deploy/
    kball.service
    nginx-kball.conf
    logrotate-kball
  .env                            # root:kball, mode 0640

/var/lib/kball/
  data.db
  data.db-wal                     # transient when SQLite WAL is active
  data.db-shm                     # transient when SQLite WAL is active
  backups/
    kball-2026-08-16.db

/var/log/kball/
  kball.log
  kball-error.log
```

Create a dedicated system account with no shell or home directory. The service needs write access only to `/var/lib/kball` and `/var/log/kball`; deployment operators update `/opt/kball` through `sudo` or a controlled release script.

```sh
sudo groupadd --system kball
sudo useradd --system --gid kball --home-dir /nonexistent \
  --shell /usr/sbin/nologin kball
sudo install -d -o root -g kball -m 0750 /opt/kball /opt/kball/bin /opt/kball/releases
sudo install -d -o kball -g kball -m 0750 /var/lib/kball /var/lib/kball/backups
sudo install -d -o kball -g kball -m 0750 /var/log/kball
sudo install -o root -g kball -m 0640 /dev/null /opt/kball/.env
```

Set `DATABASE_PATH=/var/lib/kball/data.db` and `LISTEN_ADDR=127.0.0.1:8080` in `/opt/kball/.env`. Set `umask 0027` in the service so newly created database and log files do not become world-readable. Use SQLite WAL mode and a nonzero busy timeout in application startup:

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
```

### systemd unit

`/etc/systemd/system/kball.service`:

```ini
[Unit]
Description=Columbia Cue Club tournament backend
Documentation=https://github.com/<owner>/kball-scoresheet
After=network-online.target
Wants=network-online.target

[Service]
Type=exec
User=kball
Group=kball
WorkingDirectory=/opt/kball
EnvironmentFile=/opt/kball/.env
ExecStart=/opt/kball/bin/kball-server
Restart=on-failure
RestartSec=3s
TimeoutStartSec=20s
TimeoutStopSec=20s
UMask=0027

# Least privilege and filesystem isolation.
NoNewPrivileges=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectSystem=strict
ProtectHome=yes
ProtectControlGroups=yes
ProtectKernelModules=yes
ProtectKernelTunables=yes
ProtectKernelLogs=yes
ProtectClock=yes
ProtectHostname=yes
LockPersonality=yes
MemoryDenyWriteExecute=yes
RestrictSUIDSGID=yes
RestrictRealtime=yes
RestrictNamespaces=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
SystemCallArchitectures=native
SystemCallFilter=@system-service @network-io
CapabilityBoundingSet=
AmbientCapabilities=
ReadWritePaths=/var/lib/kball /var/log/kball
ReadOnlyPaths=/opt/kball

[Install]
WantedBy=multi-user.target
```

`ProtectSystem=strict` means `/opt/kball` is read-only to the service and `ReadWritePaths` is mandatory for its database and logs. Do not enable `DynamicUser=yes`: stable ownership of SQLite and backup files is simpler for this small shared VPS. Keep the binary on loopback; systemd does not need any privileged network capability.

Install and operate it with:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now kball.service
sudo systemctl status kball.service
sudo journalctl -u kball.service -f
```

The application should emit structured one-line JSON logs to stdout/stderr. systemd journald is the primary service log. If application configuration also writes the two files shown above, rotate them as follows; do not have two independent writers writing the same log stream.

### nginx and Certbot

Create `/etc/nginx/sites-available/tournaments.columbiacueclub.com` and symlink it into `sites-enabled`. This is a standalone server block for the API host; the static GitHub Pages frontend may use a different origin.

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name tournaments.columbiacueclub.com;

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name tournaments.columbiacueclub.com;

    ssl_certificate /etc/letsencrypt/live/tournaments.columbiacueclub.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/tournaments.columbiacueclub.com/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    access_log /var/log/nginx/kball-access.log;
    error_log  /var/log/nginx/kball-error.log warn;

    client_max_body_size 2m;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 5s;
        proxy_send_timeout 35s;
        proxy_read_timeout 35s;
        proxy_buffering off;
    }
}
```

Provision TLS after DNS points at the VPS:

```sh
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d tournaments.columbiacueclub.com
sudo systemctl enable --now certbot.timer
```

If the GitHub Pages origin differs from `BASE_URL`, configure the backend's exact allowed origin, for example `https://<github-user>.github.io`, and use credentialed CORS only for that known origin. Never use `Access-Control-Allow-Origin: *` with magic-link session cookies. The auth callback should redirect to the configured static frontend URL, not blindly reflect a request parameter.

### Log rotation

If file logs are enabled, create `/etc/logrotate.d/kball`:

```conf
/var/log/kball/kball.log /var/log/kball/kball-error.log {
    daily
    rotate 14
    missingok
    notifempty
    compress
    delaycompress
    dateext
    dateformat -%Y%m%d
    create 0640 kball kball
    sharedscripts
    postrotate
        /bin/systemctl kill -s USR1 kball.service >/dev/null 2>&1 || true
    endscript
}
```

Implement `SIGUSR1` reopening only if the application writes files itself; otherwise remove the `postrotate` block and rely on journald. Nginx's existing distribution logrotate configuration handles the nginx logs separately.

### SQLite backup

Backups use SQLite's online backup command, never `cp` of a live database, WAL file, or SHM file. Install `/usr/local/sbin/kball-sqlite-backup` as root-owned, executable mode `0750`:

```sh
#!/bin/sh
set -eu
umask 0027
stamp=$(date -u +%F)
out=/var/lib/kball/backups/kball-${stamp}.db
/usr/bin/sqlite3 /var/lib/kball/data.db ".backup '${out}'"
/usr/bin/find /var/lib/kball/backups -type f -name 'kball-*.db' -mtime +30 -delete
```

Then add a root crontab entry (or an equivalent systemd timer) that writes a daily backup after the venue's active period:

```cron
17 4 * * * /usr/local/sbin/kball-sqlite-backup >> /var/log/kball/backup.log 2>&1
```

Test restoration periodically on a copy: `sqlite3 restored.db 'PRAGMA integrity_check;'`. Copy encrypted backups off the VPS when the club's operational process is ready; a backup stored only on the same disk is not disaster recovery.

### CI/CD sketch

On an annotated tag such as `v1.2.3`, GitHub Actions runs tests, builds a Linux AMD64 binary with CGo disabled, produces a checksum, and uploads both to the GitHub Release. The build uses `modernc.org/sqlite`, so `CGO_ENABLED=0` is valid.

```yaml
name: release-server
on:
  push:
    tags: ['v*']

permissions:
  contents: write

jobs:
  release:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: server
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version: stable
      - run: go test ./...
      - run: >-
          CGO_ENABLED=0 GOOS=linux GOARCH=amd64
          go build -trimpath -ldflags='-s -w -X main.version=${{ github.ref_name }}'
          -o kball-server ./...
      - run: sha256sum kball-server > kball-server-linux-amd64.sha256
      - uses: softprops/action-gh-release@v2
        with:
          files: |
            server/kball-server
            server/kball-server-linux-amd64.sha256
```

The first deployment method should be manual pull, because it is observable and requires no inbound webhook listener. A root-owned `kball-deploy` script downloads the selected release asset, verifies its SHA-256 checksum, puts it in `/opt/kball/releases/<tag>/`, atomically updates `/opt/kball/bin/kball-server` (a symlink or `install` plus rename), and runs `systemctl restart kball`. A later GitHub webhook can invoke that exact script after verifying an HMAC signature, but it is optional and must not accept an arbitrary download URL or tag name.

```sh
# Operator workflow after the release is published.
sudo /usr/local/sbin/kball-deploy v1.2.3
sudo systemctl status kball.service --no-pager
curl -fsS https://tournaments.columbiacueclub.com/api/me || true
```

**MVP decision:** Deploy one hardened loopback Go service under `kball`, reverse-proxied by the existing nginx, with a WAL SQLite database, daily `.backup` backup cron, and manual verified GitHub Release pulls. Defer webhook-triggered deployment and offsite backup automation.

## 4. Client↔server migration path

The v3 browser state is an app document under `localStorage["kball.app.v3"]` with `{v: 3, tournaments: [], activeId}`. Each tournament has `id`, setup fields, `createdAt`, `updatedAt`, `participants`, `bracket`, `sheets`, and now `tables`. Existing v3 records may lack `game` and `tables`, and current `loadPersisted()` already backfills those fields. Preserve that compatibility during rollout.

Once a user is authenticated and `KBALL_BACKEND_URL` is configured, the server is the source of truth. The browser's local storage becomes an offline cache and an import source, not a peer authority. A signed-out frontend stays exactly as it is today: local-only, with no cloud or Challonge controls.

### Cloud envelope and timestamps

Do not overload the app document's `updatedAt` with sync protocol metadata. Add a local-only cloud cache envelope around the existing tournament payload:

```json
{
  "v": 1,
  "tournament": { "id": "t_...", "name": "Sunday K-Ball", "updatedAt": 1786800700000 },
  "sync": {
    "base_updated_at": 1786800600123,
    "updated_at": 1786800700000,
    "device_id": "7a6f...",
    "dirty": true
  }
}
```

- `tournament.updatedAt` remains the app-friendly Unix-milliseconds field already used for sorting and display.
- `sync.updated_at` is the mutation timestamp used for last-write-wins. Generate it as `max(Date.now(), previousSyncUpdatedAt + 1)` so edits on one offline device are strictly ordered even in the same millisecond.
- `sync.base_updated_at` is the server `updated_at` seen when this cached version last synchronized.
- `sync.device_id` is a randomly generated UUID persisted once in browser storage. It is a deterministic tie-breaker only, not an identity or authorization mechanism.
- The server persists `state_json`, `updated_at`, and `updated_by_user_id`; `updated_at` is an integer Unix-milliseconds logical timestamp. For an accepted write, it uses `max(client_updated_at, server_now_ms, current_updated_at + 1)` and returns that value. It never lets a client set `updated_by_user_id`.

A cloud response is an envelope, not bare document JSON:

```json
{
  "tournament": { "id": "t_...", "name": "Sunday K-Ball", "...": "..." },
  "updated_at": 1786800700456
}
```

The server must exclude client `tables` state from document replacement once the relational table feature is enabled. On read, it provides the server table board separately or overlays it into the returned view; on write, it preserves server roster/assignment state. A stale offline document must never reset a table from `active` to `empty`.

### Initial opt-in migration

1. On first successful sign-in, fetch `GET /api/tournaments` before uploading anything.
2. Read the local v3 state and run the existing field backfills (`game`, `tables`) in memory.
3. For each local tournament ID absent from the server, prompt the user to upload it as a new cloud tournament. The upload seeds `tables` from names and IDs but forces all table states to `empty` as described above.
4. For each ID already on the server, do not overwrite it on first sign-in. Fetch the server copy, store it in the cache envelope, and present any local divergent copy as an importable "Local conflict copy" only if the user chooses to preserve it.
5. After this one-time choice, the client uses the normal sync algorithm below. Keep local exports available as a recovery path.

There is no automatic global merge of two independent bracket documents. Bracket links, participant lists, sheets, and result propagation form a graph; combining fields from two independently edited graphs can create an impossible bracket. LWW is intentionally at the whole-tournament-document level. Table state is an exception because it is independently normalized and server-authoritative.

### Exact reconnect and conflict algorithm

This is the deterministic behavior when a user edited a tournament offline in two browsers.

1. Each browser has a cache envelope. On every local mutation, it writes the changed tournament payload to its cache, sets `dirty=true`, and generates a monotonic local `sync.updated_at` as above. It never calls the Challonge proxy while dirty/offline.
2. On reconnect, browser A calls `GET /api/tournaments/{id}`. It receives remote payload `R` and remote `R.updated_at`. If the cache is not dirty, A replaces its cached payload and `base_updated_at` with R.
3. If cache `L` is dirty and `L.sync.base_updated_at == R.updated_at`, no other cloud change occurred since A's baseline. A sends `PUT /api/tournaments/{id}` with the payload, `base_updated_at`, `client_updated_at=L.sync.updated_at`, and `device_id`. The server updates atomically if its current `updated_at` still equals `base_updated_at`, assigns its canonical new timestamp, and returns the new envelope. A replaces cache and clears `dirty`.
4. If `L.sync.base_updated_at != R.updated_at`, the documents diverged. Compare the ordered pair `(updated_at, device_id)` for local L and remote R. The larger pair wins. Timestamp is first; if timestamps are equal, lexicographically larger `device_id` wins. This tie rule makes every browser reach the same answer.
5. If R wins, A replaces the active cache with R and clears `dirty`. It also stores L in a local `kball.conflicts.v1` array with its timestamp and a timestamped name suffix so a director can export or inspect it. It does not automatically create a duplicate cloud tournament.
6. If L wins, A retries the conditional `PUT` using R's `updated_at` as `base_updated_at`. The server validates the baseline, accepts L as a full document replacement, assigns a new canonical `updated_at`, and returns it. If another write wins between fetch and PUT, the server returns `409 tournament_conflict` including its latest timestamp; A returns to step 2, with a bounded three-attempt loop. After three racing conflicts, keep L in the conflict cache and show a refresh-required message rather than spinning.
7. Browser B follows the same steps. Because server responses are canonical and the pair tie-break is stable, it converges on the same winner after its next watch response or refresh.

The conditional write contract is:

```http
PUT /api/tournaments/t_abc
Content-Type: application/json

{
  "tournament": { "id": "t_abc", "name": "Sunday K-Ball", "...": "..." },
  "base_updated_at": 1786800600123,
  "client_updated_at": 1786800700000,
  "device_id": "7a6f..."
}
```

A conflicting response is `409 Conflict`, not a last-minute silent overwrite:

```json
{
  "error": {
    "code": "tournament_conflict",
    "message": "Tournament changed after this browser last synchronized.",
    "updated_at": 1786800710000
  }
}
```

The server does not use browser wall clocks to grant authority. It uses the timestamp only to decide which divergent offline document wins, then assigns a canonical logical timestamp on every accepted write. A wildly incorrect device clock can still make its offline document win under LWW; that is an accepted MVP tradeoff, mitigated by keeping the losing local conflict copy. Moving to field-level CRDTs or interactive conflict resolution would be disproportionate for one club and unsafe for bracket dependencies.

After sign-in, writes must be made through cloud APIs, not through the existing ambiguous `POST /api/tournaments` "create or overwrite" behavior. Keep `POST /api/tournaments` for create; use `PUT /api/tournaments/{id}` with the conditional body for updates. `DELETE` should similarly require the latest `updated_at` or an explicit confirmation action so a stale phone cannot delete a recently edited tournament.

**MVP decision:** Make the authenticated server authoritative and retain v3 local storage as an offline cache. Implement whole-document, timestamp-plus-device-ID LWW with conditional PUTs and a retained local losing copy; defer field-level merging and collaboration conflict UI.

## 5. Realtime multi-scorer sync

Six concurrent tables do not justify WebSockets in MVP. Use HTTP long-polling:

```text
GET /api/tournaments/{id}/watch?since=<updated_at>
```

The client immediately issues the next request after every response. The server holds a request for at most 30 seconds. It returns immediately if the tournament's canonical `updated_at` is newer than `since`, or returns a timeout response when it is unchanged. Clients then fetch the changed tournament/table board with ordinary authenticated GET requests.

Long-poll is the right first implementation because it has simpler infrastructure, no persistent connection state in nginx, works through normal HTTPS reverse proxying, and is easy to inspect with `curl`. It avoids the reconnection, ping, fan-out, and backpressure work that WebSockets would add on a mid-sized VPS shared with unrelated projects. The URL and cursor shape survive an upgrade: later SSE or WebSocket messages can carry the same `{tournamentId, updated_at, changed}` notification without changing the client reconciliation model.

### Watch endpoint contract

```http
GET /api/tournaments/t_abc/watch?since=1786800700456
Cookie: kball_session=...
```

If an update has occurred:

```http
HTTP/1.1 200 OK
Cache-Control: no-store
Content-Type: application/json

{
  "tournamentId": "t_abc",
  "updated_at": 1786800700622,
  "changed": ["tournament", "tables"]
}
```

If no update arrives within 30 seconds:

```http
HTTP/1.1 204 No Content
Cache-Control: no-store
X-KBall-Updated-At: 1786800700456
```

Return `401` for no session, `403` for a user without tournament access, and `400` for a malformed or negative `since`. A `since` value older than the current row returns immediately. `changed` is an advisory invalidation hint, not an event log: clients refetch the current data and compare its `updated_at`. This deliberately avoids retaining an unbounded event history.

Each successful mutation that changes a tournament document, roster, assignment, or table state does the following in its database transaction:

1. advances the tournament's canonical `updated_at` monotonically;
2. commits the transaction;
3. calls `hub.Notify(tournamentID)` after commit.

Never notify before commit. A woken request must be able to read the state it was told changed.

### Server-side implementation sketch

Use an in-process per-tournament condition variable map. One Go process and one SQLite file are the MVP topology, so a process-local hub is sufficient. The mutex guarding the map is separate from database locks, and it is never held while querying SQLite.

```go
type tournamentSignal struct {
    cond    *sync.Cond
    waiters int
}

type WatchHub struct {
    mu      sync.Mutex
    signals map[string]*tournamentSignal
}

func NewWatchHub() *WatchHub {
    return &WatchHub{signals: make(map[string]*tournamentSignal)}
}

func (h *WatchHub) acquire(tournamentID string) *tournamentSignal {
    h.mu.Lock()
    defer h.mu.Unlock()
    s := h.signals[tournamentID]
    if s == nil {
        s = &tournamentSignal{}
        s.cond = sync.NewCond(&sync.Mutex{})
        h.signals[tournamentID] = s
    }
    s.waiters++
    return s
}

func (h *WatchHub) release(tournamentID string, s *tournamentSignal) {
    h.mu.Lock()
    defer h.mu.Unlock()
    s.waiters--
    if s.waiters == 0 {
        delete(h.signals, tournamentID)
    }
}

func (h *WatchHub) Notify(tournamentID string) {
    h.mu.Lock()
    s := h.signals[tournamentID]
    h.mu.Unlock()
    if s == nil { return }
    s.cond.L.Lock()
    s.cond.Broadcast()
    s.cond.L.Unlock()
}
```

`sync.Cond` has no context-aware wait or timeout primitive. The handler uses a deadline timer that broadcasts the same condition and a predicate loop that checks both the database marker and the deadline. It always checks the condition before waiting so a notification between the initial database read and `Wait()` cannot be lost.

```go
func (s *Server) watchTournament(w http.ResponseWriter, r *http.Request) {
    id := chi.URLParam(r, "id")
    since, err := parseUpdatedAt(r.URL.Query().Get("since"))
    if err != nil { writeError(w, http.StatusBadRequest, "bad_since", "since must be an integer"); return }
    if err := s.authorizeTournament(r.Context(), id); err != nil { writeAuthError(w, err); return }

    deadline := time.Now().Add(30 * time.Second)
    sig := s.watchHub.acquire(id)
    defer s.watchHub.release(id, sig)

    timer := time.AfterFunc(time.Until(deadline), func() {
        sig.cond.L.Lock()
        sig.cond.Broadcast()
        sig.cond.L.Unlock()
    })
    defer timer.Stop()

    for {
        current, changed, err := s.store.TournamentMarker(r.Context(), id)
        if err != nil { writeStoreError(w, err); return }
        if current > since {
            writeJSON(w, http.StatusOK, WatchResponse{TournamentID: id, UpdatedAt: current, Changed: changed})
            return
        }
        if time.Now().After(deadline) {
            w.Header().Set("Cache-Control", "no-store")
            w.Header().Set("X-KBall-Updated-At", strconv.FormatInt(current, 10))
            w.WriteHeader(http.StatusNoContent)
            return
        }

        sig.cond.L.Lock()
        // Recheck after taking the condition lock before sleeping.
        sig.cond.Wait()
        sig.cond.L.Unlock()

        if err := r.Context().Err(); err != nil { return }
    }
}
```

The exact production code should prevent indefinite connection retention after a client disconnect. A plain `sync.Cond` cannot be directly interrupted by `r.Context().Done()`, so register a short periodic wake (for example, one second) alongside the 30-second deadline, or use an internal channel-based notifier if cancellation behavior becomes important. The requested `sync.Cond` map remains the primary fan-out mechanism; the periodic wake is only a context/cancellation escape hatch.

At six phones plus a director laptop, this means at most seven sleeping requests per actively viewed tournament, renewed roughly twice per minute. Set nginx's `proxy_read_timeout` above the server timeout (35 seconds in the server block) and disable proxy buffering on this location. No websocket upgrade headers or special nginx module are needed.

Client behavior:

```js
async function watchTournament(id, since) {
  const res = await fetch(`${backendUrl}/api/tournaments/${encodeURIComponent(id)}/watch?since=${since}`, {
    credentials: "include",
    cache: "no-store"
  });
  if (res.status === 204) return Number(res.headers.get("X-KBall-Updated-At")) || since;
  if (!res.ok) throw new Error(`watch failed: ${res.status}`);
  const event = await res.json();
  await refreshTournamentAndTableBoard(id);
  return event.updated_at;
}
```

On a watch update, a client with no local dirty edits adopts the server cache. A client with offline dirty edits runs the section 4 conflict algorithm instead of overwriting its draft. Local edits still update the UI immediately; receiving another scorer's table reservation changes the table board after refetch and prevents the UI from offering an obsolete assignment.

A later multi-instance deployment would replace `WatchHub.Notify` with a small durable/pub-sub layer (SQLite polling, Redis, or Postgres notifications) while retaining the HTTP endpoint. Do not add that infrastructure while the service is one process on one VPS.

**MVP decision:** Implement 30-second authenticated HTTP long-poll with a process-local per-tournament `sync.Cond` hub and post-commit notifications. Defer SSE, WebSockets, event retention, and cross-process pub/sub.

## 6. Frontend build integration

The frontend remains a plain static GitHub Pages site with no bundler, environment substitution, or deployment-specific JavaScript build. Put the optional backend base URL in `index.html`:

```html
<meta name="kball-backend-url" content="">
```

For the hosted club frontend, set it to the HTTPS API origin, with no trailing slash:

```html
<meta name="kball-backend-url" content="https://tournaments.columbiacueclub.com">
```

The empty default is intentional. A downloaded copy, GitHub Pages preview, or local `file://` session remains local-only exactly as it works now. Do not put API keys, client secrets, or a Challonge token in this tag.

Place this code near the existing `STORAGE_KEY` constants at the top of `app.js`. It is compatible with the current IIFE and uses no build tooling:

```js
const backendMeta = document.querySelector('meta[name="kball-backend-url"]');
const KBALL_BACKEND_URL = (backendMeta?.getAttribute("content") || "")
  .trim()
  .replace(/\/+$/, "");
const cloudEnabled = /^https:\/\//i.test(KBALL_BACKEND_URL) ||
  (/^http:\/\/localhost(?::\d+)?$/i.test(KBALL_BACKEND_URL));

function backendPath(path) {
  if (!cloudEnabled) throw new Error("Cloud features are not configured.");
  return KBALL_BACKEND_URL + path;
}

async function apiFetch(path, options) {
  const res = await fetch(backendPath(path), {
    credentials: "include",
    headers: {
      Accept: "application/json",
      ...(options && options.body ? { "Content-Type": "application/json" } : {}),
      ...(options && options.headers ? options.headers : {})
    },
    ...options
  });
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.json()).error?.message || ""; } catch (e) { /* non-JSON error */ }
    const err = new Error(detail || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

async function currentUser() {
  if (!cloudEnabled) return null;
  try { return await apiFetch("/api/me"); }
  catch (err) {
    if (err.status === 401) return null;
    throw err;
  }
}

function setCloudFeatureVisibility(user) {
  const enabled = Boolean(cloudEnabled && user);
  document.querySelectorAll("[data-requires-cloud]").forEach((el) => {
    el.hidden = !enabled;
    el.disabled = !enabled;
  });
  document.querySelectorAll("[data-requires-auth]").forEach((el) => {
    el.hidden = !cloudEnabled || Boolean(user);
  });
}

async function initializeCloudFeatureGate() {
  const user = await currentUser();
  setCloudFeatureVisibility(user);
}
```

Use the existing DOM initialization listener rather than adding a competing one. Keep local rendering immediate, then invoke the helper to reveal authenticated cloud controls:

```js
document.addEventListener("DOMContentLoaded", () => {
  renderRacks();
  wireUp();
  loadPersisted();
  if (app.activeId && activeT()) showBracket(app.activeId);
  else showHome();
  initializeCloudFeatureGate().catch((err) => {
    console.warn("Cloud sign-in check failed:", err);
  });
});
```

Mark cloud-only controls in HTML, rather than branching every click handler:

```html
<button type="button" data-action="push-challonge" data-requires-cloud hidden>
  Push to Challonge
</button>
<button type="button" data-action="cloud-save" data-requires-cloud hidden>
  Cloud Save
</button>
<button type="button" data-action="sign-in" data-requires-auth hidden>
  Sign in
</button>
```

The gate is two-part:

1. `cloudEnabled` is true only when the meta tag has an allowed backend URL. Empty means local-only mode; there is no network request.
2. Cloud save, assignment board, watch requests, and `POST /api/export/challonge` require a successful `/api/me` session. Rendering a button is not authorization; the server still returns `401`/`403` when appropriate.

The frontend never calls Challonge directly. When authenticated, the current action can replace the placeholder alert with:

```js
async function pushToChallonge(tournamentId) {
  if (!cloudEnabled) {
    toast("Cloud features are not configured.");
    return;
  }
  try {
    const result = await apiFetch("/api/export/challonge", {
      method: "POST",
      body: JSON.stringify({ tournamentId })
    });
    window.open(result.challongeUrl, "_blank", "noopener");
  } catch (err) {
    toast(err.message);
  }
}
```

The same helper is used for cloud tournament calls. Local persistence remains immediate for offline resilience; when authenticated, the debounced persistence path additionally queues the conditional cloud save described in section 4. A failed cloud request must leave the local envelope dirty and visibly show an offline/unsynced indicator, not discard a score sheet.

For GitHub Pages, editing the meta tag is the deployment configuration. If the frontend later moves behind the same nginx host, the tag can use a relative base URL only after `backendPath` is updated to support it; do not silently interpret empty as same-origin, because that would break the deliberate local-only default. Keep the explicit absolute API URL for the current static-site topology.

**MVP decision:** Add one empty-by-default `kball-backend-url` meta tag, read it directly from `app.js`, and gate cloud save and Challonge proxy actions behind both configured HTTPS URL and `/api/me` authentication. Keep the frontend build-free and local-only when the tag is empty.
