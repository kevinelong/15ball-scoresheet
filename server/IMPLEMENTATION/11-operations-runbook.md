# 11 — Operations runbook (v1)

See also: [00-delivery-roadmap.md](./00-delivery-roadmap.md), [06-realtime-contract.md](./06-realtime-contract.md), [07-challonge-sync-contract.md](./07-challonge-sync-contract.md).

## Pre-deploy checks

1. Migrations run cleanly on a copy of production DB.
2. Acceptance test pack for touched slices passes.
3. Config sanity: bootstrap allowlist, role defaults, provider credentials present.
4. SSE endpoint smoke-check on staging/local (`hello`, heartbeat, reconnect).

## Deploy checks

1. Service health endpoint returns `200`.
2. Pending outbox jobs not stuck in unbounded retry loops.
3. No migration errors in logs.
4. Public snapshot/overlay endpoints return schema-valid payloads.

## SMS match-ready alerts (Twilio)

Match-ready SMS is **off until Twilio is configured**. Set these in the root-owned
env file (`/etc/fifteenball/fifteenball.env`, chmod 600 — never commit secrets):

```
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=<from console.twilio.com>
TWILIO_FROM_NUMBER=+1XXXXXXXXXX        # a Twilio-owned SMS number
# TWILIO_API_BASE optional (tests only; defaults to https://api.twilio.com)
```

On start the log prints either `notify: Twilio SMS enabled (from …)` or
`notify: SMS not configured …`. Behaviour:

- A player is texted only if their entrant has a `phone` **and** `notifyOptIn=true`
  (consent). Set both via entrant create/patch.
- An alert is enqueued when a match is **assigned to a table** (`tableRef` present).
  Enqueue is idempotent per (match, entrant) — re-assigning does not re-text.
- Delivery uses the `notifications` outbox with retry/backoff; permanent Twilio 4xx
  (bad number, unsubscribed, insufficient funds) dead-letters. Alert on
  `SELECT COUNT(*) FROM notifications WHERE status='dead_lettered'` > 0.

## Backups and recovery

- Keep scheduled SQLite `.backup` snapshots (per existing backend ops policy).
- Before schema migrations: force an immediate backup.
- Recovery drill:
  1. restore backup copy,
  2. run integrity checks,
  3. replay/requeue safe pending outbox jobs,
  4. verify audit continuity and tournament counts.

## Logging and observability

- Structured logs include request id, actor, endpoint, status, latency.
- Never log secrets, raw auth tokens, or magic-link material.
- Record sync failures with deterministic error codes and job IDs.
- Alert when:
  - outbox dead-letter count > 0,
  - SSE disconnect/error rate exceeds threshold,
  - health endpoint degraded.

## Incident procedures

### Incorrect completed match result

1. Director/admin reopens match with reason.
2. Scorekeeper or director submits corrected result.
3. Confirm new immutable `match_results` version and audit rows.
4. Trigger explicit Challonge sync if external view must be corrected.

### Challonge provider outage

1. Keep local operations running (local system remains authoritative).
2. Outbox retries with backoff.
3. Communicate delayed external sync status.
4. Reconcile after provider recovery.

## Change-management rules

- Any behavior change requires updates to:
  - relevant contract doc(s) under `server/IMPLEMENTATION/`, and
  - acceptance tests in [09-acceptance-tests.md](./09-acceptance-tests.md).
