package auth

import (
	"context"
	"net/http"
	"time"
)

// Fixed v1 role set (02-role-permission-matrix / DECISIONS/019 §D3).
const (
	RoleSystemAdmin         = "system_admin"
	RoleClubAdmin           = "club_admin"
	RoleTournamentDirector  = "tournament_director"
	RoleScorekeeper         = "scorekeeper"
	RolePlayer              = "player"
	RoleViewer              = "viewer"
)

// Convenience role sets for endpoint gates.
var (
	DirectorOrAbove = []string{RoleSystemAdmin, RoleClubAdmin, RoleTournamentDirector}
	AdminOnly       = []string{RoleSystemAdmin, RoleClubAdmin}
)

// EnsureProvisioned grants a role on first sign-in if the user has none:
// bootstrap admins → system_admin (active); everyone else → viewer (pending).
// Idempotent — a user who already has an active role is untouched.
func (a *Auth) EnsureProvisioned(ctx context.Context, userID, email string) error {
	var n int
	if err := a.DB.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM user_roles WHERE user_id = ? AND revoked_at IS NULL`, userID).Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		return nil
	}
	if email == "" { // backfill path: resolve the email so bootstrap check is correct
		_ = a.DB.QueryRowContext(ctx, `SELECT email FROM users WHERE id = ?`, userID).Scan(&email)
	}
	role, pending := RoleViewer, 1
	if a.Cfg.IsBootstrapAdmin(email) {
		role, pending = RoleSystemAdmin, 0
	}
	now := time.Now().Unix()
	tx, err := a.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO user_roles (id, user_id, role, granted_at) VALUES (?, ?, ?, ?)`,
		newID("ur_"), userID, role, now); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE users SET pending_role = ? WHERE id = ?`, pending, userID); err != nil {
		return err
	}
	return tx.Commit()
}

// Roles returns the user's active (unrevoked) role names.
func (a *Auth) Roles(ctx context.Context, userID string) ([]string, error) {
	rows, err := a.DB.QueryContext(ctx,
		`SELECT role FROM user_roles WHERE user_id = ? AND revoked_at IS NULL ORDER BY granted_at`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var roles []string
	for rows.Next() {
		var r string
		if err := rows.Scan(&r); err != nil {
			return nil, err
		}
		roles = append(roles, r)
	}
	return roles, rows.Err()
}

// Pending reports whether the user is a pending (unpromoted) account.
func (a *Auth) Pending(ctx context.Context, userID string) (bool, error) {
	var p int
	err := a.DB.QueryRowContext(ctx, `SELECT pending_role FROM users WHERE id = ?`, userID).Scan(&p)
	return p != 0, err
}

// HasAnyRole reports whether the user holds at least one of the given roles.
func (a *Auth) HasAnyRole(ctx context.Context, userID string, want ...string) (bool, error) {
	roles, err := a.Roles(ctx, userID)
	if err != nil {
		return false, err
	}
	for _, r := range roles {
		for _, w := range want {
			if r == w {
				return true, nil
			}
		}
	}
	return false, nil
}

// GrantRole adds an active role (admin management). Idempotent.
func (a *Auth) GrantRole(ctx context.Context, targetUserID, role, grantedBy string) error {
	has, err := a.HasAnyRole(ctx, targetUserID, role)
	if err != nil || has {
		return err
	}
	_, err = a.DB.ExecContext(ctx,
		`INSERT INTO user_roles (id, user_id, role, granted_by, granted_at) VALUES (?, ?, ?, ?, ?)`,
		newID("ur_"), targetUserID, role, grantedBy, time.Now().Unix())
	if err == nil {
		_, _ = a.DB.ExecContext(ctx, `UPDATE users SET pending_role = 0 WHERE id = ?`, targetUserID)
	}
	return err
}

// RevokeRole marks a role revoked (soft; timeline preserved).
func (a *Auth) RevokeRole(ctx context.Context, targetUserID, role string) error {
	_, err := a.DB.ExecContext(ctx,
		`UPDATE user_roles SET revoked_at = ? WHERE user_id = ? AND role = ? AND revoked_at IS NULL`,
		time.Now().Unix(), targetUserID, role)
	return err
}

// RequireRoles returns middleware that 403s unless the session user holds one of
// the given roles. Must be chained after RequireSession. (03/09: server-side only.)
func (a *Auth) RequireRoles(roles ...string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			uid := UserID(r.Context())
			if uid == "" {
				writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthenticated"})
				return
			}
			ok, err := a.HasAnyRole(r.Context(), uid, roles...)
			if err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "server_error"})
				return
			}
			if !ok {
				writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// touchLastLogin records the sign-in time (best-effort).
func (a *Auth) touchLastLogin(ctx context.Context, userID string) {
	_, _ = a.DB.ExecContext(ctx, `UPDATE users SET last_login_at = ? WHERE id = ?`, time.Now().Unix(), userID)
}
