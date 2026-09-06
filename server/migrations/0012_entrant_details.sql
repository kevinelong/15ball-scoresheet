-- 0012 — optional entrant details for forgiving roster import (Slice N).
-- email, fargo rating (used to seed the bracket), and an external player id.
ALTER TABLE entrants ADD COLUMN email TEXT;
ALTER TABLE entrants ADD COLUMN fargo INTEGER;
ALTER TABLE entrants ADD COLUMN external_id TEXT;
