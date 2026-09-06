package api

import (
	"context"
	"database/sql"
	"errors"
	"log"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/kevinelong/15ball-scoresheet/server/internal/audit"
)

// Player is a cross-event identity scoped to an organizer (a tournament's
// created_by). Entrants link to a player so the same person is recognized across
// that organizer's tournaments.
type Player struct {
	ID              string  `json:"id"`
	OrganizerUserID string  `json:"organizerUserId"`
	DisplayName     string  `json:"displayName"`
	NameKey         string  `json:"nameKey"`
	Phone           *string `json:"phone"`
	Email           *string `json:"email"`
	Fargo           *int64  `json:"fargo"`
	ExternalID      *string `json:"externalId"`
	CreatedAt       int64   `json:"createdAt"`
	UpdatedAt       int64   `json:"updatedAt"`
}

const playerCols = `id, organizer_user_id, display_name, name_key, phone, email, fargo, external_id, created_at, updated_at`

func scanPlayer(row interface{ Scan(...any) error }) (*Player, error) {
	var p Player
	err := row.Scan(&p.ID, &p.OrganizerUserID, &p.DisplayName, &p.NameKey, &p.Phone, &p.Email, &p.Fargo, &p.ExternalID, &p.CreatedAt, &p.UpdatedAt)
	return &p, err
}

var nameKeyRe = regexp.MustCompile(`[^a-z0-9]+`)

// normalizeName collapses a display name to a comparison key: lowercase, keep
// only [a-z0-9], no separators. e.g. "Jane  D'oe" -> "janedoe".
func normalizeName(s string) string {
	return nameKeyRe.ReplaceAllString(strings.ToLower(s), "")
}

// e164 mirrors the frontend Roster.e164: a 10-digit number becomes +1XXXXXXXXXX,
// an 11-digit with leading 1 becomes +1…, an already-+ value is kept (digits/+
// only), anything else is returned as-is.
var e164NonDigit = regexp.MustCompile(`\D`)
var e164NonDigitPlus = regexp.MustCompile(`[^\d+]`)

func e164(s string) string {
	if s == "" {
		return s
	}
	if s[0] == '+' {
		return e164NonDigitPlus.ReplaceAllString(s, "")
	}
	d := e164NonDigit.ReplaceAllString(s, "")
	if len(d) == 10 {
		return "+1" + d
	}
	if len(d) == 11 && d[0] == '1' {
		return "+" + d
	}
	return s
}

// levenshtein is a simple DP edit distance between two strings.
func levenshtein(a, b string) int {
	ra, rb := []rune(a), []rune(b)
	la, lb := len(ra), len(rb)
	if la == 0 {
		return lb
	}
	if lb == 0 {
		return la
	}
	prev := make([]int, lb+1)
	cur := make([]int, lb+1)
	for j := 0; j <= lb; j++ {
		prev[j] = j
	}
	for i := 1; i <= la; i++ {
		cur[0] = i
		for j := 1; j <= lb; j++ {
			cost := 1
			if ra[i-1] == rb[j-1] {
				cost = 0
			}
			del := prev[j] + 1
			ins := cur[j-1] + 1
			sub := prev[j-1] + cost
			m := del
			if ins < m {
				m = ins
			}
			if sub < m {
				m = sub
			}
			cur[j] = m
		}
		prev, cur = cur, prev
	}
	return prev[lb]
}

// nameSimilarity returns 1 - dist/maxLen over the normalized name keys.
func nameSimilarity(aKey, bKey string) float64 {
	if aKey == "" || bKey == "" {
		return 0
	}
	maxLen := len([]rune(aKey))
	if l := len([]rune(bKey)); l > maxLen {
		maxLen = l
	}
	if maxLen == 0 {
		return 0
	}
	return 1 - float64(levenshtein(aKey, bKey))/float64(maxLen)
}

// tournamentOrganizer returns the created_by (organizer) user id for a tournament.
func (api *API) tournamentOrganizer(ctx context.Context, q interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}, tid string) (string, error) {
	var org string
	err := q.QueryRowContext(ctx, `SELECT created_by FROM tournaments WHERE id = ?`, tid).Scan(&org)
	return org, err
}

