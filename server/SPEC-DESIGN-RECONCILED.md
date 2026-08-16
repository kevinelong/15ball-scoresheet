# SPEC-DESIGN Reconciliation

## Environment (locked)

- The production host is Kevin's shared Alpine Linux VPS, administered with OpenRC and `doas`; it does not have systemd or `sudo`.
- nginx already terminates TLS and serves the static frontend at `https://codeonline.io/kball/`.
- The public API origin is the same site at `https://codeonline.io/kball/api/`; nginx proxies that prefix to the loopback-only Go listener at `127.0.0.1:8093`.
- The service is one Go process and one SQLite database on this VPS. It uses `modernc.org/sqlite`, builds with `CGO_ENABLED=0`, and runs with a dedicated unprivileged `kball` account.
- Runtime data is durable under `/var/lib/kball`; release binaries are immutable under `/opt/kball/releases`, with `/opt/kball/bin/kball-server` atomically updated to the selected release.
- This is one Columbia Cue Club deployment. Membership is allowlisted at the club level; there is no tenant selector or per-club credential UI.

## Two deploy blockers — resolved

### Service manager: OpenRC, not systemd

Ship `/etc/init.d/kball` as an OpenRC `openrc-run` service, patterned after the host's working `apid` and `huntd` services. It must start `/opt/kball/bin/kball-server` as `kball:kball`, load root-owned `/etc/kball/kball.env`, set `umask 0027`, use OpenRC's normal respawn/supervision mechanism, and declare `need net` plus `after nginx`. The init script's stop policy is `TERM/20/KILL/5`, which matches the application's 20-second graceful-shutdown deadline. Operators use `doas rc-service kball restart`, `doas rc-update add kball default`, and the existing OpenRC logging convention. This is the deployable equivalent of DESIGN.md's service hardening: the host has no systemd sandbox directives, while the existing OpenRC service pattern is known-good on this box.

### Frontend and API origin: same-origin `/kball/` and `/kball/api/`

Serve the frontend at `https://codeonline.io/kball/` and expose the API only at `https://codeonline.io/kball/api/`. nginx must use `location /kball/api/ { proxy_pass http://127.0.0.1:8093/api/; ... }`, so public `/kball/api/health` reaches backend `/api/health`; it must forward `Host`, `X-Real-IP`, `X-Forwarded-For`, and `X-Forwarded-Proto`, set `proxy_read_timeout 35s`, and disable buffering for the watch route. The frontend meta value is `/kball/api`, and `app.js` must support an explicit relative base URL while preserving empty as local-only. There is no CORS middleware. This matches the live host and removes the separate-origin/GitHub Pages premise that DESIGN.md currently assumes; same-origin cookies, CSRF header checks, and long polling then work without cross-origin credential complexity.

## 17 Decision items

### 1. Service manager

**Decision: Use an OpenRC `openrc-run` init script mirrored from `apid`/`huntd`; do not ship or invoke a systemd unit.** The service must fit Alpine, OpenRC, and `doas` as they exist on Kevin's VPS, and a systemd unit cannot be made operational there. The application retains the useful runtime properties from the current design—dedicated account, loopback bind, restart on failure, restrictive umask, orderly stop—but OpenRC owns process lifecycle and logs according to the host's established convention.

### 2. SQLite driver and build

**Decision: Lock the server to `modernc.org/sqlite` and release a static `linux/amd64` binary with `CGO_ENABLED=0`; do not use `mattn/go-sqlite3`.** This is mandatory for predictable builds and deployment on the Alpine musl host, while it preserves DESIGN.md's existing immediate-transaction, WAL, foreign-key, and busy-timeout strategy. The release workflow must run `go test ./...` and build with `CGO_ENABLED=0 GOOS=linux GOARCH=amd64`; no C compiler, libc compatibility layer, or runtime SQLite shared library is a production dependency.

### 3. Port, data directory, and backup

