# 04 — API contracts (v1)

See also: [02-role-permission-matrix.md](./02-role-permission-matrix.md), [03-state-machines.md](./03-state-machines.md), [06-realtime-contract.md](./06-realtime-contract.md), [07-challonge-sync-contract.md](./07-challonge-sync-contract.md).

Base path: `/api/v1` (served behind `/15ball/api/v1`).

## Conventions

- **Auth:** session cookie + role checks.
- **Mutations:** require CSRF header per backend security policy.
- **Errors:** `{ "error": { "code": "...", "message": "...", "details": {...} } }`.
- **Pagination:** cursor-based (`limit`, `cursor`); response includes `nextCursor`.
- **Idempotency:** endpoints listed below with idempotency key support require `Idempotency-Key` header.

## Auth and identity

| Method | Path | Auth | Request | Success | Errors | Idempotency |
|---|---|---|---|---|---|---|
| POST | `/auth/request-link` | public | `{email}` | `202` | `400 invalid_email` | not required |
| GET | `/auth/verify` | public | query `token` | `200` confirmation page payload | `400 invalid_or_expired` | n/a |
| POST | `/auth/confirm-link` | public | `{token}` | `200 {user,roles}` + cookie | `400 invalid_or_expired` `429 rate_limited` | token is single-use by design |
| POST | `/auth/signout` | authenticated | none | `204` | `401` | safe repeat |
| GET | `/me` | authenticated | none | `200 {userId,email,roles,pending}` | `401` | n/a |

## Tournaments and divisions

| Method | Path | Auth | Request | Success | Errors | Idempotency |
|---|---|---|---|---|---|---|
| GET | `/tournaments` | authenticated | `limit,cursor,state` | `200 {items,nextCursor}` | `401` | n/a |
| POST | `/tournaments` | director+ | tournament payload | `201 {tournament}` | `400` `403` `409 duplicate_slug` | optional (`Idempotency-Key`) |
| GET | `/tournaments/{id}` | authenticated | none | `200 {tournament,divisions}` | `403` `404` | n/a |
| PATCH | `/tournaments/{id}` | director+ | partial editable fields | `200 {tournament}` | `400` `403` `404` `409 invalid_transition` | optional |
| POST | `/tournaments/{id}/archive` | director+ | `{reason?}` | `200 {tournament}` | `403` `404` `409 already_archived` | optional |
| GET | `/tournaments/{id}/divisions` | authenticated | pagination | `200` | `403` `404` | n/a |
| POST | `/tournaments/{id}/divisions` | director+ | division payload | `201` | `400` `403` `404` | optional |

## Entrants and check-in

| Method | Path | Auth | Request | Success | Errors | Idempotency |
|---|---|---|---|---|---|---|
| GET | `/tournaments/{id}/entrants` | authenticated | `limit,cursor,state,archived` | `200 {items,nextCursor}` | `403` `404` | n/a |
| POST | `/tournaments/{id}/entrants` | director+ | entrant payload | `201 {entrant}` | `400` `403` `404` `409 duplicate_display_name` | optional |
| PATCH | `/tournaments/{id}/entrants/{entrantId}` | director+ | editable fields/state | `200 {entrant}` | `400` `403` `404` `409 invalid_transition` | optional |
| POST | `/tournaments/{id}/entrants/{entrantId}/check-in` | director+ | `{checkedIn:true}` | `200 {entrant}` | `403` `404` `409 invalid_transition` | safe repeat |
| POST | `/tournaments/{id}/entrants/{entrantId}/archive` | director+ | `{reason?}` | `200` | `403` `404` | safe repeat |

## Matches and scoring

| Method | Path | Auth | Request | Success | Errors | Idempotency |
|---|---|---|---|---|---|---|
| GET | `/tournaments/{id}/matches` | authenticated | pagination + filters | `200 {items,nextCursor}` | `403` `404` | n/a |
| POST | `/tournaments/{id}/matches/{matchId}/assign` | director+ | `{scorekeeperUserId,tableRef?}` | `200 {match}` | `400` `403` `404` `409 invalid_transition` | optional |
| POST | `/tournaments/{id}/matches/{matchId}/start` | assigned scorekeeper or director+ | `{expectedVersion}` | `200 {match}` | `400` `403` `404` `409` | optional |
| POST | `/tournaments/{id}/matches/{matchId}/result` | assigned scorekeeper or director+ | `{winnerEntrantId,loserEntrantId,score,...}` | `200 {match,resultVersion}` | `400` `403` `404` `409 invalid_transition` | **required** |
| POST | `/tournaments/{id}/matches/{matchId}/reopen` | director+ | `{reason}` | `200 {match}` | `400 reason_required` `403` `404` `409` | **required** |
| GET | `/tournaments/{id}/matches/{matchId}/history` | authenticated | none | `200 {versions,audit}` | `403` `404` | n/a |

## Realtime and public data

| Method | Path | Auth | Request | Success | Errors | Idempotency |
|---|---|---|---|---|---|---|
| GET | `/tournaments/{id}/events` | authenticated/public by tournament visibility | SSE stream (`Last-Event-ID` supported) | `200 text/event-stream` | `403` `404` | n/a |
| GET | `/tournaments/{id}/snapshot` | authenticated/public by visibility | none | `200 {snapshot}` | `403` `404` | n/a |
| GET | `/public/tournaments/{id}` | public | none | `200 public view` | `404` | n/a |
| GET | `/public/tournaments/{id}/overlay` | public | none | `200 normalized OBS state` | `404` | n/a |

## Challonge sync

| Method | Path | Auth | Request | Success | Errors | Idempotency |
|---|---|---|---|---|---|---|
| POST | `/tournaments/{id}/challonge/sync` | director+ | `{mode:"full"|"incremental"}` | `202 {jobId,status}` | `403` `404` `409 sync_in_progress` | **required** |
| GET | `/tournaments/{id}/challonge/sync` | authenticated | none | `200 {status,lastSuccess,lastError,mappingVersion}` | `403` `404` | n/a |
| POST | `/tournaments/{id}/challonge/reconcile` | director+ | `{dryRun?:boolean}` | `200 {differences,actions}` | `403` `404` | optional |

## Audit

| Method | Path | Auth | Request | Success | Errors |
|---|---|---|---|---|---|
| GET | `/tournaments/{id}/audit` | director+ | pagination + filters | `200 {items,nextCursor}` | `403` `404` |