// tournamentVenueID returns the venue_id for a tournament, or "" when the
// tournament has no venue (nullable column) or on error.
func (api *API) tournamentVenueID(ctx context.Context, q interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}, tid string) string {
	var v sql.NullString
	_ = q.QueryRowContext(ctx, `SELECT venue_id FROM tournaments WHERE id = ?`, tid).Scan(&v)
	if v.Valid {
		return v.String
	}
	return ""
}

// ensurePlayerForEntrant links an entrant to a player inside tx. If wantPlayerID
// is non-nil it verifies that player belongs to organizer and reuses it
// (backfilling empty contact fields from the entrant); otherwise it creates a new
// player from the entrant's fields. Returns the linked player id.
func (api *API) ensurePlayerForEntrant(ctx context.Context, tx *sql.Tx, org, entrantID, displayName string, phone, email, externalID *string, fargo *int64, wantPlayerID *string) (string, error) {
	now := time.Now().Unix()
	if wantPlayerID != nil && *wantPlayerID != "" {
		var p Player
		row := tx.QueryRowContext(ctx, `SELECT `+playerCols+` FROM players WHERE id = ? AND organizer_user_id = ?`, *wantPlayerID, org)
		got, err := scanPlayer(row)
		if err != nil {
			return "", err
		}
		p = *got
		// backfill empty contact fields from the entrant
		sets := []string{}
		args := []any{}
		if (p.Phone == nil || *p.Phone == "") && phone != nil && *phone != "" {
			sets = append(sets, "phone = ?")
			args = append(args, *phone)
		}
		if (p.Email == nil || *p.Email == "") && email != nil && *email != "" {
			sets = append(sets, "email = ?")
			args = append(args, *email)
		}
		if p.Fargo == nil && fargo != nil {
			sets = append(sets, "fargo = ?")
			args = append(args, *fargo)
		}
		if (p.ExternalID == nil || *p.ExternalID == "") && externalID != nil && *externalID != "" {
			sets = append(sets, "external_id = ?")
			args = append(args, *externalID)
		}
		if len(sets) > 0 {
			sets = append(sets, "updated_at = ?")
			args = append(args, now, p.ID)
			if _, err := tx.ExecContext(ctx, `UPDATE players SET `+strings.Join(sets, ", ")+` WHERE id = ?`, args...); err != nil {
				return "", err
			}
		}
		if _, err := tx.ExecContext(ctx, `UPDATE entrants SET player_id = ? WHERE id = ?`, p.ID, entrantID); err != nil {
			return "", err
		}
		return p.ID, nil
	}
	// create a new player for this organizer
	pid := newID("plr_")
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO players (id, organizer_user_id, display_name, name_key, phone, email, fargo, external_id, created_at, updated_at)
		 VALUES (?,?,?,?,?,?,?,?,?,?)`,
		pid, org, displayName, normalizeName(displayName), phone, email, fargo, externalID, now, now); err != nil {
		return "", err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE entrants SET player_id = ? WHERE id = ?`, pid, entrantID); err != nil {
		return "", err
	}
	return pid, nil
}

