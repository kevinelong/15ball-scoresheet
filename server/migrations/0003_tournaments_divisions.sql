-- 0003 — normalized tournaments + divisions (Slice B). Contracts: 03/04/05.
-- The deployed DB holds only throwaway auth-test rows, so the old org-scoped
-- tournaments + unused tables/assignments/challonge_export* are dropped and the
-- contract schema built fresh (DECISIONS/019 §D5). Child tables dropped first.

DROP TABLE IF EXISTS assignments;
DROP TABLE IF EXISTS challonge_export_participants;
DROP TABLE IF EXISTS challonge_exports;
DROP TABLE IF EXISTS tables;
DROP TABLE IF EXISTS tournaments;
DROP TABLE IF EXISTS organizations;   -- org layer removed in v1 (single implicit club)

CREATE TABLE tournaments (
    id           TEXT PRIMARY KEY,
    slug         TEXT NOT NULL UNIQUE,
    name         TEXT NOT NULL,
    game         TEXT NOT NULL DEFAULT '15ball_rotation',
    state        TEXT NOT NULL DEFAULT 'draft'
                 CHECK (state IN ('draft','registration_open','registration_closed','in_progress','completed','archived')),
    visibility   TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','public')),
    archived_at  INTEGER,
    archived_by  TEXT,
    created_by   TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    version      INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX tournaments_by_state ON tournaments(state, updated_at DESC);

CREATE TABLE divisions (
    id            TEXT PRIMARY KEY,
    tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    format        TEXT NOT NULL DEFAULT 'single_elimination',
    state         TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','archived')),
    archived_at   INTEGER,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    UNIQUE (tournament_id, name)
);
CREATE INDEX divisions_by_tournament ON divisions(tournament_id, state);
