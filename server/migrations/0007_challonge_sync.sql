-- 0007 — Challonge sync: mapping tables + outbox (Slice G). Contracts 05/07.
-- Local records are canonical; Challonge is eventually-consistent via the outbox.

CREATE TABLE challonge_tournaments (
    tournament_id           TEXT PRIMARY KEY REFERENCES tournaments(id) ON DELETE CASCADE,
    provider_tournament_id  TEXT UNIQUE,
    provider_url            TEXT,
    sync_state              TEXT NOT NULL DEFAULT 'not_synced'
                            CHECK (sync_state IN ('not_synced','in_progress','synced','failed')),
    last_synced_at          INTEGER,
    last_error              TEXT,
    last_provider_hash      TEXT,
    created_at              INTEGER NOT NULL,
    updated_at              INTEGER NOT NULL
);

CREATE TABLE challonge_participant_map (
    tournament_id          TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    entrant_id             TEXT NOT NULL,
    provider_participant_id TEXT NOT NULL,
    PRIMARY KEY (tournament_id, entrant_id),
    UNIQUE (tournament_id, provider_participant_id)
);

CREATE TABLE challonge_match_map (
    tournament_id     TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    match_id          TEXT NOT NULL,
    provider_match_id TEXT NOT NULL,
    PRIMARY KEY (tournament_id, match_id),
    UNIQUE (tournament_id, provider_match_id)
);

-- Transactional outbox for outbound Challonge work.
CREATE TABLE outbox_jobs (
    id              TEXT PRIMARY KEY,
    kind            TEXT NOT NULL,
    aggregate_type  TEXT NOT NULL,
    aggregate_id    TEXT NOT NULL,   -- tournament id
    payload_json    TEXT NOT NULL DEFAULT '{}',
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','processing','completed','dead_lettered')),
    attempts        INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL DEFAULT 0,
    last_error      TEXT,
    idempotency_key TEXT,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
);
CREATE INDEX outbox_jobs_ready ON outbox_jobs(status, next_attempt_at);
CREATE INDEX outbox_jobs_by_aggregate ON outbox_jobs(aggregate_id, status);