// suggestPlayers returns up to limit candidate players for an organizer, ranked
// by match strength against the (name, phone, email) query. Each item carries
// decision context: matchReason ("phone"|"email"|"name"), pastEntries, and the
// most recent tournament the player entered (lastEvent / lastEventAt), and
// sameVenue (whether the candidate has played the current tournament's venue
// before). Shared by the single and batch suggestion handlers so behavior is
// identical. venueID is the current tournament's venue_id ("" when it has none);
// when empty, sameVenue is always false.
func (api *API) suggestPlayers(ctx context.Context, org, name, phone, email, venueID string, limit int) ([]map[string]interface{}, error) {
	name = strings.TrimSpace(name)
	phone = strings.TrimSpace(phone)
	email = strings.ToLower(strings.TrimSpace(email))
	nameKey := normalizeName(name)
	phoneKey := ""
	if phone != "" {
		phoneKey = e164(phone)
	}

	rows, err := api.DB.QueryContext(ctx, `SELECT `+playerCols+` FROM players WHERE organizer_user_id = ?`, org)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	type cand struct {
		p      *Player
		score  float64
		reason string
	}
	cands := []cand{}
	for rows.Next() {
		p, err := scanPlayer(rows)
		if err != nil {
			return nil, err
		}
		score := 0.0
		reason := "name"
		// strong: exact phone (E.164) or lowercased email match
		if phoneKey != "" && p.Phone != nil && e164(*p.Phone) == phoneKey {
			score = 1.0
			reason = "phone"
		}
		if email != "" && p.Email != nil && strings.ToLower(*p.Email) == email {
			score = 1.0
			if reason != "phone" {
				reason = "email"
			}
		}
		// fuzzy name
		if nameKey != "" {
			if s := nameSimilarity(nameKey, p.NameKey); s > score {
				score = s
				reason = "name"
			}
		}
		// keep strong matches unconditionally; otherwise require the fuzzy threshold
		if score >= 1.0 || (nameKey != "" && nameSimilarity(nameKey, p.NameKey) >= 0.72) {
			cands = append(cands, cand{p: p, score: score, reason: reason})
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	sort.SliceStable(cands, func(i, j int) bool { return cands[i].score > cands[j].score })
	if limit > 0 && len(cands) > limit {
		cands = cands[:limit]
	}

	items := make([]map[string]interface{}, 0, len(cands))
	for _, c := range cands {
		var past int
		_ = api.DB.QueryRowContext(ctx, `SELECT COUNT(*) FROM entrants WHERE player_id = ?`, c.p.ID).Scan(&past)
		// most recent tournament this player entered (by tournaments.created_at desc)
		lastEvent := ""
		var lastEventAt int64
		var ln sql.NullString
		var lat sql.NullInt64
		_ = api.DB.QueryRowContext(ctx,
			`SELECT t.name, t.created_at FROM entrants e JOIN tournaments t ON t.id = e.tournament_id
			 WHERE e.player_id = ? ORDER BY t.created_at DESC LIMIT 1`, c.p.ID).Scan(&ln, &lat)
		if ln.Valid {
			lastEvent = ln.String
		}
		if lat.Valid {
			lastEventAt = lat.Int64
		}
		// sameVenue: has this candidate played the current tournament's venue before?
		sameVenue := false
		if venueID != "" {
			var one int
			if err := api.DB.QueryRowContext(ctx,
				`SELECT 1 FROM entrants e JOIN tournaments t ON t.id = e.tournament_id
				 WHERE e.player_id = ? AND t.venue_id = ? LIMIT 1`, c.p.ID, venueID).Scan(&one); err == nil {
				sameVenue = true
			}
		}
		items = append(items, map[string]interface{}{
			"playerId":    c.p.ID,
			"displayName": c.p.DisplayName,
			"phone":       c.p.Phone,
			"email":       c.p.Email,
			"fargo":       c.p.Fargo,
			"score":       c.score,
			"pastEntries": past,
			"matchReason": c.reason,
			"lastEvent":   lastEvent,
			"lastEventAt": lastEventAt,
			"sameVenue":   sameVenue,
		})
	}
	return items, nil
}

// PlayerSuggestions: GET /api/v1/tournaments/{id}/player-suggestions?name=&phone=&email=
// (session-required). Returns up to 6 candidate players for this tournament's
// organizer ranked by match strength.
func (api *API) PlayerSuggestions(w http.ResponseWriter, r *http.Request) {
	tid := chi.URLParam(r, "id")
	if !api.tournamentExists(r.Context(), tid) {
		writeErr(w, http.StatusNotFound, "not_found", "tournament not found")
		return
	}
	org, err := api.tournamentOrganizer(r.Context(), api.DB, tid)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "server_error", "")
		return
	}
	venueID := api.tournamentVenueID(r.Context(), api.DB, tid)
	items, err := api.suggestPlayers(r.Context(),
		org,
		r.URL.Query().Get("name"),
		r.URL.Query().Get("phone"),
		r.URL.Query().Get("email"),
		venueID,
		6)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "server_error", "")
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"items": items})
}

