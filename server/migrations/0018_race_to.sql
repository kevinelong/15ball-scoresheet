-- 0018 — the race target as a property of the division (and, optionally, the match)
-- The bracket shows win/loss only, but it carries the race: the target a scorer
-- reads is printed on the sheet before anyone scores. NULL means "not set here":
-- a division falls back to the game's default, a match falls back to its division.
-- Additive, no backfill; existing rows read back as NULL (see 05-schema-contract).
ALTER TABLE divisions ADD COLUMN race_to INTEGER;
ALTER TABLE matches ADD COLUMN race_to INTEGER;
