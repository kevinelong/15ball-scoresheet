-- 0004 — entrants (Slice C). Contracts 03/04/05. Display name unique per tournament.
CREATE TABLE entrants (
    id            TEXT PRIMARY KEY,
    tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    division_id   TEXT REFERENCES divisions(id) ON DELETE SET NULL,
    display_name  TEXT NOT NULL,
    state         TEXT NOT NULL DEFAULT 'pending'
                  CHECK (state IN ('pending','registered','checked_in','eliminated','withdrawn','disqualified')),
    check_in_at   INTEGER,
    archived_at   INTEGER,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    version       INTEGER NOT NULL DEFAULT 1,
    UNIQUE (tournament_id, display_name)
);
CREATE INDEX entrants_by_tournament ON entrants(tournament_id, state, archived_at);
