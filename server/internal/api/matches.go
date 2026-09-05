package api

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/kevinelong/15ball-scoresheet/server/internal/audit"
	"github.com/kevinelong/15ball-scoresheet/server/internal/auth"
)

type Match struct {
	ID           string  `json:"id"`
	TournamentID string  `json:"tournamentId"`
	DivisionID   *string `json:"divisionId"`
	BracketRound int     `json:"bracketRound"`
	Slot         int     `json:"slot"`
	EntrantAID   *string `json:"entrantAId"`
	EntrantBID   *string `json:"entrantBId"`
	State        string  `json:"state"`
	Scorekeeper  *string `json:"assignedScorekeeperUserId"`
	TableRef     *string `json:"tableRef"`
	Version      int64   `json:"version"`
	StartedAt    *int64  `json:"startedAt"`
	CompletedAt  *int64  `json:"completedAt"`
	CreatedAt    int64   `json:"createdAt"`
	UpdatedAt    int64   `json:"updatedAt"`
}

const matchCols = `id, tournament_id, division_id, bracket_round, slot, entrant_a_id, entrant_b_id, state, assigned_scorekeeper_user_id, table_ref, version, started_at, completed_at, created_at, updated_at`

func scanMatch(row interface{ Scan(...any) error }) (*Match, error) {
	var m Match
	err := row.Scan(&m.ID, &m.TournamentID, &m.DivisionID, &m.BracketRound, &m.Slot, &m.EntrantAID, &m.EntrantBID,
		&m.State, &m.Scorekeeper, &m.TableRef, &m.Version, &m.StartedAt, &m.CompletedAt, &m.CreatedAt, &m.UpdatedAt)
	return &m, err
}

func (api *API) getMatch(ctx context.Context, tid, mid string) (*Match, error) {
	row := api.DB.QueryRowContext(ctx, `SELECT `+matchCols+` FROM matches WHERE id=? AND tournament_id=?`, mid, tid)
	return scanMatch(row)
}

