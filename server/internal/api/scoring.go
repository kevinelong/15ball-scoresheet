package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/kevinelong/15ball-scoresheet/server/internal/audit"
)

// withIdempotency wraps a handler that returns (statusCode, responseBody). When
// an Idempotency-Key is present, the first response is cached (7-day TTL) and
// replayed on repeat (05-schema-contract #13, 04-api-contracts idempotency).
func (api *API) withIdempotency(w http.ResponseWriter, r *http.Request, scope string, required bool, fn func() (int, interface{})) {
	key := r.Header.Get("Idempotency-Key")
	if key == "" {
		if required {
			writeErr(w, http.StatusBadRequest, "idempotency_key_required", "this endpoint requires an Idempotency-Key header")
			return
		}
		code, body := fn()
		writeJSON(w, code, body)
		return
	}
	now := time.Now().Unix()
	var respJSON string
	var status int
	var expires int64
	err := api.DB.QueryRowContext(r.Context(),
		`SELECT response_json, status_code, expires_at FROM idempotency_keys WHERE key=? AND scope=?`, key, scope).
		Scan(&respJSON, &status, &expires)
	if err == nil && expires > now {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(respJSON))
		return
	}
	code, body := fn()
	b, _ := json.Marshal(body)
	_, _ = api.DB.ExecContext(r.Context(),
		`INSERT OR REPLACE INTO idempotency_keys (key, scope, request_hash, response_json, status_code, created_at, expires_at)
		 VALUES (?,?,?,?,?,?,?)`, key, scope, "", string(b), code, now, now+7*86400)
	writeJSON(w, code, body)
}

// SubmitResult: POST /api/v1/tournaments/{id}/matches/{matchId}/result
// (assigned scorekeeper or director+). Idempotency-Key REQUIRED.
func (api *API) SubmitResult(w http.ResponseWriter, r *http.Request) {
	tid, mid := chi.URLParam(r, "id"), chi.URLParam(r, "matchId")
	var body struct {
		WinnerEntrantID string          `json:"winnerEntrantId"`
		LoserEntrantID  string          `json:"loserEntrantId"`
		Score           json.RawMessage `json:"score"`
	}
	if !decodeBody(w, r, &body) {
		return
	}
	api.withIdempotency(w, r, "result:"+mid, true, func() (int, interface{}) {
		m, err := api.getMatch(r.Context(), tid, mid)
		if errors.Is(err, sql.ErrNoRows) {
			return http.StatusNotFound, errBody("not_found", "match not found")
		}
		if err != nil {
			return http.StatusInternalServerError, errBody("server_error", "")
		}
		if m.State != "in_progress" && m.State != "reopened" {
			return http.StatusConflict, errBody("invalid_transition", "match is not in progress")
		}
		if !api.canScoreMatch(r.Context(), m) {
			return http.StatusForbidden, errBody("forbidden", "only the assigned scorekeeper or a director may submit")
		}
		// winner/loser must be the match's two entrants
		if !validPair(m, body.WinnerEntrantID, body.LoserEntrantID) {
			return http.StatusBadRequest, errBody("invalid_result", "winner/loser must be this match's two entrants")
		}
		now := time.Now().Unix()
		tx, _ := api.DB.BeginTx(r.Context(), nil)
		defer tx.Rollback()
		// next result version
		var maxV sql.NullInt64
		_ = tx.QueryRowContext(r.Context(), `SELECT MAX(result_version) FROM match_results WHERE match_id=?`, mid).Scan(&maxV)
		rv := int(maxV.Int64) + 1
		payload := string(body.Score)
		if payload == "" {
			payload = "{}"
		}
		if _, err := tx.ExecContext(r.Context(),
			`INSERT INTO match_results (id, match_id, result_version, winner_entrant_id, loser_entrant_id, payload_json, submitted_by, submitted_at)
			 VALUES (?,?,?,?,?,?,?,?)`,
			newID("res_"), mid, rv, body.WinnerEntrantID, body.LoserEntrantID, payload, actor(r.Context()), now); err != nil {
			return http.StatusInternalServerError, errBody("server_error", "")
		}
		if _, err := tx.ExecContext(r.Context(),
			`UPDATE matches SET state='completed', completed_at=?, updated_at=?, version=version+1 WHERE id=?`, now, now, mid); err != nil {
			return http.StatusInternalServerError, errBody("server_error", "")
		}
		// mark the loser eliminated (system-driven)
		_, _ = tx.ExecContext(r.Context(),
			`UPDATE entrants SET state='eliminated', updated_at=? WHERE id=? AND state='checked_in'`, now, body.LoserEntrantID)
		// advance the winner into the next round
		if err := api.advanceBracket(r.Context(), tx, m, body.WinnerEntrantID); err != nil {
			return http.StatusInternalServerError, errBody("server_error", "")
		}
		_ = audit.Write(r.Context(), tx, audit.Entry{
			EntityType: "match", EntityID: mid, Action: "result_submitted",
			ActorUserID: actor(r.Context()), RequestID: reqID(r.Context()),
			After: map[string]interface{}{"winner": body.WinnerEntrantID, "resultVersion": rv},
		})
		// outbox enqueue for Challonge sync is added in Slice G.
		if err := tx.Commit(); err != nil {
			return http.StatusInternalServerError, errBody("server_error", "")
		}
		nm, _ := api.getMatch(r.Context(), tid, mid)
		return http.StatusOK, map[string]interface{}{"match": nm, "resultVersion": rv}
	})
}

