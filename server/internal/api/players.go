package api

import (
	"context"
	"database/sql"
	"errors"
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
	name := strings.TrimSpace(r.URL.Query().Get("name"))
	phone := strings.TrimSpace(r.URL.Query().Get("phone"))
	email := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("email")))
	nameKey := normalizeName(name)
	phoneKey := ""
	if phone != "" {
		phoneKey = e164(phone)
	}

	rows, err := api.DB.QueryContext(r.Context(), `SELECT `+playerCols+` FROM players WHERE organizer_user_id = ?`, org)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "server_error", "")
		return
	}
	defer rows.Close()

	type cand struct {
		p     *Player
		score float64
	}
	cands := []cand{}
	for rows.Next() {
		p, err := scanPlayer(rows)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "server_error", "")
			return
		}
		score := 0.0
		// strong: exact phone (E.164) or lowercased email match
		if phoneKey != "" && p.Phone != nil && e164(*p.Phone) == phoneKey {
			score = 1.0
		}
		if email != "" && p.Email != nil && strings.ToLower(*p.Email) == email {
			score = 1.0
		}
		// fuzzy name
		if nameKey != "" {
			if s := nameSimilarity(nameKey, p.NameKey); s > score {
				score = s
			}
		}
		// keep strong matches unconditionally; otherwise require the fuzzy threshold
		if score >= 1.0 || (nameKey != "" && nameSimilarity(nameKey, p.NameKey) >= 0.72) {
			cands = append(cands, cand{p: p, score: score})
		}
	}

	sort.SliceStable(cands, func(i, j int) bool { return cands[i].score > cands[j].score })
	if len(cands) > 6 {
		cands = cands[:6]
	}

	items := make([]map[string]interface{}, 0, len(cands))
	for _, c := range cands {
		var past int
		_ = api.DB.QueryRowContext(r.Context(), `SELECT COUNT(*) FROM entrants WHERE player_id = ?`, c.p.ID).Scan(&past)
		items = append(items, map[string]interface{}{
			"playerId":    c.p.ID,
			"displayName": c.p.DisplayName,
			"phone":       c.p.Phone,
			"email":       c.p.Email,
			"fargo":       c.p.Fargo,
			"score":       c.score,
			"pastEntries": past,
		})
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"items": items})
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