// generateBracket creates round-1 single-elimination matches from checked-in
// entrants (seeded by registration order). Byes for an odd count are resolved by
// bracket advancement in Slice E. Runs inside the caller's transaction.
func (api *API) generateBracket(ctx context.Context, tx *sql.Tx, tid string) (int, error) {
	rows, err := tx.QueryContext(ctx,
		`SELECT id FROM entrants WHERE tournament_id=? AND state='checked_in' AND archived_at IS NULL ORDER BY created_at, id`, tid)
	if err != nil {
		return 0, err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return 0, err
		}
		ids = append(ids, id)
	}
	rows.Close()
	now := time.Now().Unix()
	created, slot := 0, 0
	for i := 0; i+1 < len(ids); i += 2 {
		a, b := ids[i], ids[i+1]
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO matches (id, tournament_id, bracket_round, slot, entrant_a_id, entrant_b_id, state, created_at, updated_at)
			 VALUES (?,?,1,?,?,?, 'scheduled', ?, ?)`,
			newID("mch_"), tid, slot, a, b, now, now); err != nil {
			return 0, err
		}
		slot++
		created++
	}
	return created, nil
}

// ListMatches: GET /api/v1/tournaments/{id}/matches (authenticated).
func (api *API) ListMatches(w http.ResponseWriter, r *http.Request) {
	tid := chi.URLParam(r, "id")
	if !api.tournamentExists(r.Context(), tid) {
		writeErr(w, http.StatusNotFound, "not_found", "tournament not found")
		return
	}
	q := `SELECT ` + matchCols + ` FROM matches WHERE tournament_id=?`
	args := []any{tid}
	if s := r.URL.Query().Get("state"); s != "" {
		q += ` AND state=?`
		args = append(args, s)
	}
	q += ` ORDER BY bracket_round, slot`
	rows, err := api.DB.QueryContext(r.Context(), q, args...)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "server_error", "")
		return
	}
	defer rows.Close()
	items := []*Match{}
	for rows.Next() {
		m, err := scanMatch(rows)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "server_error", "")
			return
		}
		items = append(items, m)
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"items": items})
}

// AssignMatch: POST /api/v1/tournaments/{id}/matches/{matchId}/assign (director+).
func (api *API) AssignMatch(w http.ResponseWriter, r *http.Request) {
	tid, mid := chi.URLParam(r, "id"), chi.URLParam(r, "matchId")
	var body struct {
		ScorekeeperUserID string  `json:"scorekeeperUserId"`
		TableRef          *string `json:"tableRef"`
	}
	if !decodeBody(w, r, &body) {
		return
	}
	m, err := api.getMatch(r.Context(), tid, mid)
	if errors.Is(err, sql.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "not_found", "match not found")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "server_error", "")
		return
	}
	if m.State != "scheduled" && m.State != "assigned" {
		writeErr(w, http.StatusConflict, "invalid_transition", "match cannot be assigned from state "+m.State)
		return
	}
	// verify the scorekeeper user holds the scorekeeper role (or director+)
	ok, _ := api.Auth.HasAnyRole(r.Context(), body.ScorekeeperUserID, append([]string{auth.RoleScorekeeper}, auth.DirectorOrAbove...)...)
	if body.ScorekeeperUserID == "" || !ok {
		writeErr(w, http.StatusBadRequest, "invalid_scorekeeper", "scorekeeperUserId must be a user with the scorekeeper role")
		return
	}
	now := time.Now().Unix()
	tx, _ := api.DB.BeginTx(r.Context(), nil)
	defer tx.Rollback()
	// tableRef is optional; COALESCE keeps any existing assignment when omitted.
	if _, err := tx.ExecContext(r.Context(),
		`UPDATE matches SET state='assigned', assigned_scorekeeper_user_id=?, table_ref=COALESCE(?, table_ref), updated_at=?, version=version+1 WHERE id=?`,
		body.ScorekeeperUserID, body.TableRef, now, mid); err != nil {
		writeErr(w, http.StatusInternalServerError, "server_error", "")
		return
	}
	after := map[string]string{"scorekeeper": body.ScorekeeperUserID}
	if body.TableRef != nil {
		after["tableRef"] = *body.TableRef
	}
	_ = audit.Write(r.Context(), tx, audit.Entry{
		EntityType: "match", EntityID: mid, Action: "assigned",
		ActorUserID: actor(r.Context()), RequestID: reqID(r.Context()),
		After: after,
	})
	api.emitEvent(r.Context(), tx, tid, "match.updated", map[string]string{"matchId": mid, "state": "assigned"})
	if err := tx.Commit(); err != nil {
		writeErr(w, http.StatusInternalServerError, "server_error", "")
		return
	}
	nm, _ := api.getMatch(r.Context(), tid, mid)
	writeJSON(w, http.StatusOK, map[string]interface{}{"match": nm})
}

// StartMatch: POST /api/v1/tournaments/{id}/matches/{matchId}/start
// (assigned scorekeeper or director+).
func (api *API) StartMatch(w http.ResponseWriter, r *http.Request) {
	tid, mid := chi.URLParam(r, "id"), chi.URLParam(r, "matchId")
	m, err := api.getMatch(r.Context(), tid, mid)
	if errors.Is(err, sql.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "not_found", "match not found")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "server_error", "")
		return
	}
	if m.State != "assigned" && m.State != "reopened" {
		writeErr(w, http.StatusConflict, "invalid_transition", "match cannot start from state "+m.State)
		return
	}
	if !api.canScoreMatch(r.Context(), m) {
		writeErr(w, http.StatusForbidden, "forbidden", "only the assigned scorekeeper or a director may start this match")
		return
	}
	now := time.Now().Unix()
	tx, _ := api.DB.BeginTx(r.Context(), nil)
	defer tx.Rollback()
	if _, err := tx.ExecContext(r.Context(),
		`UPDATE matches SET state='in_progress', started_at=COALESCE(started_at,?), updated_at=?, version=version+1 WHERE id=?`,
		now, now, mid); err != nil {
		writeErr(w, http.StatusInternalServerError, "server_error", "")
		return
	}
	_ = audit.Write(r.Context(), tx, audit.Entry{
		EntityType: "match", EntityID: mid, Action: "started",
		ActorUserID: actor(r.Context()), RequestID: reqID(r.Context()),
	})
	api.emitEvent(r.Context(), tx, tid, "match.updated", map[string]string{"matchId": mid, "state": "in_progress"})
	if err := tx.Commit(); err != nil {
		writeErr(w, http.StatusInternalServerError, "server_error", "")
		return
	}
	nm, _ := api.getMatch(r.Context(), tid, mid)
	writeJSON(w, http.StatusOK, map[string]interface{}{"match": nm})
}

// canScoreMatch: the assigned scorekeeper, or any director+.
func (api *API) canScoreMatch(ctx context.Context, m *Match) bool {
	uid := actor(ctx)
	if m.Scorekeeper != nil && *m.Scorekeeper == uid {
		return true
	}
	ok, _ := api.Auth.HasAnyRole(ctx, uid, auth.DirectorOrAbove...)
	return ok
}

// MatchHistory: GET /api/v1/tournaments/{id}/matches/{matchId}/history (authenticated).
func (api *API) MatchHistory(w http.ResponseWriter, r *http.Request) {
	tid, mid := chi.URLParam(r, "id"), chi.URLParam(r, "matchId")
	if _, err := api.getMatch(r.Context(), tid, mid); err != nil {
		writeErr(w, http.StatusNotFound, "not_found", "match not found")
		return
	}
	// result versions
	rrows, _ := api.DB.QueryContext(r.Context(),
		`SELECT id, result_version, winner_entrant_id, loser_entrant_id, payload_json, submitted_by, submitted_at, superseded_by
		 FROM match_results WHERE match_id=? ORDER BY result_version`, mid)
	versions := []map[string]interface{}{}
	if rrows != nil {
		defer rrows.Close()
		for rrows.Next() {
			var id, payload string
			var rv int
			var win, lose, by, sup sql.NullString
			var at int64
			_ = rrows.Scan(&id, &rv, &win, &lose, &payload, &by, &at, &sup)
			versions = append(versions, map[string]interface{}{
				"id": id, "resultVersion": rv, "winnerEntrantId": win.String, "loserEntrantId": lose.String,
				"submittedBy": by.String, "submittedAt": at, "supersededBy": sup.String,
			})
		}
	}
	// audit trail
	arows, _ := api.DB.QueryContext(r.Context(),
		`SELECT action, actor_user_id, reason, created_at FROM audit_log WHERE entity_type='match' AND entity_id=? ORDER BY created_at`, mid)
	auditItems := []map[string]interface{}{}
	if arows != nil {
		defer arows.Close()
		for arows.Next() {
			var action string
			var au, reason sql.NullString
			var at int64
			_ = arows.Scan(&action, &au, &reason, &at)
			auditItems = append(auditItems, map[string]interface{}{"action": action, "actor": au.String, "reason": reason.String, "at": at})
		}
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"versions": versions, "audit": auditItems})
}
