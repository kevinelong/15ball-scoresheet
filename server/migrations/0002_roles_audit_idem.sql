-- 0002 — roles, audit, idempotency (Slice A). Contracts: 02-role-permission-matrix,
-- 05-schema-contract, DECISIONS/019. Fixed role set replaces the old 4-role org
-- membership model; audit_log + idempotency_keys are foundational for later slices.

-- users: pending marker + last login (expand-then-enforce; default pending=1).
ALTER TABLE users ADD COLUMN pending_role INTEGER NOT NULL DEFAULT 1;  -- 1=pending, 0=active
ALTER TABLE users ADD COLUMN last_login_at INTEGER;

-- Fixed role set with grant/revoke timeline (multiple roles per user allowed).
CREATE TABLE user_roles (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role        TEXT NOT NULL CHECK (role IN
                  ('system_admin','club_admin','tournament_director','scorekeeper','player','viewer')),
    granted_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
    granted_at  INTEGER NOT NULL,
    revoked_at  INTEGER
);
CREATE INDEX user_roles_active ON user_roles(user_id, role) WHERE revoked_at IS NULL;

-- Migrate any legacy org-membership rows to the new role set (table is empty in
-- practice, but keep the mapping correct + idempotent), then drop the old table.
INSERT INTO user_roles (id, user_id, role, granted_at)
SELECT 'ur_mig_' || om.user_id,
       om.user_id,
       CASE om.role WHEN 'admin' THEN 'system_admin'
                    WHEN 'director' THEN 'tournament_director'
                    WHEN 'scorer' THEN 'scorekeeper'
                    ELSE 'viewer' END,
       0
FROM organization_memberships om
WHERE NOT EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = om.user_id);
DROP TABLE organization_memberships;

-- Immutable, append-only audit trail (05-schema-contract #8).
CREATE TABLE audit_log (
    id            TEXT PRIMARY KEY,
    entity_type   TEXT NOT NULL,
    entity_id     TEXT NOT NULL,
    action        TEXT NOT NULL,
    actor_user_id TEXT,
    reason        TEXT,
    before_json   TEXT,
    after_json    TEXT,
    request_id    TEXT,
    created_at    INTEGER NOT NULL
);
CREATE INDEX audit_log_by_entity ON audit_log(entity_type, entity_id, created_at DESC);

-- Idempotency-key store for safe-repeat unsafe requests (05-schema-contract #13).
CREATE TABLE idempotency_keys (
    key           TEXT NOT NULL,
    scope         TEXT NOT NULL,
    request_hash  TEXT NOT NULL,
    response_json TEXT,
    status_code   INTEGER,
    created_at    INTEGER NOT NULL,
    expires_at    INTEGER NOT NULL,
    PRIMARY KEY (key, scope)
);
