-- 0011 — optional venue + club labels on a tournament. Lightweight multi-club:
-- lets any organizer tag which venue/club an event belongs to without a full
-- tenancy layer. Both nullable and free-form.
ALTER TABLE tournaments ADD COLUMN venue TEXT;
ALTER TABLE tournaments ADD COLUMN club TEXT;
