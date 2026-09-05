-- 0009 — SMS match-ready alerts (Slice K). Twilio delivery via a transactional
-- outbox, mirroring the Challonge sync worker (retry/backoff/dead-letter).
-- Entrants gain an opt-in phone; a match-ready alert is enqueued when a match is
-- assigned to a table.

ALTER TABLE entrants ADD COLUMN phone TEXT;
ALTER TABLE entrants ADD COLUMN notify_opt_in INTEGER NOT NULL DEFAULT 0;

-- Outbox of outbound messages. dedupe_key makes enqueue idempotent so a re-assign
-- (or a retried request) never double-texts a player for the same match/kind.
CREATE TABLE notifications (
    id                  TEXT PRIMARY KEY,
    tournament_id       TEXT NOT NULL,
    match_id            TEXT,
    entrant_id          TEXT,
    channel             TEXT NOT NULL DEFAULT 'sms',
    recipient           TEXT NOT NULL,        -- E.164 phone number
    body                TEXT NOT NULL,
    status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','processing','sent','failed','dead_lettered')),
    attempts            INTEGER NOT NULL DEFAULT 0,
    next_attempt_at     INTEGER NOT NULL DEFAULT 0,
    last_error          TEXT,
    provider_message_id TEXT,
    dedupe_key          TEXT UNIQUE,
    created_at          INTEGER NOT NULL,
    updated_at          INTEGER NOT NULL
);
CREATE INDEX notifications_ready ON notifications(status, next_attempt_at);
CREATE INDEX notifications_by_match ON notifications(match_id);
