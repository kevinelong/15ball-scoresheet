-- 0016 — dismissed duplicate-player PAIRS (organizer-scoped "not a duplicate"
-- decisions). A pair is stored in canonical order (player_a = min(id1,id2)
-- lexicographically, player_b = max) so the same unordered pair is dismissed once.
-- The organizer-wide duplicate-review screen excludes any pair present here.
CREATE TABLE player_dismissed_pairs (
  organizer_user_id TEXT NOT NULL,
  player_a          TEXT NOT NULL,
  player_b          TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  PRIMARY KEY (organizer_user_id, player_a, player_b)
);
