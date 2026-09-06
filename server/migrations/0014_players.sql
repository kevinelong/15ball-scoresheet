-- 0014 — cross-event PLAYER identity scoped to the organizer (created_by).
-- A player is the same person recognized across one organizer's tournaments;
-- entrants link to a player so similar names can be surfaced and duplicates merged.
CREATE TABLE players (
  id                TEXT PRIMARY KEY,
  organizer_user_id TEXT NOT NULL,
  display_name      TEXT NOT NULL,
  name_key          TEXT NOT NULL,
  phone             TEXT,
  email             TEXT,
  fargo             INTEGER,
  external_id       TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX players_by_org ON players(organizer_user_id, name_key);
ALTER TABLE entrants ADD COLUMN player_id TEXT;