**Decision: Bind `LISTEN_ADDR=127.0.0.1:8093`, store the database at `/var/lib/kball/data.db`, and run a nightly SQLite `.backup` job retained for 30 days.** Port 8093 is reserved specifically for K-Ball and loopback binding keeps the service private behind nginx. Enable WAL, `foreign_keys`, and a 5-second busy timeout at startup; the backup job uses the `sqlite3` CLI's `.backup` command at 04:17 local time, writes `/var/lib/kball/backups/kball-YYYY-MM-DD.db`, prunes files older than 30 days, and periodically verifies a restored copy with `PRAGMA integrity_check`. Litestream is not part of MVP: an online SQLite backup is the smallest reliable operation for one database on this VPS.

### 4. Email transport

**Decision: Make SMTP the required mail transport and retain Postmark only as an optional implementation of the same sender interface.** The host already has working SMTP credentials and an SMTP-sending service, so magic links need no new vendor account or external dependency. Configure `EMAIL_TRANSPORT=smtp`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_FROM`, and explicit STARTTLS/implicit-TLS behavior; implement `type Mailer interface { SendMagicLink(context.Context, string, string) error }` so a future Postmark client is additive rather than architectural.

### 5. CSRF

**Decision: Require `X-CO: 1` on every authenticated state-changing `POST`, `PUT`, `PATCH`, and `DELETE`, in addition to a `SameSite=Lax` session cookie.** Same-origin deployment makes this exact header a low-friction, effective request-origin gate: the K-Ball JavaScript adds it automatically, while a cross-site HTML form cannot. The middleware must reject missing or nonexact values with `403 csrf_failed` before handler work, including tournament writes, table transitions, Challonge export, and signout; GET, HEAD, the magic-link landing GET, and the unauthenticated request-link POST are not in that authenticated-cookie class.

### 6. Cookie flags

**Decision: Issue the opaque session cookie with `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/kball/`, no `Domain`, and a `Max-Age` bounded by the database session expiry.** HTTPS is already terminated by nginx, same-origin paths are all under `/kball/`, and no subdomain needs the cookie. These flags prevent JavaScript access, prevent plain-HTTP transmission, constrain ambient cross-site sends, and avoid making the cookie available to unrelated paths or sibling hosts; the API must also send `Cache-Control: no-store` on auth responses.

### 7. Session revocation

**Decision: Use database-backed opaque sessions and revoke the exact session row on signout; do not use stateless signed session tokens.** A signed HMAC token cannot be invalidated before expiry, which directly contradicts a real signout requirement. Generate a random 32-byte session secret, put only the base64url value in the cookie, store its SHA-256 digest plus user ID, timestamps, expiry, and revocation metadata in SQLite, and authenticate only nonexpired, nonrevoked rows. Signout executes `UPDATE sessions SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL`, clears the cookie with the same Path, and immediately makes a copied cookie unusable.

### 8. Magic-link hardening

**Decision: Make every magic link a 256-bit, database-backed, single-use token and consume it only on an explicit confirmation POST from a landing page.** Email security scanners commonly prefetch GET links, so a GET must only render a no-store confirmation page and must never create a session or mark a token consumed. The page's explicit “Continue to K-Ball” action calls `POST /api/auth/confirm-link` with `X-CO: 1`; in one immediate transaction the server checks expiry and unused state, marks the link consumed, creates a session, and redirects to `/kball/`. Store a random selector and a SHA-256 token digest, use `crypto/rand`, compare a fetched digest with `subtle.ConstantTimeCompare`, and reject replay, expiry, or any failed comparison as the same invalid-link response.

### 9. Request-link rate limit

**Decision: Persist a limit of three request-link emails per normalized email address per rolling hour, ten per source IP per rolling hour, and twenty per email per rolling day.** Magic-link sending is an email-bomb and cost surface even for a small club, and in-memory counters would reset on every deploy. Record attempts in SQLite using a SHA-256 normalized-email key and a privacy-preserving source-IP key, count in indexed time windows before enqueueing mail, and return the same `202 Accepted` response whether the request is accepted, rate-limited, or the email is not allowlisted. Trust `X-Forwarded-For` only from the loopback nginx peer; otherwise use `RemoteAddr`.

### 10. Ownership on tournament writes

**Decision: `POST /api/tournaments` is create-only, and `PUT /api/tournaments/{id}` is conditional update authorized through the caller's club role; no endpoint overwrites an existing row merely because the client supplied its ID.** This removes the guessed-ID overwrite class entirely and matches DESIGN.md's conditional PUT migration model. Create assigns `owner_user_id` from the authenticated session, rejects an existing ID with `409`, and validates the implicit Columbia Cue Club scope; update/delete/table/export authorization is resolved from membership and role, never from a request body or client-provided owner field.

### 11. Body-size and tournament-count caps

**Decision: Limit each tournament create or update request to 256 KiB and cap each user at 100 tournaments they created.** A bounded JSON document is ample for a K-Ball bracket, score sheets, and offline envelope while preventing a single authenticated account from consuming the VPS disk or memory. Apply `http.MaxBytesReader` before JSON decoding, reject oversized or malformed payloads with `413`/`400`, enforce the creator count inside the same write transaction as create, and do not count shared club tournaments against a viewer or scorer. The database remains the backstop; clients must not be trusted to police these caps.

### 12. Secrets

**Decision: Keep only `CHALLONGE_API_KEY` and SMTP credentials as runtime secrets; eliminate `SESSION_SECRET` because sessions are opaque database records, and add no token-signing secret.** Magic-link and session values are generated with `crypto/rand` and retained only as hashes, so an HMAC signing key is neither needed nor useful. Store `/etc/kball/kball.env` as root-owned mode `0600`, load it through OpenRC, never serialize it in errors or logs, and treat `LISTEN_ADDR`, `DATABASE_PATH`, `BASE_URL`, `EMAIL_TRANSPORT`, and cookie settings as nonsecret configuration. If Postmark is later enabled, its server token is an alternative mail credential, not a browser-visible setting.

### 13. Challonge re-export idempotency

**Decision: Persist a resumable Challonge export record keyed by K-Ball tournament ID before the first external call, use a deterministic Challonge URL key, and update the existing Challonge tournament on every re-export.** A retry or double-click must never create a second remote tournament. The record stores a deterministic URL key such as `kball-<internal-id>`, `challonge_tournament_id`, URL, step status, last exported tournament timestamp, and last error; a partial first attempt resolves or creates by that URL key and resumes its incomplete participant/seed/score steps. A concurrent export returns `409 export_in_progress`, while a completed re-export diffs and updates the stored remote ID. This gives the multi-step remote workflow a durable recovery point rather than an orphan-producing best effort.

### 14. Health endpoint

**Decision: Add unauthenticated `GET /api/health`, publicly available as `GET /kball/api/health`, returning `200 {"status":"ok"}` only after `SELECT 1` against SQLite succeeds.** OpenRC operations and host monitoring need a cheap liveness/readiness check, and it must test the dependency that makes the service useful. Set `Cache-Control: no-store`; return `503 {"status":"degraded"}` if the database check fails, without exposing configuration, paths, credentials, or internal errors.

### 15. Graceful shutdown

**Decision: On `SIGTERM` or `SIGINT`, stop accepting work, cancel long-poll waits, drain HTTP requests for up to 20 seconds, close SQLite, then exit.** OpenRC restarts must not interrupt a committed-or-rolled-back write in an uncontrolled way, and the long-poll endpoint otherwise holds connections for up to 30 seconds. Wire `signal.NotifyContext`, use the resulting root context as `http.Server.BaseContext`, call its cancel function on signal so watch handlers wake, then call `server.Shutdown` with a 20-second context and `db.Close()` only after shutdown returns; the OpenRC `TERM/20/KILL/5` policy is aligned with that deadline.

### 16. Sharing model

**Decision: Make every tournament visible to all allowlisted Columbia Cue Club members now, with organization roles `admin`, `director`, `scorer`, and `viewer`; do not keep creator-private tournaments.** The product explicitly calls for club-member sharing, and adding correct membership authorization after per-owner routes are implemented would force a broad retrofit. Seed the fixed organization, add `organization_memberships` immediately, permit all active members to list/read club tournaments, grant directors and admins tournament setup, table control, export, and destructive actions, grant scorers score and assigned-table mutations, and keep `owner_user_id` as an audit/creator field rather than the only authorization rule. There is no organization selector and no per-tournament sharing UI in MVP.

### 17. Frontend integration

**Decision: Completing the implementation includes the frontend work: sign-in, magic-link confirmation, cloud save, table board, long polling, signout, and Challonge export wired into `app.js` for the live same-origin deployment.** The current frontend has no backend calls, so a server-only delivery cannot provide the designed product. Set `<meta name="kball-backend-url" content="/kball/api">`, make the API helper accept that explicit relative base, add `credentials: "include"` and `X-CO: 1` on unsafe requests, and keep an empty meta value as the explicit local-only mode for downloaded/offline copies. No CORS headers are configured because the deployed frontend and API share `codeonline.io` and the `/kball/` site boundary.

## Security/correctness items missing from DESIGN.md

### CSRF enforcement (#5)

Add a router middleware immediately after request-ID/recovery middleware and before every authenticated mutation handler:

```go
func requireCSRF(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        switch r.Method {
        case http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
            if r.Header.Get("X-CO") != "1" {
                writeError(w, http.StatusForbidden, "csrf_failed", "CSRF validation failed")
                return
            }
        }
        next.ServeHTTP(w, r)
    })
}
```

Mount request-link and confirm-link before this middleware only if they are not session-authenticated; the confirmation page itself sends the header. This makes all cookie-authenticated writes fail closed and keeps the control consistent with the other services on the box.

### Cookie construction (#6)

Create one cookie helper so callback, refresh, and signout cannot drift:

```go
func sessionCookie(value string, maxAge int) *http.Cookie {
    return &http.Cookie{
        Name: "kball_session", Value: value, Path: "/kball/", MaxAge: maxAge,
        Secure: true, HttpOnly: true, SameSite: http.SameSiteLaxMode,
    }
}
```

Do not set `Domain`; clear the cookie with the identical name and Path plus `MaxAge: -1`. Session expiry is authoritative in SQLite even if a stale cookie remains in a browser.

### Opaque sessions and revocation (#7)

Add a migration for a hashed opaque-session table and index active lookups:

```sql
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash BLOB NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER,
    last_seen_at INTEGER,
    user_agent_hash BLOB,
    ip_hash BLOB
);
CREATE INDEX sessions_active_by_token
    ON sessions(token_hash, expires_at) WHERE revoked_at IS NULL;
