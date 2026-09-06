-- 0015 — VENUES scoped to an organizer (a tournament's created_by), with an
-- optional best-effort geocode (lat/lng). A tournament may reference a venue via
-- venue_id; "same area" for recent-players is an exact venue_id match (no radius).
-- The free-text venue/club labels (0011) remain for display.
CREATE TABLE venues (
  id                TEXT PRIMARY KEY,
  organizer_user_id TEXT NOT NULL,
  name              TEXT NOT NULL,
  address           TEXT,
  lat               REAL,
  lng               REAL,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX venues_by_org ON venues(organizer_user_id);
ALTER TABLE tournaments ADD COLUMN venue_id TEXT;
