package auth

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/kevinelong/15ball-scoresheet/server/internal/audit"
)

var validRoles = map[string]bool{
	RoleSystemAdmin: true, RoleClubAdmin: true, RoleTournamentDirector: true,
	RoleScorekeeper: true, RolePlayer: true, RoleViewer: true,
}

// GrantRoleHandler: POST /api/v1/users/{id}/roles {role} — admin only, audited.
func (a *Auth) GrantRoleHandler(w http.ResponseWriter, r *http.Request) {
	target := chi.URLParam(r, "id")
	var body struct {
		Role string `json:"role"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 2<<10)).Decode(&body); err != nil || !validRoles[body.Role] {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_role"})
		return
	}
	actor := UserID(r.Context())
	if err := a.GrantRole(r.Context(), target, body.Role, actor); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "server_error"})
		return
	}
	_ = audit.Write(r.Context(), a.DB, audit.Entry{
		EntityType: "user", EntityID: target, Action: "role_granted",
		ActorUserID: actor, RequestID: middleware.GetReqID(r.Context()),
		After: map[string]string{"role": body.Role},
	})
	writeJSON(w, http.StatusOK, map[string]string{"status": "granted", "role": body.Role})
}

// RevokeRoleHandler: DELETE /api/v1/users/{id}/roles/{role} — admin only, audited.
func (a *Auth) RevokeRoleHandler(w http.ResponseWriter, r *http.Request) {
	target := chi.URLParam(r, "id")
	role := chi.URLParam(r, "role")
	if !validRoles[role] {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_role"})
		return
	}
	actor := UserID(r.Context())
	if err := a.RevokeRole(r.Context(), target, role); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "server_error"})
		return
	}
	_ = audit.Write(r.Context(), a.DB, audit.Entry{
		EntityType: "user", EntityID: target, Action: "role_revoked",
		ActorUserID: actor, RequestID: middleware.GetReqID(r.Context()),
		Before: map[string]string{"role": role},
	})
	writeJSON(w, http.StatusOK, map[string]string{"status": "revoked", "role": role})
}