// PlayerSuggestionsBatch: POST /api/v1/tournaments/{id}/player-suggestions/batch
// (session-required). Body {"queries":[{"key","name","phone","email"}]} (cap 300).
// Returns {"results": {"<key>": [<top ~5 items>]}} using the same matching logic
// as the single endpoint. For the bulk-paste dedup preview.
func (api *API) PlayerSuggestionsBatch(w http.ResponseWriter, r *http.Request) {
	tid := chi.URLParam(r, "id")
	if !api.tournamentExists(r.Context(), tid) {
		writeErr(w, http.StatusNotFound, "not_found", "tournament not found")
		return
	}
	var body struct {
		Queries []struct {
			Key   string `json:"key"`
			Name  string `json:"name"`
			Phone string `json:"phone"`
			Email string `json:"email"`
		} `json:"queries"`
	}
	if !decodeBody(w, r, &body) {
		return
	}
	if len(body.Queries) > 300 {
		writeErr(w, http.StatusBadRequest, "too_many", "at most 300 queries per batch")
		return
	}
	org, err := api.tournamentOrganizer(r.Context(), api.DB, tid)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "server_error", "")
		return
	}
	venueID := api.tournamentVenueID(r.Context(), api.DB, tid)
	results := make(map[string][]map[string]interface{}, len(body.Queries))
	for _, q := range body.Queries {
		if q.Key == "" {
			continue
		}
		items, err := api.suggestPlayers(r.Context(), org, q.Name, q.Phone, q.Email, venueID, 5)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "server_error", "")
			return
		}
		results[q.Key] = items
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"results": results})
}

// MergePlayers: POST /api/v1/players/{id}/merge  body {"intoId":"<player id>"}
// (director+). Repoints entrants, backfills contact fields, deletes the source.
func (api *API) MergePlayers(w http.ResponseWriter, r *http.Request) {
	srcID := chi.URLParam(r, "id")
	var body struct {
		IntoID string `json:"intoId"`
	}
	if !decodeBody(w, r, &body) {
		return
	}
	if body.IntoID == "" || body.IntoID == srcID {
		writeErr(w, http.StatusBadRequest, "invalid_merge", "intoId is required and must differ from the source player")
		return
	}
	tx, _ := api.DB.BeginTx(r.Context(), nil)
	defer tx.Rollback()

	src, err := scanPlayer(tx.QueryRowContext(r.Context(), `SELECT `+playerCols+` FROM players WHERE id = ?`, srcID))
	if errors.Is(err, sql.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "not_found", "source player not found")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "server_error", "")
		return
	}
	into, err := scanPlayer(tx.QueryRowContext(r.Context(), `SELECT `+playerCols+` FROM players WHERE id = ?`, body.IntoID))
	if errors.Is(err, sql.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "not_found", "target player not found")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "server_error", "")
		return
	}
	if src.OrganizerUserID != into.OrganizerUserID {
		writeErr(w, http.StatusBadRequest, "invalid_merge", "players belong to different organizers")
		return
	}
	now := time.Now().Unix()
	if _, err := tx.ExecContext(r.Context(), `UPDATE entrants SET player_id = ? WHERE player_id = ?`, into.ID, src.ID); err != nil {
		writeErr(w, http.StatusInternalServerError, "server_error", "")
		return
	}
	// backfill empty target contact fields from the source
	sets := []string{}
	args := []any{}
	if (into.Phone == nil || *into.Phone == "") && src.Phone != nil && *src.Phone != "" {
		sets = append(sets, "phone = ?")
		args = append(args, *src.Phone)
	}
	if (into.Email == nil || *into.Email == "") && src.Email != nil && *src.Email != "" {
		sets = append(sets, "email = ?")
		args = append(args, *src.Email)
	}
	if into.Fargo == nil && src.Fargo != nil {
		sets = append(sets, "fargo = ?")
		args = append(args, *src.Fargo)
	}
	if (into.ExternalID == nil || *into.ExternalID == "") && src.ExternalID != nil && *src.ExternalID != "" {
		sets = append(sets, "external_id = ?")
		args = append(args, *src.ExternalID)
	}
	if len(sets) > 0 {
		sets = append(sets, "updated_at = ?")
		args = append(args, now, into.ID)
		if _, err := tx.ExecContext(r.Context(), `UPDATE players SET `+strings.Join(sets, ", ")+` WHERE id = ?`, args...); err != nil {
			writeErr(w, http.StatusInternalServerError, "server_error", "")
			return
		}
	}
	if _, err := tx.ExecContext(r.Context(), `DELETE FROM players WHERE id = ?`, src.ID); err != nil {
		writeErr(w, http.StatusInternalServerError, "server_error", "")
		return
	}
	_ = audit.Write(r.Context(), tx, audit.Entry{
		EntityType: "player", EntityID: into.ID, Action: "merged",
		ActorUserID: actor(r.Context()), RequestID: reqID(r.Context()),
		After: map[string]interface{}{"mergedFrom": src.ID},
	})
	if err := tx.Commit(); err != nil {
		writeErr(w, http.StatusInternalServerError, "server_error", "")
		return
	}
	p, _ := scanPlayer(api.DB.QueryRowContext(r.Context(), `SELECT `+playerCols+` FROM players WHERE id = ?`, into.ID))
	writeJSON(w, http.StatusOK, map[string]interface{}{"player": p})
}

