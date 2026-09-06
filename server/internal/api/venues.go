package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/kevinelong/15ball-scoresheet/server/internal/audit"
)

// Venue is an organizer-scoped location (a tournament's created_by is the
// organizer). address is free-text; lat/lng are a best-effort geocode and may be
// null when geocoding failed or was skipped.
type Venue struct {
	ID              string   `json:"id"`
	OrganizerUserID string   `json:"organizerUserId"`
	Name            string   `json:"name"`
	Address         *string  `json:"address"`
	Lat             *float64 `json:"lat"`
	Lng             *float64 `json:"lng"`
	CreatedAt       int64    `json:"createdAt"`
	UpdatedAt       int64    `json:"updatedAt"`
}

const venueCols = `id, organizer_user_id, name, address, lat, lng, created_at, updated_at`

func scanVenue(row interface{ Scan(...any) error }) (*Venue, error) {
	var v Venue
	err := row.Scan(&v.ID, &v.OrganizerUserID, &v.Name, &v.Address, &v.Lat, &v.Lng, &v.CreatedAt, &v.UpdatedAt)
	return &v, err
}

// geocode is a best-effort address → lat/lng lookup via OpenStreetMap Nominatim.
// It never fails a request: on ANY error/empty response it returns ok=false and
// the caller stores the address with NULL lat/lng. One call per venue create; no
// retry loop. Nominatim usage policy requires an identifying User-Agent.
func geocode(ctx context.Context, address string) (lat, lng float64, ok bool) {
	if address == "" {
		return 0, 0, false
	}
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	u := "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=" + url.QueryEscape(address)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return 0, 0, false
	}
	req.Header.Set("User-Agent", "fifteenball/1.0 (https://codeonline.io/15ball; kevinelong@gmail.com)")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return 0, 0, false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 0, 0, false
	}
	var results []struct {
		Lat string `json:"lat"`
		Lon string `json:"lon"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&results); err != nil || len(results) == 0 {
		return 0, 0, false
	}
	la, err1 := strconv.ParseFloat(results[0].Lat, 64)
	ln, err2 := strconv.ParseFloat(results[0].Lon, 64)
	if err1 != nil || err2 != nil {
		return 0, 0, false
	}
	return la, ln, true
}

// getVenue resolves a venue by id, scoped to organizer.
func (api *API) getVenue(ctx context.Context, id, org string) (*Venue, error) {
	row := api.DB.QueryRowContext(ctx, `SELECT `+venueCols+` FROM venues WHERE id = ? AND organizer_user_id = ?`, id, org)
	return scanVenue(row)
}

// CreateVenue: POST /api/v1/venues (director+). Body {name, address?, lat?, lng?}.
// The venue is scoped to the creating director (actor). If lat/lng are not
// supplied but an address is, it is geocoded best-effort (failure is non-fatal —
// the address is still saved with NULL lat/lng).
func (api *API) CreateVenue(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name    string   `json:"name"`
		Address string   `json:"address"`
		Lat     *float64 `json:"lat"`
		Lng     *float64 `json:"lng"`
	}
	if !decodeBody(w, r, &body) {
		return
	}
	if len(body.Name) == 0 || len(body.Name) > 200 {
		writeErr(w, http.StatusBadRequest, "invalid_name", "name is required (1-200 chars)")
		return
	}
	if len(body.Address) > 500 {
		writeErr(w, http.StatusBadRequest, "invalid_address", "address must be 500 chars or fewer")
		return
	}
	org := actor(r.Context())
	lat, lng := body.Lat, body.Lng
	// Geocode only when coordinates were not supplied and we have an address.
	if lat == nil && lng == nil && body.Address != "" {
		if la, ln, ok := geocode(r.Context(), body.Address); ok {
			lat, lng = &la, &ln
		}
	}
	now := time.Now().Unix()
	id := newID("ven_")
	tx, _ := api.DB.BeginTx(r.Context(), nil)
	defer tx.Rollback()
	if _, err := tx.ExecContext(r.Context(),
		`INSERT INTO venues (id, organizer_user_id, name, address, lat, lng, created_at, updated_at)
		 VALUES (?,?,?,?,?,?,?,?)`,
		id, org, body.Name, nullIfEmpty(body.Address), lat, lng, now, now); err != nil {
		writeErr(w, http.StatusInternalServerError, "server_error", "")
		return
	}
	_ = audit.Write(r.Context(), tx, audit.Entry{
		EntityType: "venue", EntityID: id, Action: "created",
		ActorUserID: org, RequestID: reqID(r.Context()),
		After: map[string]interface{}{"name": body.Name},
	})
	if err := tx.Commit(); err != nil {
		writeErr(w, http.StatusInternalServerError, "server_error", "")
		return
	}
	v, _ := api.getVenue(r.Context(), id, org)
	writeJSON(w, http.StatusCreated, map[string]interface{}{"venue": v})
}

// ListVenues: GET /api/v1/venues (session). Returns the caller's venues ordered
// by name (organizer = the caller's user id).
func (api *API) ListVenues(w http.ResponseWriter, r *http.Request) {
	org := actor(r.Context())
	rows, err := api.DB.QueryContext(r.Context(),
		`SELECT `+venueCols+` FROM venues WHERE organizer_user_id = ? ORDER BY name COLLATE NOCASE, id`, org)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "server_error", "")
		return
	}
	defer rows.Close()
	items := []*Venue{}
	for rows.Next() {
		v, err := scanVenue(rows)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "server_error", "")
			return
		}
		items = append(items, v)
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"items": items})
}

// RecentPlayersAtVenue: GET /api/v1/tournaments/{id}/recent-players (session).
// DISTINCT players who played this organizer's OTHER tournaments at the SAME
// venue (exact venue_id match, no radius), excluding players already entered in
// this tournament. If the tournament has no venue_id, returns an empty list.
func (api *API) RecentPlayersAtVenue(w http.ResponseWriter, r *http.Request) {
	tid := chi.URLParam(r, "id")
	var org string
	var venueID *string
	err := api.DB.QueryRowContext(r.Context(),
		`SELECT created_by, venue_id FROM tournaments WHERE id = ?`, tid).Scan(&org, &venueID)
	if errors.Is(err, sql.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "not_found", "tournament not found")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "server_error", "")
		return
	}
	if venueID == nil || *venueID == "" {
		writeJSON(w, http.StatusOK, map[string]interface{}{"items": []interface{}{}})
		return
	}
	rows, err := api.DB.QueryContext(r.Context(),
		`SELECT DISTINCT p.id, p.display_name, p.phone, p.email, p.fargo
		   FROM players p
		   JOIN entrants e ON e.player_id = p.id
		   JOIN tournaments t ON t.id = e.tournament_id
		  WHERE t.venue_id = ?
		    AND t.created_by = ?
		    AND t.id != ?
		    AND p.organizer_user_id = ?
		    AND p.id NOT IN (
		          SELECT player_id FROM entrants
		           WHERE tournament_id = ? AND player_id IS NOT NULL
		        )
		  ORDER BY p.display_name COLLATE NOCASE, p.id`,
		*venueID, org, tid, org, tid)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "server_error", "")
		return
	}
	defer rows.Close()
	items := []map[string]interface{}{}
	for rows.Next() {
		var pid, name string
		var phone, email *string
		var fargo *int64
		if err := rows.Scan(&pid, &name, &phone, &email, &fargo); err != nil {
			writeErr(w, http.StatusInternalServerError, "server_error", "")
			return
		}
		items = append(items, map[string]interface{}{
			"playerId":    pid,
			"displayName": name,
			"phone":       phone,
			"email":       email,
			"fargo":       fargo,
		})
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"items": items})
}
