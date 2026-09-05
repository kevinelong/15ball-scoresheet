package api

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/kevinelong/15ball-scoresheet/server/internal/audit"
)

type Entrant struct {
	ID           string `json:"id"`
	TournamentID string `json:"tournamentId"`
	DivisionID   *string `json:"divisionId"`
	DisplayName  string `json:"displayName"`
	State        string `json:"state"`
	CheckInAt    *int64 `json:"checkInAt"`
	ArchivedAt   *int64 `json:"archivedAt"`
	CreatedAt    int64  `json:"createdAt"`
	UpdatedAt    int64  `json:"updatedAt"`
	Version      int64  `json:"version"`
}

const entrantCols = `id, tournament_id, division_id, display_name, state, check_in_at, archived_at, created_at, updated_at, version`

func scanEntrant(row interface{ Scan(...any) error }) (*Entrant, error) {
	var e Entrant
	err := row.Scan(&e.ID, &e.TournamentID, &e.DivisionID, &e.DisplayName, &e.State, &e.CheckInAt, &e.ArchivedAt, &e.CreatedAt, &e.UpdatedAt, &e.Version)
	return &e, err
}

func (api *API) getEntrant(ctx context.Context, tid, eid string) (*Entrant, error) {
	row := api.DB.QueryRowContext(ctx, `SELECT `+entrantCols+` FROM entrants WHERE id = ? AND tournament_id = ?`, eid, tid)
	return scanEntrant(row)
}

// entrantTransitionSupported: state changes allowed via the API in v1. Elimination
// is system-driven (bracket result), not a manual PATCH.
func entrantTransitionSupported(from, to string) bool {
	switch from + "->" + to {
	case "pending->registered", "registered->checked_in",
		"checked_in->withdrawn", "checked_in->disqualified":
		return true
	}
	return false
}

// CreateEntrant: POST /api/v1/tournaments/{id}/entrants (director+).
func (api *API) CreateEntrant(w http.ResponseWriter, r *http.Request) {
	tid := chi.URLParam(r, "id")
	if !api.tournamentExists(r.Context(), tid) {
		writeErr(w, http.StatusNotFound, "not_found", "tournament not found")
		return
	}
	var body struct {
		DisplayName string  `json:"displayName"`
		DivisionID  *string `json:"divisionId"`
	}
	if !decodeBody(w, r, &body) {
		return
	}
	if len(body.DisplayName) == 0 || len(body.DisplayName) > 120 {
		writeErr(w, http.StatusBadRequest, "invalid_display_name", "displayName is required (1-120 chars)")
		return
	}
	id := newID("ent_")
	now := time.Now().Unix()
	tx, _ := api.DB.BeginTx(r.Context(), nil)
	defer tx.Rollback()
	_, err := tx.ExecContext(r.Context(),
		`INSERT INTO entrants (id, tournament_id, division_id, display_name, state, created_at, updated_at)
		 VALUES (?,?,?,?, 'pending', ?, ?)`, id, tid, body.DivisionID, body.DisplayName, now, now)
	if err != nil {
		writeErr(w, http.StatusConflict, "duplicate_display_name", "an entrant with that name already exists")
		return
	}
	_ = audit.Write(r.Context(), tx, audit.Entry{
		EntityType: "entrant", EntityID: id, Action: "created",
		ActorUserID: actor(r.Context()), RequestID: reqID(r.Context()),
		After: map[string]interface{}{"tournamentId": tid, "displayName": body.DisplayName},
	})
	if err := tx.Commit(); err != nil {
		writeErr(w, http.StatusInternalServerError, "server_error", "")
		return
	}
	e, _ := api.getEntrant(r.Context(), tid, id)
	writeJSON(w, http.StatusCreated, map[string]interface{}{"entrant": e})
}

