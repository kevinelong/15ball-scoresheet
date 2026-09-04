# 06 — Realtime contract (SSE + snapshot + OBS normalization)

See also: [04-api-contracts.md](./04-api-contracts.md), [07-challonge-sync-contract.md](./07-challonge-sync-contract.md), [08-ui-workflows.md](./08-ui-workflows.md).

## Transport selection

- v1 realtime transport is **Server-Sent Events (SSE)** for public/OBS/read-heavy updates.
- REST endpoints handle all mutations.

## SSE stream endpoint

- `GET /api/v1/tournaments/{id}/events`
- Headers:
  - `Accept: text/event-stream`
  - `Last-Event-ID` optional
- Response headers:
  - `Content-Type: text/event-stream`
  - `Cache-Control: no-store`
  - `X-Accel-Buffering: no`

## Canonical event envelope

Each event `data:` JSON is:

```json
{
  "eventId": "evt_0000001245",
  "eventType": "match.updated",
  "tournamentId": "t_abc123",
  "occurredAt": "2026-09-04T18:00:00Z",
  "aggregate": {"type": "match", "id": "m_42", "version": 7},
  "actor": {"userId": "u_9", "role": "scorekeeper"},
  "sequence": 1245,
  "patch": {"state": "completed"},
  "snapshotVersion": 331,
  "auditId": "aud_77"
}
```

## Event types (v1)

- `tournament.updated`
- `division.updated`
- `entrant.updated`
- `match.updated`
- `match.result_submitted`
- `match.reopened`
- `challonge.sync_updated`
- `audit.appended`

## Reconnect and snapshot behavior

1. On connect, server sends `event: hello` with current `snapshotVersion` and latest `sequence`.
2. If `Last-Event-ID` is missing or too old (outside retained event window), server sends `event: snapshot_required`.
3. Client then calls `GET /api/v1/tournaments/{id}/snapshot` and resumes SSE with returned `latestEventId`.
4. If `Last-Event-ID` is valid, server replays missed events in order, then streams live events.
5. Heartbeat comment every 15s: `: keepalive`.

## Snapshot payload (normalized)

`GET /api/v1/tournaments/{id}/snapshot` returns:

```json
{
  "tournament": {"id":"t_abc123","state":"in_progress","version":331},
  "divisions": [],
  "entrants": [],
  "matches": [],
  "overlay": {
    "raceTo": 100,
    "rackNumber": 6,
    "players": [
      {"entrantId":"e_1","name":"Player A","runningBalls":4,"racks":2,"fouls":1,"serving":true},
      {"entrantId":"e_2","name":"Player B","runningBalls":3,"racks":1,"fouls":0,"serving":false}
    ],
    "status": "in_progress",
    "updatedAt": "2026-09-04T18:00:00Z"
  },
  "latestEventId": "evt_0000001245"
}
```

## OBS overlay state contract

- Overlay state is read-only and normalized under `snapshot.overlay`.
- Field names are stable and transport-independent (SSE now; future transport can reuse shape).
- Null/unknown values are explicit (`null`), never omitted if field is part of schema.