// canonPair returns the two ids in canonical (lexicographic) order so an
// unordered pair has a single stable key: a = min, b = max.
func canonPair(id1, id2 string) (string, string) {
	if id1 <= id2 {
		return id1, id2
	}
	return id2, id1
}

// nameDupThreshold is the normalized-name similarity at/above which a pair is a
// likely duplicate (organizer-wide review). Strong phone/email matches always win.
const nameDupThreshold = 0.80

// dupScanCap bounds the O(n²) pairwise scan for very large pools; realistic
// organizer pools are small. Above this we still work but cap the scan.
const dupScanCap = 1500

// playerItem enriches a Player with decision context (pastEntries, lastEvent),
// reusing the same shape as suggestPlayers items minus score/reason.
func (api *API) playerItem(ctx context.Context, p *Player) map[string]interface{} {
	var past int
	_ = api.DB.QueryRowContext(ctx, `SELECT COUNT(*) FROM entrants WHERE player_id = ?`, p.ID).Scan(&past)
	lastEvent := ""
	var ln sql.NullString
	_ = api.DB.QueryRowContext(ctx,
		`SELECT t.name FROM entrants e JOIN tournaments t ON t.id = e.tournament_id
		 WHERE e.player_id = ? ORDER BY t.created_at DESC LIMIT 1`, p.ID).Scan(&ln)
	if ln.Valid {
		lastEvent = ln.String
	}
	return map[string]interface{}{
		"playerId":    p.ID,
		"displayName": p.DisplayName,
		"phone":       p.Phone,
		"email":       p.Email,
		"fargo":       p.Fargo,
		"pastEntries": past,
		"lastEvent":   lastEvent,
	}
}

