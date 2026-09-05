-- 0005 — matches + match_results (Slice D/E). Contracts 03/04/05.
-- NOTE (impl decision, DECISIONS/019-adjacent): 05-schema-contract #6 omits match
-- participants; a match must know its two entrants before a result exists, so
-- entrant_a_id/entrant_b_id are added here (nullable — filled by bracket advancement).
-- `slot` gives the round position used to seed the next round's match.

CREATE TABLE matches (
    id                            TEXT PRIMARY KEY,
    tournament_id                 TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    division_id                   TEXT REFERENCES divisions(id) ON DELETE SET NULL,
    bracket_round                 INTEGER NOT NULL DEFAULT 1,
    slot                          INTEGER NOT NULL DEFAULT 0,
    entrant_a_id                  TEXT REFERENCES entrants(id) ON DELETE SET NULL,
    entrant_b_id                  TEXT REFERENCES entrants(id) ON DELETE SET NULL,
    state                         TEXT NOT NULL DEFAULT 'scheduled'
                                  CHECK (state IN ('scheduled','assigned','in_progress','completed','reopened')),
    assigned_scorekeeper_user_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
    reopened_from_result_id       TEXT,
    version                       INTEGER NOT NULL DEFAULT 1,
    scheduled_at                  INTEGER,
    started_at                    INTEGER,
    completed_at                  INTEGER,
    created_at                    INTEGER NOT NULL,
    updated_at                    INTEGER NOT NULL
);
CREATE INDEX matches_by_tournament ON matches(tournament_id, state, updated_at DESC);
CREATE INDEX matches_by_round ON matches(tournament_id, bracket_round, slot);

-- Append-only, versioned results (never UPDATE to "correct" history).
CREATE TABLE match_results (
    id                TEXT PRIMARY KEY,
    match_id          TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
    result_version    INTEGER NOT NULL,
    winner_entrant_id TEXT REFERENCES entrants(id) ON DELETE SET NULL,
    loser_entrant_id  TEXT REFERENCES entrants(id) ON DELETE SET NULL,
    payload_json      TEXT,
    submitted_by      TEXT REFERENCES users(id) ON DELETE SET NULL,
    submitted_at      INTEGER NOT NULL,
    superseded_by     TEXT,
    UNIQUE (match_id, result_version)
);
CREATE INDEX match_results_by_match ON match_results(match_id, result_version DESC);