// ReopenMatch: POST /api/v1/tournaments/{id}/matches/{matchId}/reopen (director+).
// Reason + Idempotency-Key REQUIRED.
func (api *API) ReopenMatch(w http.ResponseWriter, r *http.Request) {
	tid, mid := chi.URLParam(r, "id"), chi.URLParam(r, "matchId")
	var body struct {
		Reason string `json:"reason"`
	}
	if !decodeBody(w, r, &body) {
		return
	}
	api.withIdempotency(w, r, "reopen:"+mid, true, func() (int, interface{}) {
		if body.Reason == "" {
			return http.StatusBadRequest, errBody("reason_required", "reopening a match requires a reason")
		}
		m, err := api.getMatch(r.Context(), tid, mid)
		if errors.Is(err, sql.ErrNoRows) {
			return http.StatusNotFound, errBody("not_found", "match not found")
		}
		if err != nil {
			return http.StatusInternalServerError, errBody("server_error", "")
		}
		if m.State != "completed" {
			return http.StatusConflict, errBody("invalid_transition", "only a completed match can be reopened")
		}
		now := time.Now().Unix()
		tx, _ := api.DB.BeginTx(r.Context(), nil)
		defer tx.Rollback()
		// mark the latest result as the reopen origin
		var latestResult sql.NullString
		_ = tx.QueryRowContext(r.Context(), `SELECT id FROM match_results WHERE match_id=? ORDER BY result_version DESC LIMIT 1`, mid).Scan(&latestResult)
		if _, err := tx.ExecContext(r.Context(),
			`UPDATE matches SET state='reopened', reopened_from_result_id=?, updated_at=?, version=version+1 WHERE id=?`,
			latestResult, now, mid); err != nil {
			return http.StatusInternalServerError, errBody("server_error", "")
		}
		_ = audit.Write(r.Context(), tx, audit.Entry{
			EntityType: "match", EntityID: mid, Action: "reopened",
			ActorUserID: actor(r.Context()), Reason: body.Reason, RequestID: reqID(r.Context()),
			Before: map[string]string{"state": "completed"},
		})
		if err := tx.Commit(); err != nil {
			return http.StatusInternalServerError, errBody("server_error", "")
		}
		nm, _ := api.getMatch(r.Context(), tid, mid)
		return http.StatusOK, map[string]interface{}{"match": nm}
	})
}

// advanceBracket moves the winner into the next round. If the current round has a
// single match it is the final (no advancement). Byes for non-power-of-2 fields
// are a later refinement.
func (api *API) advanceBracket(ctx context.Context, tx *sql.Tx, m *Match, winnerID string) error {
	var roundCount int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM matches WHERE tournament_id=? AND bracket_round=?`, m.TournamentID, m.BracketRound).Scan(&roundCount); err != nil {
		return err
	}
	if roundCount <= 1 {
		return nil // final: winner is champion
	}
	nextRound := m.BracketRound + 1
	nextSlot := m.Slot / 2
	col := "entrant_a_id"
	if m.Slot%2 == 1 {
		col = "entrant_b_id"
	}
	var nextID string
	err := tx.QueryRowContext(ctx, `SELECT id FROM matches WHERE tournament_id=? AND bracket_round=? AND slot=?`, m.TournamentID, nextRound, nextSlot).Scan(&nextID)
	now := time.Now().Unix()
	if errors.Is(err, sql.ErrNoRows) {
		_, err = tx.ExecContext(ctx,
			`INSERT INTO matches (id, tournament_id, bracket_round, slot, `+col+`, state, created_at, updated_at)
			 VALUES (?,?,?,?,?, 'scheduled', ?, ?)`,
			newID("mch_"), m.TournamentID, nextRound, nextSlot, winnerID, now, now)
		return err
	}
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `UPDATE matches SET `+col+`=?, updated_at=? WHERE id=?`, winnerID, now, nextID)
	return err
}

func validPair(m *Match, winner, loser string) bool {
	if winner == "" || loser == "" || winner == loser {
		return false
	}
	a, b := "", ""
	if m.EntrantAID != nil {
		a = *m.EntrantAID
	}
	if m.EntrantBID != nil {
		b = *m.EntrantBID
	}
	return (winner == a && loser == b) || (winner == b && loser == a)
}

func errBody(code, msg string) map[string]interface{} {
	return map[string]interface{}{"error": map[string]string{"code": code, "message": msg}}
}
