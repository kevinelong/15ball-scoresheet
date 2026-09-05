// Package api implements the /api/v1 domain endpoints (tournaments, divisions,
// entrants, matches, scoring, sync, audit) per server/IMPLEMENTATION/04-api-contracts.
package api

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5/middleware"
	"github.com/kevinelong/15ball-scoresheet/server/internal/auth"
)

type API struct {
	DB   *sql.DB
	Auth *auth.Auth
}

func New(db *sql.DB, a *auth.Auth) *API { return &API{DB: db, Auth: a} }

// ---- response helpers ------------------------------------------------------

func writeJSON(w http.ResponseWriter, code int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

// writeErr uses the contract envelope: {"error":{"code","message"}}.
func writeErr(w http.ResponseWriter, code int, ecode, msg string) {
	writeJSON(w, code, map[string]interface{}{"error": map[string]string{"code": ecode, "message": msg}})
}

func decodeBody(w http.ResponseWriter, r *http.Request, v interface{}) bool {
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 256<<10)).Decode(v); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_body", "request body is not valid JSON")
		return false
	}
	return true
}

// ---- misc helpers ----------------------------------------------------------

func newID(prefix string) string {
	b := make([]byte, 12)
	_, _ = rand.Read(b)
	return prefix + hex.EncodeToString(b)
}

var slugRe = regexp.MustCompile(`[^a-z0-9]+`)

func slugify(s string) string {
	s = slugRe.ReplaceAllString(strings.ToLower(strings.TrimSpace(s)), "-")
	return strings.Trim(s, "-")
}

func reqID(ctx context.Context) string { return middleware.GetReqID(ctx) }
func actor(ctx context.Context) string { return auth.UserID(ctx) }

func derefOr(p *string, def string) string {
	if p != nil {
		return *p
	}
	return def
}

func limitParam(r *http.Request, def, max int) int {
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			if n > max {
				return max
			}
			return n
		}
	}
	return def
}

// keyset cursor over (created_at, id): encodes "<created_at>|<id>".
func encodeCursor(createdAt int64, id string) string {
	return base64.RawURLEncoding.EncodeToString([]byte(strconv.FormatInt(createdAt, 10) + "|" + id))
}

func decodeCursor(s string) (int64, string, bool) {
	if s == "" {
		return 0, "", false
	}
	b, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return 0, "", false
	}
	parts := strings.SplitN(string(b), "|", 2)
	if len(parts) != 2 {
		return 0, "", false
	}
	ca, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil {
		return 0, "", false
	}
	return ca, parts[1], true
}