```

Generate `token := make([]byte, 32)` with `crypto/rand.Read`, encode it with `base64.RawURLEncoding`, and store `sha256.Sum256(token)`. Authentication performs a prepared `SELECT` for an unrevoked, unexpired hash; signout revokes it in SQLite before returning the expired cookie. Session rotation creates a new row and revokes the old one in the same transaction.

### Single-use magic links and scanner-safe confirmation (#8)

Use a selector-plus-secret schema so the secret comparison is explicitly constant-time and never stored in cleartext:

```sql
CREATE TABLE magic_links (
    id TEXT PRIMARY KEY,
    selector BLOB NOT NULL UNIQUE,
    token_hash BLOB NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    requested_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    consumed_at INTEGER,
    requested_ip_hash BLOB
);
CREATE INDEX magic_links_pending_by_selector
    ON magic_links(selector, expires_at) WHERE consumed_at IS NULL;
```

Generate a 16-byte selector and a separate 32-byte `crypto/rand` token. `GET /api/auth/verify` parses the pair and renders a no-store confirmation document; it does not mutate the table. `POST /api/auth/confirm-link` loads the row by selector, computes `candidate := sha256.Sum256(rawToken)`, runs `subtle.ConstantTimeCompare(storedHash, candidate[:])`, and within `BEGIN IMMEDIATE` updates `consumed_at` only where it is still NULL and unexpired, then creates the session. Require exactly one affected row; all failures produce the same invalid/expired message.

### Request-link rate limiting (#9)

Persist rate-limit events rather than holding counters in process memory:

```sql
CREATE TABLE auth_link_requests (
    id TEXT PRIMARY KEY,
    email_hash BLOB NOT NULL,
    ip_hash BLOB NOT NULL,
    requested_at INTEGER NOT NULL
);
CREATE INDEX auth_link_requests_by_email_time ON auth_link_requests(email_hash, requested_at);
CREATE INDEX auth_link_requests_by_ip_time ON auth_link_requests(ip_hash, requested_at);
```

Normalize with lower-case trimmed email before hashing. In one transaction, count the email's last hour and day plus the IP's last hour, insert only if all limits are satisfied, then send mail after commit. Return generic `202` in every outcome, prune old events daily, and configure nginx/backend trust so only a loopback peer can supply the forwarded client IP.

### Tournament write authorization (#10)

Make create and update separate prepared-statement paths. `POST /api/tournaments` inserts a new row only after authorization; an existing ID is a `409 tournament_exists`. `PUT /api/tournaments/{id}` requires the request's `base_updated_at` and an active organization membership with a role allowed to edit; all fetch/update/delete queries include the fixed `organization_id`, and `owner_user_id` is never accepted from JSON. This removes client-selected-ID overwrites and binds every mutation to the authenticated club principal.

### Tournament write quotas (#11)

Wrap each create/update body with `http.MaxBytesReader(w, r.Body, 256<<10)` before `json.Decoder.Decode`, reject trailing JSON, and enforce the same 256 KiB cap on the tournament payload itself. On create, perform a transactional `COUNT(*)` of creator-owned tournaments and reject the request after 100 rows; shared club tournaments do not consume a viewer or scorer quota. Enforce both limits in the server, before a JSON document is accepted or a SQLite row is inserted.

### Secret handling (#12)

Use `/etc/kball/kball.env`, owned by `root:root` and mode `0600`, as the only secret source. The OpenRC script reads it before dropping the child to `kball`; logs redact values by key and never log request Authorization/Cookie headers, magic URLs, raw email addresses, SMTP credentials, or the Challonge key. Required secrets are `CHALLONGE_API_KEY` and the configured SMTP password; use opaque session and magic-link records so `SESSION_SECRET` and a token-signing key are deliberately absent.

### Idempotent Challonge export (#13)

Add export state before adding any remote object:

```sql
CREATE TABLE challonge_exports (
    tournament_id TEXT PRIMARY KEY REFERENCES tournaments(id) ON DELETE CASCADE,
    url_key TEXT NOT NULL UNIQUE,
    challonge_tournament_id TEXT,
    challonge_url TEXT,
    status TEXT NOT NULL CHECK (status IN ('creating','syncing','complete','failed')),
    exported_updated_at INTEGER,
    steps_json TEXT NOT NULL DEFAULT '{}',
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE TABLE challonge_export_participants (
    tournament_id TEXT NOT NULL REFERENCES challonge_exports(tournament_id) ON DELETE CASCADE,
    participant_id TEXT NOT NULL,
    challonge_participant_id TEXT NOT NULL,
    PRIMARY KEY (tournament_id, participant_id)
);
```

Insert the `creating` row and deterministic `url_key` in SQLite before the first Challonge POST. A worker/request first resolves the key remotely if the row lacks a remote ID, creates only if absent, persists the remote ID immediately, then records each participant/seed/score step after that step succeeds. Re-export acquires the row transactionally, rejects concurrent work with `409`, diffs current K-Ball state using the participant map, and PUTs the stored remote tournament rather than creating another one. Failed work remains resumable with `status='failed'` and its step markers.

### Health check (#14)

Register `GET /api/health` before authenticated routing. It uses `context.WithTimeout(r.Context(), time.Second)` and `db.QueryRowContext(ctx, "SELECT 1").Scan(&one)`; successful checks return `200` and no-cache JSON, failures return `503` and a generic degraded status. nginx exposes it only through the same public API prefix as every other route: `/kball/api/health`.

### Graceful shutdown (#15)

Construct the server around a cancelable root context and a bounded shutdown sequence:

```go
root, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
defer stop()

srv := &http.Server{
    Addr: cfg.ListenAddr,
    Handler: router,
    BaseContext: func(net.Listener) context.Context { return root },
    ReadHeaderTimeout: 5 * time.Second,
    IdleTimeout: 60 * time.Second,
}

go func() { _ = srv.ListenAndServe() }()
<-root.Done()
ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
defer cancel()
_ = srv.Shutdown(ctx)
_ = db.Close()
```

Watch handlers must select on `r.Context().Done()` and the hub wake mechanism so the cancelled BaseContext ends their wait promptly. `Shutdown` completes in-flight handlers before `db.Close`, while SQLite's transaction semantics ensure any forced termination is still atomic rather than a partially written database.

## DESIGN.md delta

- [ ] **Top reconciliation banner (lines 1–23):** replace the warning with a pointer to this accepted reconciliation, or remove it once the rewrites below are made. It must no longer present systemd and a separate API origin as pending assumptions.
- [ ] **Section 1, “SQLite schema”:** retain tables/assignments, add the session, magic-link, request-link rate-limit, and Challonge export migrations from this document. Add `organization_memberships` now, not as a deferred option, and ensure every durable query uses the fixed organization scope.
- [ ] **Section 1, “Endpoint contracts”:** state that all unsafe authenticated routes require `X-CO: 1`; change tournament create to create-only and describe membership/role authorization instead of owner-only authorization. Add size/count validation and explicit `409 tournament_exists`, `403 csrf_failed`, and quota errors.
- [ ] **Section 2, “Multi-tenant scoping”:** keep the single implicit Columbia Cue Club organization, but replace the deferred-sharing posture with allowlisted organization membership now. Define roles and their read/mutate/export/table permissions; preserve `owner_user_id` only for audit and creator quotas.
- [ ] **Section 3 opening and “Filesystem and account layout”:** replace Ubuntu/systemd/sudo with Alpine/OpenRC/doas. Keep the dedicated `kball` account, `/opt/kball` release layout, and `/var/lib/kball` database, but move secrets to `/etc/kball/kball.env` mode `0600` and set `LISTEN_ADDR=127.0.0.1:8093`.
- [ ] **Section 3, “systemd unit”:** replace the entire unit and all `systemctl` commands with an `openrc-run` init script modeled on `apid`/`huntd`, including restart supervision and `TERM/20/KILL/5`. Do not claim systemd isolation controls are available on Alpine.
- [ ] **Section 3, “nginx and Certbot”:** replace the standalone `tournaments.columbiacueclub.com` server block and CORS discussion with the existing `codeonline.io` server's `/kball/api/` location proxying to `127.0.0.1:8093/api/`. Specify the 35-second long-poll timeout, no buffering for watch, and no CORS middleware.
- [ ] **Section 3, “SQLite backup,” “CI/CD sketch,” and operator workflow:** retain online `.backup`, but make the scheduled Alpine/OpenRC-compatible job use the locked data directory and 30-day retention; replace `sudo`/`systemctl` examples with `doas`/`rc-service`; retain the pure-Go static release build and verified manual release pull.
- [ ] **New Section 3 subsection, “Authentication, email, and request abuse”:** add SMTP-first mailer configuration, opaque database sessions with true revocation, scanner-safe single-use magic links, the exact rate limits, cookie construction, no-store auth responses, and secret redaction rules.
- [ ] **New Section 3 subsection, “Challonge export state”:** add durable export intent, deterministic remote URL key, participant mapping, resumable step state, serialized export handling, and update-on-re-export behavior. The current create-only wording is insufficient.
- [ ] **New Section 3 subsection, “Health and lifecycle”:** add backend `/api/health` (public `/kball/api/health`) and the SIGTERM/SIGINT shutdown sequence, including cancellation of long polls before database close.
- [ ] **Section 4, “Client↔server migration path”:** keep server-authoritative conditional PUT and LWW, but revise authorization language from per-owner to organization-role access and require the 256 KiB request cap. Client-side cloud API calls must use the same-origin relative base.
- [ ] **Section 5, “Realtime multi-scorer sync”:** keep long polling and post-commit notifications, but make watch handlers responsive to root-context cancellation during graceful shutdown. Retain the 30-second server wait and require nginx to exceed it with 35 seconds.
- [ ] **Section 6, “Frontend build integration”:** replace the GitHub Pages/absolute API URL flow with `<meta name="kball-backend-url" content="/kball/api">`, make `backendPath` support that explicit relative base, and add concrete sign-in, confirmation, signout, cloud-save, table-board, watch, and export wiring. Every unsafe `apiFetch` request must include `X-CO: 1`; an empty meta value remains deliberately local-only.