// DuplicatePlayers: GET /api/v1/players/duplicates (session-required). Scans the
// current user's (organizer's) players and returns likely-duplicate PAIRS: same
// E.164 phone (reason "phone"), same lowercased email (reason "email"), or a
// normalized-name Levenshtein similarity >= 0.80 (reason "name"). Pairs the
// organizer previously marked "not a duplicate" (player_dismissed_pairs) are
// excluded. Returns {pairs:[{a,b,score,reason}]} sorted by score desc, cap 100.
func (api *API) DuplicatePlayers(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	org := actor(ctx)

	rows, err := api.DB.QueryContext(ctx,
		`SELECT `+playerCols+` FROM players WHERE organizer_user_id = ? ORDER BY name_key`, org)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "server_error", "")
		return
	}
	players := []*Player{}
	for rows.Next() {
		p, err := scanPlayer(rows)
		if err != nil {
			rows.Close()
			writeErr(w, http.StatusInternalServerError, "server_error", "")
			return
		}
		players = append(players, p)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		writeErr(w, http.StatusInternalServerError, "server_error", "")
		return
	}

	n := len(players)
	if n > dupScanCap {
		log.Printf("duplicates: organizer %s has %d players (>%d) — capping pairwise scan", org, n, dupScanCap)
		players = players[:dupScanCap]
		n = dupScanCap
	}

	// dismissed pairs (canonical order) for this organizer
	dismissed := map[string]bool{}
	drows, err := api.DB.QueryContext(ctx,
		`SELECT player_a, player_b FROM player_dismissed_pairs WHERE organizer_user_id = ?`, org)
	if err == nil {
		for drows.Next() {
			var a, b string
			if drows.Scan(&a, &b) == nil {
				dismissed[a+"\x00"+b] = true
			}
		}
		drows.Close()
	}

	type pair struct {
		a, b   *Player
		score  float64
		reason string
	}
	pairs := []pair{}
	for i := 0; i < n; i++ {
		pi := players[i]
		var phi string
		if pi.Phone != nil && *pi.Phone != "" {
			phi = e164(*pi.Phone)
		}
		var emi string
		if pi.Email != nil && *pi.Email != "" {
			emi = strings.ToLower(*pi.Email)
		}
		for j := i + 1; j < n; j++ {
			pj := players[j]
			score := 0.0
			reason := ""
			if phi != "" && pj.Phone != nil && *pj.Phone != "" && e164(*pj.Phone) == phi {
				score, reason = 1.0, "phone"
			} else if emi != "" && pj.Email != nil && *pj.Email != "" && strings.ToLower(*pj.Email) == emi {
				score, reason = 1.0, "email"
			} else if s := nameSimilarity(pi.NameKey, pj.NameKey); s >= nameDupThreshold {
				score, reason = s, "name"
			}
			if reason == "" {
				continue
			}
			ca, cb := canonPair(pi.ID, pj.ID)
			if dismissed[ca+"\x00"+cb] {
				continue
			}
			pairs = append(pairs, pair{a: pi, b: pj, score: score, reason: reason})
		}
	}

	sort.SliceStable(pairs, func(i, j int) bool { return pairs[i].score > pairs[j].score })
	if len(pairs) > 100 {
		pairs = pairs[:100]
	}

	out := make([]map[string]interface{}, 0, len(pairs))
	for _, pr := range pairs {
		out = append(out, map[string]interface{}{
			"a":      api.playerItem(ctx, pr.a),
			"b":      api.playerItem(ctx, pr.b),
			"score":  pr.score,
			"reason": pr.reason,
		})
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"pairs": out})
}

// DismissDuplicate: POST /api/v1/players/dismiss-duplicate (director+, CSRF).
// Body {"aId","bId"}. Records the (organizer, canonical pair) as "not a duplicate"
// so the review screen stops surfacing it. 400 if ids are empty/equal or belong
// to different organizers; 404 if a player is missing.
func (api *API) DismissDuplicate(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	org := actor(ctx)
	var body struct {
		AID string `json:"aId"`
		BID string `json:"bId"`
	}
	if !decodeBody(w, r, &body) {
		return
	}
	if body.AID == "" || body.BID == "" || body.AID == body.BID {
		writeErr(w, http.StatusBadRequest, "invalid_pair", "aId and bId are required and must differ")
		return
	}
	for _, id := range []string{body.AID, body.BID} {
		var pOrg string
		err := api.DB.QueryRowContext(ctx, `SELECT organizer_user_id FROM players WHERE id = ?`, id).Scan(&pOrg)
		if errors.Is(err, sql.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "not_found", "player not found")
			return
		}
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "server_error", "")
			return
		}
		if pOrg != org {
			writeErr(w, http.StatusBadRequest, "invalid_pair", "players belong to different organizers")
			return
		}
	}
	a, b := canonPair(body.AID, body.BID)
	if _, err := api.DB.ExecContext(ctx,
		`INSERT OR IGNORE INTO player_dismissed_pairs (organizer_user_id, player_a, player_b, created_at) VALUES (?,?,?,?)`,
		org, a, b, time.Now().Unix()); err != nil {
		writeErr(w, http.StatusInternalServerError, "server_error", "")
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"ok": true})
}
