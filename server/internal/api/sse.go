package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
)

// emitEvent appends an ordered event for a tournament (called inside the
// mutation's transaction so events and state commit atomically).
func (api *API) emitEvent(ctx context.Context, tx *sql.Tx, tournamentID, eventType string, payload interface{}) {
	b, _ := json.Marshal(payload)
	_, _ = tx.ExecContext(ctx,
		`INSERT INTO sse_event_log (tournament_id, event_type, event_version, payload_json, created_at)
		 VALUES (?,?,1,?,?)`, tournamentID, eventType, string(b), time.Now().Unix())
}

// canViewTournament: public tournaments are viewable unauth; private ones need a
// valid session (06-realtime: "authenticated/public by tournament visibility").
func (api *API) canViewTournament(r *http.Request, id string) (bool, bool) {
	var vis, archived sql.NullString
	err := api.DB.QueryRowContext(r.Context(), `SELECT visibility, archived_at FROM tournaments WHERE id=?`, id).Scan(&vis, &archived)
	if err != nil {
		return false, false // not found
	}
	if vis.String == "public" {
		return true, true
	}
	// private → require a session
	if c, err := r.Cookie("fifteenball_session"); err == nil && c.Value != "" {
		if _, err := api.Auth.LookupSession(r.Context(), c.Value); err == nil {
			return true, true
		}
	}
	return false, true // exists but forbidden
}

// Events: GET /api/v1/tournaments/{id}/events — SSE stream (06-realtime-contract).
// Supports Last-Event-ID (header or ?lastEventId=) for reconnect replay; sends a
// hello event on connect and a heartbeat comment every 15s.
func (api *API) Events(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	ok, found := api.canViewTournament(r, id)
	if !found {
		writeErr(w, http.StatusNotFound, "not_found", "tournament not found")
		return
	}
	if !ok {
		writeErr(w, http.StatusForbidden, "forbidden", "sign in to view this tournament")
		return
	}
	flusher, isFlusher := w.(http.Flusher)
	if !isFlusher {
		writeErr(w, http.StatusInternalServerError, "server_error", "streaming unsupported")
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no") // don't let nginx buffer the stream
	w.WriteHeader(http.StatusOK)

	// starting cursor from Last-Event-ID (reconnect) or ?lastEventId=
	cursor := int64(0)
	if h := r.Header.Get("Last-Event-ID"); h != "" {
		if n, err := strconv.ParseInt(h, 10, 64); err == nil {
			cursor = n
		}
	} else if q := r.URL.Query().Get("lastEventId"); q != "" {
		if n, err := strconv.ParseInt(q, 10, 64); err == nil {
			cursor = n
		}
	}
	var latest int64
	_ = api.DB.QueryRowContext(r.Context(), `SELECT COALESCE(MAX(event_id),0) FROM sse_event_log WHERE tournament_id=?`, id).Scan(&latest)
	if cursor > latest { // stale/invalid reference → client should re-snapshot
		fmt.Fprintf(w, "event: snapshot_required\ndata: {\"latestEventId\":%d}\n\n", latest)
		flusher.Flush()
		cursor = latest
	}
	fmt.Fprintf(w, "event: hello\ndata: {\"latestEventId\":%d}\n\n", latest)
	flusher.Flush()

	poll := time.NewTicker(1 * time.Second)
	defer poll.Stop()
	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()
	ctx := r.Context()
	for {
		select {
		case <-ctx.Done():
			return
		case <-heartbeat.C:
			fmt.Fprint(w, ": keepalive\n\n")
			flusher.Flush()
		case <-poll.C:
			rows, err := api.DB.QueryContext(ctx,
				`SELECT event_id, event_type, payload_json FROM sse_event_log WHERE tournament_id=? AND event_id>? ORDER BY event_id LIMIT 200`, id, cursor)
			if err != nil {
				continue
			}
			for rows.Next() {
				var eid int64
				var etype, payload string
				if err := rows.Scan(&eid, &etype, &payload); err != nil {
					break
				}
				fmt.Fprintf(w, "id: %d\nevent: %s\ndata: %s\n\n", eid, etype, payload)
				cursor = eid
			}
			rows.Close()
			flusher.Flush()
		}
	}
}
