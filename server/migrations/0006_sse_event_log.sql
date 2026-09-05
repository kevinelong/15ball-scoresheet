-- 0006 — SSE event log (Slice F). Append-only ordered event stream per tournament
-- for the live SSE endpoint + OBS overlay (06-realtime-contract, 05-schema #14).
-- event_id is a monotonic integer used as the SSE Last-Event-ID cursor.
CREATE TABLE sse_event_log (
    event_id      INTEGER PRIMARY KEY AUTOINCREMENT,
    tournament_id TEXT NOT NULL,
    event_type    TEXT NOT NULL,
    event_version INTEGER NOT NULL DEFAULT 1,
    payload_json  TEXT NOT NULL DEFAULT '{}',
    created_at    INTEGER NOT NULL
);
CREATE INDEX sse_event_log_by_tournament ON sse_event_log(tournament_id, event_id);