// ListEntrants: GET /api/v1/tournaments/{id}/entrants (authenticated).
func (api *API) ListEntrants(w http.ResponseWriter, r *http.Request) {
	tid := chi.URLParam(r, "id")
	if !api.tournamentExists(r.Context(), tid) {
		writeErr(w, http.StatusNotFound, "not_found", "tournament not found")
		return
	}
	limit := limitParam(r, 100, 500)
	q := `SELECT ` + entrantCols + ` FROM entrants WHERE tournament_id = ?`
	args := []any{tid}
	if r.URL.Query().Get("archived") != "true" {
		q += ` AND archived_at IS NULL`
	}
	if s := r.URL.Query().Get("state"); s != "" {
		q += ` AND state = ?`
		args = append(args, s)
	}
	if ca, cid, ok := decodeCursor(r.URL.Query().Get("cursor")); ok {
		q += ` AND (created_at < ? OR (created_at = ? AND id < ?))`
		args = append(args, ca, ca, cid)
	}
	q += ` ORDER BY created_at DESC, id DESC LIMIT ?`
	args = append(args, limit+1)
	rows, err := api.DB.QueryContext(r.Context(), q, args...)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "server_error", "")
		return
	}
	defer rows.Close()
	items := []*Entrant{}
	for rows.Next() {
		e, err := scanEntrant(rows)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "server_error", "")
			return
		}
		items = append(items, e)
	}
	next := ""
	if len(items) > limit {
		last := items[limit-1]
		next = encodeCursor(last.CreatedAt, last.ID)
		items = items[:limit]
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"items": items, "nextCursor": next})
}

// applyEntrantState performs a validated state transition inside a tx, writing audit.
func (api *API) applyEntrantState(w http.ResponseWriter, r *http.Request, tid, eid, to, reason string) {
	cur, err := api.getEntrant(r.Context(), tid, eid)
	if errors.Is(err, sql.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "not_found", "entrant not found")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "server_error", "")
		return
	}
	if !entrantTransitionSupported(cur.State, to) {
		writeErr(w, http.StatusConflict, "invalid_transition", "entrant "+cur.State+"→"+to+" is not allowed")
		return
	}
	// guards
	if to == "checked_in" {
		var tstate string
		_ = api.DB.QueryRowContext(r.Context(), `SELECT state FROM tournaments WHERE id=?`, tid).Scan(&tstate)
		if tstate != "registration_open" && tstate != "registration_closed" {
			writeErr(w, http.StatusConflict, "invalid_transition", "check-in requires open/closed registration")
			return
		}
	}
	if to == "disqualified" && reason == "" {
		writeErr(w, http.StatusBadRequest, "reason_required", "disqualification requires a reason")
		return
	}
	now := time.Now().Unix()
	tx, _ := api.DB.BeginTx(r.Context(), nil)
	defer tx.Rollback()
	set := "state = ?, updated_at = ?, version = version + 1"
	args := []any{to, now}
	if to == "checked_in" {
		set += ", check_in_at = ?"
		args = append(args, now)
	}
	args = append(args, eid)
	if _, err := tx.ExecContext(r.Context(), `UPDATE entrants SET `+set+` WHERE id = ?`, args...); err != nil {
		writeErr(w, http.StatusInternalServerError, "server_error", "")
		return
	}
	_ = audit.Write(r.Context(), tx, audit.Entry{
		EntityType: "entrant", EntityID: eid, Action: "state_changed",
		ActorUserID: actor(r.Context()), Reason: reason, RequestID: reqID(r.Context()),
		Before: map[string]string{"state": cur.State}, After: map[string]string{"state": to},
	})
	if err := tx.Commit(); err != nil {
		writeErr(w, http.StatusInternalServerError, "server_error", "")
		return
	}
	e, _ := api.getEntrant(r.Context(), tid, eid)
	writeJSON(w, http.StatusOK, map[string]interface{}{"entrant": e})
}

