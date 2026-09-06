-- 0013 — optional manual seed override for the bracket (Slice O).
-- When set, `seed` takes precedence over Fargo for bracket seeding order.
ALTER TABLE entrants ADD COLUMN seed INTEGER;
