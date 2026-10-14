-- 0017 — review flag for a match whose participants changed after it was played
-- (option 3 of the reopen collision; see OPEN-QUESTIONS and 03-state-machines).
-- When a corrected upstream result reaches a downstream match that is already
-- decided, the played result is kept and the match is flagged instead of being
-- silently rewritten; a director replays it and clears the flag.
ALTER TABLE matches ADD COLUMN needs_review INTEGER NOT NULL DEFAULT 0;