// PatchEntrant: PATCH /api/v1/tournaments/{id}/entrants/{entrantId} (director+).
func (api *API) PatchEntrant(w http.ResponseWriter, r *http.Request) {
	tid := chi.URLParam(r, "id")
	eid := chi.URLParam(r, "entrantId")
	var body struct {
		DisplayName *string `json:"displayName"`
		State       *string `json:"state"`
		Reason      string  `json:"reason"`
	}
	if !decodeBody(w, r, &body) {
		return
	}
	if body.State != nil {
		api.applyEntrantState(w, r, tid, eid, *body.State, body.Reason)
		return
	}
	// metadata-only update (display name)
	cur, err := api.getEntrant(r.Context(), tid, eid)
	if errors.Is(err, sql.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "not_found", "entrant not found")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "server_error", "")
		return
	}
	if body.DisplayName == nil || *body.DisplayName == "" {
		writeJSON(w, http.StatusOK, map[string]interface{}{"entrant": cur})
		return
	}
	now := time.Now().Unix()
	tx, _ := api.DB.BeginTx(r.Context(), nil)
	defer tx.Rollback()
	if _, err := tx.ExecContext(r.Context(),
		`UPDATE entrants SET display_name=?, updated_at=?, version=version+1 WHERE id=?`, *body.DisplayName, now, eid); err != nil {
		writeErr(w, http.StatusConflict, "duplicate_display_name", "an entrant with that name already exists")
		return
	}
	_ = audit.Write(r.Context(), tx, audit.Entry{
		EntityType: "entrant", EntityID: eid, Action: "updated",
		ActorUserID: actor(r.Context()), RequestID: reqID(r.Context()),
		Before: map[string]string{"displayName": cur.DisplayName}, After: map[string]string{"displayName": *body.DisplayName},
	})
	if err := tx.Commit(); err != nil {
		writeErr(w, http.StatusInternalServerError, "server_error", "")
		return
	}
	e, _ := api.getEntrant(r.Context(), tid, eid)
	writeJSON(w, http.StatusOK, map[string]interface{}{"entrant": e})
}

// CheckInEntrant: POST /api/v1/tournaments/{id}/entrants/{entrantId}/check-in (director+).
func (api *API) CheckInEntrant(w http.ResponseWriter, r *http.Request) {
	tid := chi.URLParam(r, "id")
	eid := chi.URLParam(r, "entrantId")
	// safe-repeat: if already checked_in, return current state 200
	cur, err := api.getEntrant(r.Context(), tid, eid)
	if err == nil && cur.State == "checked_in" {
		writeJSON(w, http.StatusOK, map[string]interface{}{"entrant": cur})
		return
	}
	api.applyEntrantState(w, r, tid, eid, "checked_in", "")
}

// ArchiveEntrant: POST /api/v1/tournaments/{id}/entrants/{entrantId}/archive (director+).
func (api *API) ArchiveEntrant(w http.ResponseWriter, r *http.Request) {
	tid := chi.URLParam(r, "id")
	eid := chi.URLParam(r, "entrantId")
	var body struct {
		Reason string `json:"reason"`
	}
	_ = decodeBody(w, r, &body)
	cur, err := api.getEntrant(r.Context(), tid, eid)
	if errors.Is(err, sql.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "not_found", "entrant not found")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "server_error", "")
		return
	}
	if cur.ArchivedAt != nil { // safe repeat
		writeJSON(w, http.StatusOK, map[string]interface{}{"entrant": cur})
		return
	}
	now := time.Now().Unix()
	tx, _ := api.DB.BeginTx(r.Context(), nil)
	defer tx.Rollback()
	if _, err := tx.ExecContext(r.Context(),
		`UPDATE entrants SET archived_at=?, updated_at=?, version=version+1 WHERE id=?`, now, now, eid); err != nil {
		writeErr(w, http.StatusInternalServerError, "server_error", "")
		return
	}
	_ = audit.Write(r.Context(), tx, audit.Entry{
		EntityType: "entrant", EntityID: eid, Action: "archived",
		ActorUserID: actor(r.Context()), Reason: body.Reason, RequestID: reqID(r.Context()),
	})
	if err := tx.Commit(); err != nil {
		writeErr(w, http.StatusInternalServerError, "server_error", "")
		return
	}
	e, _ := api.getEntrant(r.Context(), tid, eid)
	writeJSON(w, http.StatusOK, map[string]interface{}{"entrant": e})
}
