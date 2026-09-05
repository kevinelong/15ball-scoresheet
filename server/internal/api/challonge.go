package api

import (
	"database/sql"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/kevinelong/15ball-scoresheet/server/internal/syncer"
)

// StartSync: POST /api/v1/tournaments/{id}/challonge/sync (director+).
// Idempotency-Key REQUIRED. 202 on enqueue, 409 if a sync is already active.
func (api *API) StartSync(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if !api.tournamentExists(r.Context(), id) {
		writeErr(w, http.StatusNotFound, "not_found", "tournament not found")
		return
	}
	key := r.Header.Get("Idempotency-Key")
	if key == "" {
		writeErr(w, http.StatusBadRequest, "idempotency_key_required", "this endpoint requires an Idempotency-Key header")
		return
	}
	jobID, ok, err := syncer.Enqueue(r.Context(), api.DB, id, key)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "server_error", "")
		return
	}
	if !ok {
		writeErr(w, http.StatusConflict, "sync_in_progress", "a sync is already in progress for this tournament")
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]interface{}{"jobId": jobID, "status": "pending"})
}

// SyncStatus: GET /api/v1/tournaments/{id}/challonge/sync (authenticated).
func (api *API) SyncStatus(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var syncState, provURL, lastErr sql.NullString
	var lastSynced sql.NullInt64
	err := api.DB.QueryRowContext(r.Context(),
		`SELECT sync_state, provider_url, last_synced_at, last_error FROM challonge_tournaments WHERE tournament_id=?`, id).
		Scan(&syncState, &provURL, &lastSynced, &lastErr)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]interface{}{"status": "not_synced"})
		return
	}
	var jobStatus sql.NullString
	_ = api.DB.QueryRowContext(r.Context(),
		`SELECT status FROM outbox_jobs WHERE aggregate_id=? ORDER BY created_at DESC LIMIT 1`, id).Scan(&jobStatus)
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"status": syncState.String, "providerUrl": provURL.String,
		"lastSyncedAt": lastSynced.Int64, "lastError": lastErr.String, "jobStatus": jobStatus.String,
	})
}

// Reconcile: POST /api/v1/tournaments/{id}/challonge/reconcile (director+).
// v1: reports the diff between local entrants and mapped participants (dry-run).
func (api *API) Reconcile(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if !api.tournamentExists(r.Context(), id) {
		writeErr(w, http.StatusNotFound, "not_found", "tournament not found")
		return
	}
	var localEntrants, mapped int
	_ = api.DB.QueryRowContext(r.Context(), `SELECT COUNT(*) FROM entrants WHERE tournament_id=? AND archived_at IS NULL`, id).Scan(&localEntrants)
	_ = api.DB.QueryRowContext(r.Context(), `SELECT COUNT(*) FROM challonge_participant_map WHERE tournament_id=?`, id).Scan(&mapped)
	differences := []map[string]interface{}{}
	actions := []string{}
	if localEntrants > mapped {
		differences = append(differences, map[string]interface{}{"kind": "participants", "local": localEntrants, "provider": mapped})
		actions = append(actions, "create")
	} else if localEntrants == mapped {
		actions = append(actions, "noop")
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"differences": differences, "actions": actions, "dryRun": true})
}
