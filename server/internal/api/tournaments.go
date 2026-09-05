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

type Tournament struct {
	ID         string  `json:"id"`
	Slug       string  `json:"slug"`
	Name       string  `json:"name"`
	Game       string  `json:"game"`
	State      string  `json:"state"`
	Visibility string  `json:"visibility"`
	ArchivedAt *int64  `json:"archivedAt"`
	CreatedBy  string  `json:"createdBy"`
	CreatedAt  int64   `json:"createdAt"`
	UpdatedAt  int64   `json:"updatedAt"`
	Version    int64   `json:"version"`
}

const tournamentCols = `id, slug, name, game, state, visibility, archived_at, created_by, created_at, updated_at, version`

func scanTournament(row interface{ Scan(...any) error }) (*Tournament, error) {
	var t Tournament
	err := row.Scan(&t.ID, &t.Slug, &t.Name, &t.Game, &t.State, &t.Visibility, &t.ArchivedAt, &t.CreatedBy, &t.CreatedAt, &t.UpdatedAt, &t.Version)
	return &t, err
}

// tournamentTransitionSupported reports whether Slice B supports a from→to PATCH
// state change. Matches-dependent transitions (in_progress/completed/reopen) are
// added in Slice D; archive has its own endpoint.
func tournamentTransitionSupported(from, to string) bool {
	switch from + "->" + to {
	case "draft->registration_open", "registration_open->registration_closed",
		"registration_closed->registration_open",
		"registration_closed->in_progress", // Slice D: generates the bracket
		"in_progress->completed",           // guard: all matches terminal
		"completed->in_progress":            // reopen (reason required)
		return true
	}
	return false
}

// CreateTournament: POST /api/v1/tournaments (director+).
func (api *API) CreateTournament(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name       string `json:"name"`
		Visibility string `json:"visibility"`
	}
	if !decodeBody(w, r, &body) {
		return
	}
	if len(body.Name) == 0 || len(body.Name) > 200 {
		writeErr(w, http.StatusBadRequest, "invalid_name", "name is required (1-200 chars)")
		return
	}
	vis := "private"
	if body.Visibility == "public" {
		vis = "public"
	}
	base := slugify(body.Name)
	if base == "" {
		base = "tournament"
	}
	now := time.Now().Unix()
	id := newID("trn_")
	// try the clean slug, then suffix on unique conflict
	slug := base
	var err error
	for attempt := 0; attempt < 5; attempt++ {
		tx, e := api.DB.BeginTx(r.Context(), nil)
		if e != nil {
			writeErr(w, http.StatusInternalServerError, "server_error", "")
			return
		}
		_, err = tx.ExecContext(r.Context(),
			`INSERT INTO tournaments (id, slug, name, game, state, visibility, created_by, created_at, updated_at, version)
			 VALUES (?,?,?,?,?,?,?,?,?,1)`,
			id, slug, body.Name, "15ball_rotation", "draft", vis, actor(r.Context()), now, now)
		if err != nil {
			_ = tx.Rollback()
			if attempt < 4 { // slug collision → retry with suffix
				slug = base + "-" + newID("")[:5]
				continue
			}
			writeErr(w, http.StatusConflict, "duplicate_slug", "could not allocate a unique slug")
			return
		}
		_ = audit.Write(r.Context(), tx, audit.Entry{
			EntityType: "tournament", EntityID: id, Action: "created",
			ActorUserID: actor(r.Context()), RequestID: reqID(r.Context()),
			After: map[string]string{"name": body.Name, "slug": slug, "state": "draft"},
		})
		if err = tx.Commit(); err != nil {
			writeErr(w, http.StatusInternalServerError, "server_error", "")
			return
		}
		break
	}
	t, _ := api.getTournament(r.Context(), id)
	writeJSON(w, http.StatusCreated, map[string]interface{}{"tournament": t})
}

func (api *API) getTournament(ctx context.Context, id string) (*Tournament, error) {
	row := api.DB.QueryRowContext(ctx, `SELECT `+tournamentCols+` FROM tournaments WHERE id = ?`, id)
	return scanTournament(row)
}

// ListTournaments: GET /api/v1/tournaments (authenticated). Keyset pagination;
// excludes archived unless ?archived=true; optional ?state= filter.
func (api *API) ListTournaments(w http.ResponseWriter, r *http.Request) {
	limit := limitParam(r, 50, 200)
	q := `SELECT ` + tournamentCols + ` FROM tournaments WHERE 1=1`
	args := []any{}
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
	items := []*Tournament{}
	for rows.Next() {
		t, err := scanTournament(rows)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "server_error", "")
			return
		}
		items = append(items, t)
	}
	next := ""
	if len(items) > limit {
		last := items[limit-1]
		next = encodeCursor(last.CreatedAt, last.ID)
		items = items[:limit]
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"items": items, "nextCursor": next})
}

// GetTournament: GET /api/v1/tournaments/{id} (authenticated) → {tournament,divisions}.
func (api *API) GetTournament(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	t, err := api.getTournament(r.Context(), id)
	if errors.Is(err, sql.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "not_found", "tournament not found")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "server_error", "")
		return
	}
	divs, _ := api.listDivisions(r.Context(), id, false)
	writeJSON(w, http.StatusOK, map[string]interface{}{"tournament": t, "divisions": divs})
}

