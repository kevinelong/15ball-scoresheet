-- 0010 — double-elimination bracket support (Slice L). A persisted feeder-graph
-- mirroring the frontend bracket.js engine: every match knows where its winner
-- advances and (winners bracket) where its loser drops. Single-elimination rows
-- leave these columns NULL and use the existing round/slot advancement.
ALTER TABLE matches ADD COLUMN bracket TEXT;              -- 'W' | 'L' | 'GF'  (NULL = single-elim)
ALTER TABLE matches ADD COLUMN match_label TEXT;          -- e.g. 'W2M1','L1M2','GF1','GF2'
ALTER TABLE matches ADD COLUMN feeds_winner_match TEXT;   -- match id the winner advances to
ALTER TABLE matches ADD COLUMN feeds_winner_slot INTEGER; -- 0 = entrant_a, 1 = entrant_b
ALTER TABLE matches ADD COLUMN feeds_loser_match TEXT;    -- match id the loser drops to (winners bracket only)
ALTER TABLE matches ADD COLUMN feeds_loser_slot INTEGER;
CREATE INDEX matches_by_bracket ON matches(tournament_id, bracket, bracket_round, slot);
