# DECISION 020 — Hot-load creds from the env file (0640 root:fifteenball)

**Status:** Agreed & shipped 2026-09-05 (Kevin approved the permission change).

## Problem

The service reads config (incl. `TWILIO_*`) once at startup from its process
environment, which OpenRC's `start_pre` sources from
`/etc/fifteenball/fifteenball.env` as root before dropping to the unprivileged
`fifteenball` user. Adding new creds therefore required a service restart, and the
running process could not read the file itself: it was `0600 root:root`, so the
`fifteenball` user got `permission denied`.

## Decision

Let the running service read the env file at runtime so creds added after boot
take effect **without a restart**:

1. The env file is relaxed to **`0640 root:fifteenball`** — readable (not writable)
   by the service group. `start_pre` still sources it as root; nothing else changes.
2. The SMS worker is **always started**. Twilio creds are resolved lazily
   (`makeSMSResolver`): process env first, then `config.ParseEnvFile` re-reads the
   file. Until all three creds are present the worker no-ops and leaves jobs
   pending; once present it builds the sender, logs `Twilio SMS enabled`, and drains.
3. Match-ready enqueue is gated by `API.SMSReady()` (evaluated per request), so
   alerts start queuing the moment creds appear — no restart, no dropped jobs.

## Why this is an acceptable exposure

A compromised app process can already read every one of these secrets from its own
environment (`/proc/self/environ`) — they are injected at boot. `0600` only guarded
against *other non-root users* on the box. Widening to `0640 root:fifteenball`
exposes the file at rest to the dedicated service account only (not world, not other
service users). The marginal risk is small and bounded to the `fifteenball` account.

## Invariants / gotchas

- The file MUST remain `0640 root:fifteenball` for hot-load to work. If an edit
  resets it to `0600`, the running process silently loses the ability to pick up
  new creds (restart still works). Re-apply: `chown root:fifteenball` + `chmod 640`.
- Still never world-readable; still gitignored; secrets never committed.
- `FIFTEENBALL_ENV_FILE` overrides the path (tests / non-standard installs).