// PatchTournament: PATCH /api/v1/tournaments/{id} (director+). Editable metadata
// (name, visibility) + supported state transitions.
func (api *API) PatchTournament(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var body struct {
		Name       *string `json:"name"`
		Visibility *string `json:"visibility"`
		State      *string `json:"state"`
		Reason     string  `json:"reason"`
	}
	if !decodeBody(w, r, &body) {
		return
	}
	cur, err := api.getTournament(r.Context(), id)
	if errors.Is(err, sql.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "not_found", "tournament not found")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "server_error", "")
		return
	}
	if cur.ArchivedAt != nil {
		writeErr(w, http.StatusConflict, "already_archived", "tournament is archived")
		return
	}
	action := "updated"
	if body.State != nil && *body.State != cur.State {
		if !tournamentTransitionSupported(cur.State, *body.State) {
			writeErr(w, http.StatusConflict, "invalid_transition", "state change "+cur.State+"→"+*body.State+" is not allowed")
			return
		}
		// transition guards
		switch cur.State + "->" + *body.State {
		case "draft->registration_open":
			divs, _ := api.listDivisions(r.Context(), id, false)
			if len(divs) == 0 {
				writeErr(w, http.StatusConflict, "invalid_transition", "at least one division is required to open registration")
				return
			}
		case "registration_closed->in_progress":
			var n int
			_ = api.DB.QueryRowContext(r.Context(),
				`SELECT COUNT(*) FROM entrants WHERE tournament_id=? AND state='checked_in' AND archived_at IS NULL`, id).Scan(&n)
			if n < 2 {
				writeErr(w, http.StatusConflict, "invalid_transition", "need at least 2 checked-in entrants to start")
				return
			}
		case "in_progress->completed":
			var open int
			_ = api.DB.QueryRowContext(r.Context(),
				`SELECT COUNT(*) FROM matches WHERE tournament_id=? AND state <> 'completed'`, id).Scan(&open)
			if open > 0 {
				writeErr(w, http.StatusConflict, "invalid_transition", "cannot complete: matches are still open")
				return
			}
		case "completed->in_progress":
			if body.Reason == "" {
				writeErr(w, http.StatusBadRequest, "reason_required", "reopening a completed tournament requires a reason")
				return
			}
		}
		action = "state_changed"
	}
	now := time.Now().Unix()
	tx, _ := api.DB.BeginTx(r.Context(), nil)
	defer tx.Rollback()
	set := "updated_at = ?, version = version + 1"
	args := []any{now}
	if body.Name != nil && *body.Name != "" {
		set += ", name = ?"
		args = append(args, *body.Name)
	}
	if body.Visibility != nil && (*body.Visibility == "public" || *body.Visibility == "private") {
		set += ", visibility = ?"
		args = append(args, *body.Visibility)
	}
	if body.State != nil {
		set += ", state = ?"
		args = append(args, *body.State)
	}
	args = append(args, id)
	if _, err := tx.ExecContext(r.Context(), `UPDATE tournaments SET `+set+` WHERE id = ?`, args...); err != nil {
		writeErr(w, http.StatusInternalServerError, "server_error", "")
		return
	}
	// side effect: generate the round-1 bracket when starting the tournament.
	if body.State != nil && cur.State == "registration_closed" && *body.State == "in_progress" {
		if _, err := api.generateBracket(r.Context(), tx, id); err != nil {
			writeErr(w, http.StatusInternalServerError, "server_error", "")
			return
		}
	}
	_ = audit.Write(r.Context(), tx, audit.Entry{
		EntityType: "tournament", EntityID: id, Action: action, Reason: body.Reason,
		ActorUserID: actor(r.Context()), RequestID: reqID(r.Context()),
		Before: map[string]string{"state": cur.State}, After: map[string]string{"state": derefOr(body.State, cur.State)},
	})
	api.emitEvent(r.Context(), tx, id, "tournament.updated", map[string]string{"state": derefOr(body.State, cur.State)})
	if err := tx.Commit(); err != nil {
		writeErr(w, http.StatusInternalServerError, "server_error", "")
		return
	}
	t, _ := api.getTournament(r.Context(), id)
	writeJSON(w, http.StatusOK, map[string]interface{}{"tournament": t})
}

// ArchiveTournament: POST /api/v1/tournaments/{id}/archive (director+).
func (api *API) ArchiveTournament(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var body struct {
		Reason string `json:"reason"`
	}
	_ = decodeBody(w, r, &body)
	cur, err := api.getTournament(r.Context(), id)
	if errors.Is(err, sql.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "not_found", "tournament not found")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "server_error", "")
		return
	}
	if cur.ArchivedAt != nil {
		writeErr(w, http.StatusConflict, "already_archived", "tournament is already archived")
		return
	}
	now := time.Now().Unix()
	tx, _ := api.DB.BeginTx(r.Context(), nil)
	defer tx.Rollback()
	if _, err := tx.ExecContext(r.Context(),
		`UPDATE tournaments SET state='archived', archived_at=?, archived_by=?, updated_at=?, version=version+1 WHERE id=?`,
		now, actor(r.Context()), now, id); err != nil {
		writeErr(w, http.StatusInternalServerError, "server_error", "")
		return
	}
	_ = audit.Write(r.Context(), tx, audit.Entry{
		EntityType: "tournament", EntityID: id, Action: "archived",
		ActorUserID: actor(r.Context()), Reason: body.Reason, RequestID: reqID(r.Context()),
		Before: map[string]string{"state": cur.State},
	})
	if err := tx.Commit(); err != nil {
		writeErr(w, http.StatusInternalServerError, "server_error", "")
		return
	}
	t, _ := api.getTournament(r.Context(), id)
	writeJSON(w, http.StatusOK, map[string]interface{}{"tournament": t})
}
