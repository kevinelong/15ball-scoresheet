package api

import (
	"database/sql"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
)

// Snapshot: GET /api/v1/tournaments/{id}/snapshot (authenticated). Normalized view
// for clients + the OBS overlay (06-realtime-contract).
func (api *API) Snapshot(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	snap, err := api.buildSnapshot(r, id)
	if errors.Is(err, sql.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "not_found", "tournament not found")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "server_error", "")
		return
	}
	writeJSON(w, http.StatusOK, snap)
}

// PublicTournament: GET /api/v1/public/tournaments/{id} (public; 404 unless visibility=public).
func (api *API) PublicTournament(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if !api.isPublic(r, id) {
		writeErr(w, http.StatusNotFound, "not_found", "tournament not found")
		return
	}
	snap, err := api.buildSnapshot(r, id)
	if err != nil {
		writeErr(w, http.StatusNotFound, "not_found", "tournament not found")
		return
	}
	writeJSON(w, http.StatusOK, snap)
}

// PublicOverlay: GET /api/v1/public/tournaments/{id}/overlay (public OBS state).
func (api *API) PublicOverlay(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if !api.isPublic(r, id) {
		writeErr(w, http.StatusNotFound, "not_found", "tournament not found")
		return
	}
	ov, err := api.buildOverlay(r, id)
	if err != nil {
		writeErr(w, http.StatusNotFound, "not_found", "tournament not found")
		return
	}
	writeJSON(w, http.StatusOK, ov)
}

func (api *API) isPublic(r *http.Request, id string) bool {
	var vis string
	err := api.DB.QueryRowContext(r.Context(), `SELECT visibility FROM tournaments WHERE id=? AND archived_at IS NULL`, id).Scan(&vis)
	return err == nil && vis == "public"
}

func (api *API) buildSnapshot(r *http.Request, id string) (map[string]interface{}, error) {
	t, err := api.getTournament(r.Context(), id)
	if err != nil {
		return nil, err
	}
	divs, _ := api.listDivisions(r.Context(), id, false)
	ents, _ := api.listEntrantsRaw(r, id)
	matches, _ := api.listMatchesRaw(r, id)
	overlay, _ := api.buildOverlay(r, id)
	return map[string]interface{}{
		"tournament": t, "divisions": divs, "entrants": ents, "matches": matches, "overlay": overlay,
	}, nil
}

func (api *API) listEntrantsRaw(r *http.Request, id string) ([]*Entrant, error) {
	rows, err := api.DB.QueryContext(r.Context(), `SELECT `+entrantCols+` FROM entrants WHERE tournament_id=? AND archived_at IS NULL ORDER BY display_name`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*Entrant{}
	for rows.Next() {
		e, err := scanEntrant(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, nil
}

func (api *API) listMatchesRaw(r *http.Request, id string) ([]*Match, error) {
	rows, err := api.DB.QueryContext(r.Context(), `SELECT `+matchCols+` FROM matches WHERE tournament_id=? ORDER BY bracket_round, slot`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*Match{}
	for rows.Next() {
		m, err := scanMatch(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, nil
}

// buildOverlay produces OBS-normalized state from the current in-progress match.
func (api *API) buildOverlay(r *http.Request, id string) (map[string]interface{}, error) {
	t, err := api.getTournament(r.Context(), id)
	if err != nil {
		return nil, err
	}
	ov := map[string]interface{}{
		"tournamentName": t.Name, "status": t.State, "updatedAt": t.UpdatedAt, "players": []interface{}{},
	}
	// pick the most-recently-updated live match
	var mid string
	var aID, bID sql.NullString
	err = api.DB.QueryRowContext(r.Context(),
		`SELECT id, entrant_a_id, entrant_b_id FROM matches WHERE tournament_id=? AND state IN ('in_progress','reopened') ORDER BY updated_at DESC LIMIT 1`, id).
		Scan(&mid, &aID, &bID)
	if err != nil {
		return ov, nil // no live match
	}
	name := func(eid string) string {
		if eid == "" {
			return ""
		}
		var n string
		_ = api.DB.QueryRowContext(r.Context(), `SELECT display_name FROM entrants WHERE id=?`, eid).Scan(&n)
		return n
	}
	ov["matchId"] = mid
	ov["players"] = []map[string]interface{}{
		{"name": name(aID.String)},
		{"name": name(bID.String)},
	}
	return ov, nil
}

// Audit: GET /api/v1/tournaments/{id}/audit (director+). Keyset pagination.
func (api *API) ListAudit(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if !api.tournamentExists(r.Context(), id) {
		writeErr(w, http.StatusNotFound, "not_found", "tournament not found")
		return
	}
	limit := limitParam(r, 100, 500)
	// audit rows for the tournament and all its child entities
	q := `SELECT id, entity_type, entity_id, action, actor_user_id, reason, created_at
	      FROM audit_log
	      WHERE (entity_type='tournament' AND entity_id=?)
	         OR entity_id IN (SELECT id FROM entrants WHERE tournament_id=?)
	         OR entity_id IN (SELECT id FROM matches WHERE tournament_id=?)
	         OR entity_id IN (SELECT id FROM divisions WHERE tournament_id=?)`
	args := []any{id, id, id, id}
	if et := r.URL.Query().Get("entityType"); et != "" {
		q += ` AND entity_type=?`
		args = append(args, et)
	}
	q += ` ORDER BY created_at DESC, id DESC LIMIT ?`
	args = append(args, limit)
	rows, err := api.DB.QueryContext(r.Context(), q, args...)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "server_error", "")
		return
	}
	defer rows.Close()
	items := []map[string]interface{}{}
	for rows.Next() {
		var aid, etype, eid, action string
		var actor, reason sql.NullString
		var createdAt int64
		_ = rows.Scan(&aid, &etype, &eid, &action, &actor, &reason, &createdAt)
		items = append(items, map[string]interface{}{
			"id": aid, "entityType": etype, "entityId": eid, "action": action,
			"actorUserId": actor.String, "reason": reason.String, "createdAt": createdAt,
		})
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"items": items})
}
