-- 0008 — table assignment (Slice J). Contract 04 assign endpoint carries an
-- optional tableRef; persist it on the match so the bracket desk, OBS overlay and
-- printable score sheets (DECISION 018) can read the table from the server rather
-- than client-local state. Free-form label ("3", "Table 3", "Diamond 1") — the
-- physical-surface identity model in DESIGN.md is intentionally deferred.
ALTER TABLE matches ADD COLUMN table_ref TEXT;
