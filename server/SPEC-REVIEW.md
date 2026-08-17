# Backend spec review — questions for the implementing agent

Review of `server/README.md` from the **ops/deploy side** (the agent that will
build + host this on the target VPS). The spec is ~80% there; below are the gaps
worth closing **before** the Go is written, since they're cheap in the spec and
expensive to retrofit.

**How to use this doc:** answer each item inline under **Decision:** (edit this
file and commit). Anything left blank, the deploy agent will pick a sane default
and note it. Items marked 🔴 change the schema or security model — please decide
these first.

---

## Deployment reality (the target box is NOT what the spec assumes)

The spec says Ubuntu 22.04 / systemd / sudo / port 8080. **The actual host is
Alpine Linux (musl) + OpenRC + doas**, a shared box already fronting several
sites behind one nginx. Implications:

1. **Service manager.** `deploy/fifteenball.service` (systemd) won't run here — the
   deploy agent will ship an **OpenRC** init instead (like the box's existing
   `apid`/`huntd` services). Treat the systemd unit as illustrative only.
   **Decision (any constraint from your side?):**

2. **SQLite driver stays pure-Go** (`modernc.org/sqlite`) and build with
   `CGO_ENABLED=0`. Critical on musl — a CGo driver would not build cleanly.
   Please confirm you won't switch to `mattn/go-sqlite3`.
   **Decision:**

3. **Port + data dir.** `127.0.0.1:8093` is reserved on the box (8080 is taken
   context-wise); keep `LISTEN_ADDR` env-driven. Where should `data.db` live and
   **what's the backup plan** (SQLite is one file — nightly `.backup` or
   litestream)? Tournament data is the whole point of the backend.
   **Decision:**

4. **Email transport.** The box already sends mail via **SMTP** (an existing
   service uses nodemailer with SMTP creds on-box). Can we make **SMTP the
   first-class path and Postmark optional**, so we don't need a new Postmark
   account just for magic links?
   **Decision:**

---

## Security must-haves the spec currently omits

5. **CSRF.** Cookie session + state-changing POSTs (create tournament, export,
   signout) are CSRF-able. Plan: `SameSite=Lax`/`Strict` **plus** a custom-header
   check (the box's other API uses an `X-CO: 1` header for this — mirror it)?
   **Decision:**

6. **Full cookie flags.** Spec lists only `HttpOnly`. Also set **`Secure`** +
   **`SameSite`**. Confirm.
   **Decision:**

7. 🔴 **Real session revocation.** If sessions are stateless signed HMAC tokens,
   `signout` can't truly invalidate them. Store sessions in-DB (or a per-user
   token version) so signout/rotation actually revokes?
   **Decision:**

8. **Magic-link hardening.** Make tokens **single-use** (consumed on verify, not
   just 15-min expiry), `crypto/rand` ≥128-bit, constant-time compare. Also: email
   security scanners (Outlook SafeLinks, etc.) **pre-fetch the verify GET and burn
   the token** — mitigate with a landing page + explicit POST-to-confirm, or
   accept + document? Which?
   **Decision:**

9. **Rate-limit `/api/auth/request-link`.** It sends email on demand →
   email-bomb / cost vector. Add per-email + per-IP caps?
   **Decision:**

10. 🔴 **Ownership enforced on overwrite.** `POST /api/tournaments` "create or
    overwrite by client-supplied id" must verify the caller owns that id first,
    else one user can overwrite another's by guessing an id. Confirm the check.
    **Decision:**

11. **Body-size + per-user count caps** on the tournament-save endpoint (e.g.
    256 KB/tournament, N/user) to prevent disk-fill. Pick limits.
    **Decision:**

12. **Secrets.** `.env` gitignored (✓); deploy agent will also `chmod 600` and
    ensure secrets are never logged. Any additional secret beyond
    `SESSION_SECRET` / `CHALLONGE_API_KEY` / email creds?
    **Decision:**

---

## Correctness — the Challonge export is the fragile part

13. 🔴 **Idempotent re-export.** Export is multi-step against Challonge (create →
    add participants → seed → score). As written ("Creates the tournament"), a
    retry/double-click makes **duplicate Challonge tournaments**. Proposed: store
    `challongeId/Url` on first export and **update** on re-export; define
    partial-failure behavior (created-but-participants-failed = resumable, not
    orphaned). Agree?
    **Decision:**

14. **`GET /api/health`** (200) — every other service on the box has one; the
    OpenRC unit + monitoring want it. Add it?
    **Decision:**

15. **Graceful shutdown** (signal → drain + close DB) so deploy restarts don't
    corrupt in-flight writes. Confirm.
    **Decision:**

---

## Product decision that contradicts the current API

16. 🔴 **Sharing model.** The "why" says *share brackets between devices **or club
    members***, but every endpoint is strictly per-owner ("tournaments the caller
    owns"). Which is it:
    - (a) private to creator only, or
    - (b) visible to all allowlisted club members (maybe with an admin who sees
      all)?
    This changes the schema + auth checks; retrofitting sharing later is painful.
    **Decision:**

---

## The other half nobody's built yet

17. **Frontend integration is unbuilt.** The current frontend has **zero backend
    calls** (no `fetch`, no API base). The spec's "buttons light up" assumes a
    sign-in UI + cloud-save + push-to-Challonge wiring in `app.js` that doesn't
    exist. Does "complete the implementation" include that client work, or is it a
    separate task?
    **Note:** the deploy agent is serving frontend + API **same-origin** at
    `codeonline.io/15ball/` + `/15ball/api/` (preview host), so integration needs no
    CORS. If it later moves to `tournaments.columbiacueclub.com`, cookie auth then
    needs explicit CORS with `Allow-Credentials` + an origin allowlist (not `*`).
    **Decision:**

---

## Status from the deploy side (already done)

- Static frontend is **live for preview**: `https://codeonline.io/15ball/`
  (served from a clone; `git pull` updates it). Runs fully standalone today.
- Go toolchain installed on the host; port `8093` reserved; `/15ball/api/` proxy
  slot pre-planned (same-origin, no CORS).
- Ready to build + deploy the moment `server/*.go` is pushed. Reply here with the
  decisions above and the deploy agent will wire OpenRC + nginx and verify.
