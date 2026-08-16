-- 0001_init — core schema for the K-Ball / Columbia Cue Club backend.
-- Greenfield: tables that DESIGN.md describes via ALTER on a pre-existing DB are
-- created here already in their intended end-state (organization_id + owner_user_id
-- present from the start). Authoritative source: server/SPEC-DESIGN-RECONCILED.md.
-- All timestamps are unix epoch seconds (INTEGER).

-- Single implicit tenant in MVP (no org selector); scope-ready for later.
CREATE TABLE organizations (
    id          TEXT PRIMARY KEY,
    slug        TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name        TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);
INSERT OR IGNORE INTO organizations (id, slug, name, created_at, updated_at)
VALUES ('org_columbia_cue_club', 'columbia-cue-club', 'Columbia Cue Club', 0, 0);

-- Users are identified by email; the allowlist gates who may sign in.
CREATE TABLE users (
    id          TEXT PRIMARY KEY,
    email       TEXT NOT NULL UNIQUE COLLATE NOCASE,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);

-- Club-wide membership + role (authoritative from day one, per reconciliation #16).
CREATE TABLE organization_memberships (
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role            TEXT NOT NULL CHECK (role IN ('admin', 'director', 'scorer', 'viewer')),
    created_at      INTEGER NOT NULL,
    PRIMARY KEY (organization_id, user_id)
);

-- Tournaments own their full JSON state; updated_at drives the sync design.
CREATE TABLE tournaments (
    id              TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL DEFAULT 'org_columbia_cue_club'
                    REFERENCES organizations(id) ON DELETE CASCADE,
    owner_user_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
    state_json      TEXT NOT NULL,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
);
CREATE INDEX tournaments_by_organization ON tournaments (organization_id, updated_at DESC);
CREATE INDEX tournaments_by_owner        ON tournaments (owner_user_id, updated_at DESC);

-- Opaque, revocable sessions (reconciliation #7): store only the token hash.
CREATE TABLE sessions (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash      BLOB NOT NULL UNIQUE,
    created_at      INTEGER NOT NULL,
    expires_at      INTEGER NOT NULL,
    revoked_at      INTEGER,
    last_seen_at    INTEGER,
    user_agent_hash BLOB,
    ip_hash         BLOB
);
CREATE INDEX sessions_active_by_token
    ON sessions(token_hash, expires_at) WHERE revoked_at IS NULL;

-- Single-use, scanner-safe magic links (reconciliation #8): selector + secret.
CREATE TABLE magic_links (
    id                TEXT PRIMARY KEY,
    selector          BLOB NOT NULL UNIQUE,
    token_hash        BLOB NOT NULL,
    user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    requested_at      INTEGER NOT NULL,
    expires_at        INTEGER NOT NULL,
    consumed_at       INTEGER,
    requested_ip_hash BLOB
);
CREATE INDEX magic_links_pending_by_selector
    ON magic_links(selector, expires_at) WHERE consumed_at IS NULL;

-- Persisted rate-limit events for request-link (reconciliation #9).
CREATE TABLE auth_link_requests (
    id           TEXT PRIMARY KEY,
    email_hash   BLOB NOT NULL,
    ip_hash      BLOB NOT NULL,
    requested_at INTEGER NOT NULL
);
CREATE INDEX auth_link_requests_by_email_time ON auth_link_requests(email_hash, requested_at);
CREATE INDEX auth_link_requests_by_ip_time    ON auth_link_requests(ip_hash, requested_at);

-- Physical tables + assignments state machine (DESIGN.md section 1).
CREATE TABLE tables (
    id                  TEXT PRIMARY KEY,
    organization_id     TEXT NOT NULL DEFAULT 'org_columbia_cue_club'
                        REFERENCES organizations(id) ON DELETE CASCADE,
    tournament_id       TEXT NOT NULL,
    name                TEXT NOT NULL COLLATE NOCASE,
    state               TEXT NOT NULL DEFAULT 'empty'
                        CHECK (state IN ('empty', 'reserved', 'active', 'dirty', 'locked')),
    state_version       INTEGER NOT NULL DEFAULT 1 CHECK (state_version > 0),
    locked_reason       TEXT,
    locked_by_user_id   TEXT,
    created_at          INTEGER NOT NULL,
    updated_at          INTEGER NOT NULL,
    FOREIGN KEY (tournament_id) REFERENCES tournaments(id) ON DELETE CASCADE,
    FOREIGN KEY (locked_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
    UNIQUE (tournament_id, name)
);
CREATE INDEX tables_by_tournament_state ON tables (tournament_id, state, name);
CREATE INDEX tables_by_organization     ON tables (organization_id, tournament_id);

CREATE TABLE assignments (
    id                  TEXT PRIMARY KEY,
    organization_id     TEXT NOT NULL DEFAULT 'org_columbia_cue_club'
                        REFERENCES organizations(id) ON DELETE CASCADE,
    tournament_id       TEXT NOT NULL,
    table_id            TEXT NOT NULL,
    match_id            TEXT NOT NULL,
    status              TEXT NOT NULL
                        CHECK (status IN ('reserved', 'active', 'finished', 'released', 'cancelled')),
    assigned_by_user_id TEXT NOT NULL,
    assigned_at         INTEGER NOT NULL,
    activated_at        INTEGER,
    ended_at            INTEGER,
    ended_by_user_id    TEXT,
    note                TEXT,
    created_at          INTEGER NOT NULL,
    updated_at          INTEGER NOT NULL,
    FOREIGN KEY (tournament_id) REFERENCES tournaments(id) ON DELETE CASCADE,
    FOREIGN KEY (table_id) REFERENCES tables(id) ON DELETE RESTRICT,
    FOREIGN KEY (assigned_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
    FOREIGN KEY (ended_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
    CHECK (
        (status IN ('reserved', 'active') AND ended_at IS NULL) OR
        (status IN ('finished', 'released', 'cancelled') AND ended_at IS NOT NULL)
    )
);
CREATE INDEX assignments_by_tournament_match ON assignments (tournament_id, match_id, assigned_at DESC);
CREATE INDEX assignments_by_table            ON assignments (table_id, assigned_at DESC);
CREATE INDEX assignments_by_organization     ON assignments (organization_id, tournament_id);
CREATE UNIQUE INDEX one_live_assignment_per_table
    ON assignments (table_id) WHERE status IN ('reserved', 'active');
CREATE UNIQUE INDEX one_live_assignment_per_match
    ON assignments (tournament_id, match_id) WHERE status IN ('reserved', 'active');

-- Idempotent Challonge export tracking (reconciliation #13).
CREATE TABLE challonge_exports (
    tournament_id           TEXT PRIMARY KEY REFERENCES tournaments(id) ON DELETE CASCADE,
    url_key                 TEXT NOT NULL UNIQUE,
    challonge_tournament_id TEXT,
    challonge_url           TEXT,
    status                  TEXT NOT NULL CHECK (status IN ('creating','syncing','complete','failed')),
    exported_updated_at     INTEGER,
    steps_json              TEXT NOT NULL DEFAULT '{}',
    last_error              TEXT,
    created_at              INTEGER NOT NULL,
    updated_at              INTEGER NOT NULL
);
CREATE TABLE challonge_export_participants (
    tournament_id            TEXT NOT NULL REFERENCES challonge_exports(tournament_id) ON DELETE CASCADE,
    participant_id           TEXT NOT NULL,
    challonge_participant_id TEXT NOT NULL,
    PRIMARY KEY (tournament_id, participant_id)
);
