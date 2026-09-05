package api

import (
	"context"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/kevinelong/15ball-scoresheet/server/internal/audit"
)

type Division struct {
	ID           string `json:"id"`
	TournamentID string `json:"tournamentId"`
	Name         string `json:"name"`
	Format       string `json:"format"`
	State        string `json:"state"`
	ArchivedAt   *int64 `json:"archivedAt"`
	CreatedAt    int64  `json:"createdAt"`
	UpdatedAt    int64  `json:"updatedAt"`
}

func (api *API) listDivisions(ctx context.Context, tournamentID string, includeArchived bool) ([]*Division, error) {
	q := `SELECT id, tournament_id, name, format, state, archived_at, created_at, updated_at
	      FROM divisions WHERE tournament_id = ?`
	if !includeArchived {
		q += ` AND archived_at IS NULL`
	}
	q += ` ORDER BY name`
	rows, err := api.DB.QueryContext(ctx, q, tournamentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*Division{}
	for rows.Next() {
		var d Division
		if err := rows.Scan(&d.ID, &d.TournamentID, &d.Name, &d.Format, &d.State, &d.ArchivedAt, &d.CreatedAt, &d.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, &d)
	}
	return out, rows.Err()
}

// tournamentExists checks presence (not archived) for FK-style guards.
func (api *API) tournamentExists(ctx context.Context, id string) bool {
	var x int
	err := api.DB.QueryRowContext(ctx, `SELECT 1 FROM tournaments WHERE id = ?`, id).Scan(&x)
	return err == nil
}

// ListDivisions: GET /api/v1/tournaments/{id}/divisions (authenticated).
func (api *API) ListDivisions(w http.ResponseWriter, r *http.Request) {
	tid := chi.URLParam(r, "id")
	if !api.tournamentExists(r.Context(), tid) {
		writeErr(w, http.StatusNotFound, "not_found", "tournament not found")
		return
	}
	divs, err := api.listDivisions(r.Context(), tid, r.URL.Query().Get("archived") == "true")
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "server_error", "")
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"items": divs})
}

// CreateDivision: POST /api/v1/tournaments/{id}/divisions (director+).
func (api *API) CreateDivision(w http.ResponseWriter, r *http.Request) {
	tid := chi.URLParam(r, "id")
	if !api.tournamentExists(r.Context(), tid) {
		writeErr(w, http.StatusNotFound, "not_found", "tournament not found")
		return
	}
	var body struct {
		Name   string `json:"name"`
		Format string `json:"format"`
	}
	if !decodeBody(w, r, &body) {
		return
	}
	if len(body.Name) == 0 || len(body.Name) > 120 {
		writeErr(w, http.StatusBadRequest, "invalid_name", "division name is required (1-120 chars)")
		return
	}
	format := body.Format
	if format == "" {
		format = "single_elimination"
	}
	id := newID("div_")
	now := time.Now().Unix()
	tx, _ := api.DB.BeginTx(r.Context(), nil)
	defer tx.Rollback()
	_, err := tx.ExecContext(r.Context(),
		`INSERT INTO divisions (id, tournament_id, name, format, state, created_at, updated_at)
		 VALUES (?,?,?,?, 'active', ?, ?)`,
		id, tid, body.Name, format, now, now)
	if err != nil {
		// UNIQUE(tournament_id,name) violation
		writeErr(w, http.StatusConflict, "duplicate_division", "a division with that name already exists")
		return
	}
	_ = audit.Write(r.Context(), tx, audit.Entry{
		EntityType: "division", EntityID: id, Action: "created",
		ActorUserID: actor(r.Context()), RequestID: reqID(r.Context()),
		After: map[string]string{"tournamentId": tid, "name": body.Name, "format": format},
	})
	if err := tx.Commit(); err != nil {
		writeErr(w, http.StatusInternalServerError, "server_error", "")
		return
	}
	var d Division
	_ = api.DB.QueryRowContext(r.Context(),
		`SELECT id, tournament_id, name, format, state, archived_at, created_at, updated_at FROM divisions WHERE id=?`, id).
		Scan(&d.ID, &d.TournamentID, &d.Name, &d.Format, &d.State, &d.ArchivedAt, &d.CreatedAt, &d.UpdatedAt)
	writeJSON(w, http.StatusCreated, map[string]interface{}{"division": &d})
}
