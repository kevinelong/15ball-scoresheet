package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/kevinelong/15ball-scoresheet/server/internal/audit"
	"github.com/kevinelong/15ball-scoresheet/server/internal/auth"
	"github.com/kevinelong/15ball-scoresheet/server/internal/notify"
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
	Bracket      *string `json:"bracket"`    // 'W'|'L'|'GF' (double-elim); null = single-elim
	MatchLabel   *string `json:"matchLabel"` // e.g. 'W2M1','L1M2','GF1','GF2'
	// Feeder edges (double-elim, migration 0010): where this match's winner/loser
	// advance to. Let the frontend build reverse-edges (losers-bracket origin tags).
	FeedsWinnerMatch *string `json:"feedsWinnerMatch"`
	FeedsWinnerSlot  *int64  `json:"feedsWinnerSlot"`
	FeedsLoserMatch  *string `json:"feedsLoserMatch"`
	FeedsLoserSlot   *int64  `json:"feedsLoserSlot"`
	// WinnerEntrantID is the current (non-superseded) result winner, or nil when the
	// match has no recorded result. Populated by ListMatches; not part of matchCols/scanMatch.
	WinnerEntrantID *string `json:"winnerEntrantId"`
	// NeedsReview marks a match whose participants changed after it was played: the
	// recorded result is kept as-is and the match waits for a director to replay it
	// (migration 0017, 03-state-machines "Match review flag").
	NeedsReview bool `json:"needsReview"`
	// RaceTo/RaceFrom are the resolved race target (migration 0018,
	// 05-schema-contract): matches.race_to, else the division's race_to, else the
	// game's default — always a number, never null. RaceFrom names the layer that
	// supplied it: "match", "division" or "default". Filled by scanMatch.
	RaceTo      int    `json:"raceTo"`
	RaceFrom    string `json:"raceFrom"`
	Version     int64  `json:"version"`
	StartedAt   *int64 `json:"startedAt"`
	CompletedAt *int64 `json:"completedAt"`
	CreatedAt   int64  `json:"createdAt"`
	UpdatedAt   int64  `json:"updatedAt"`
}

// matchCols also carries the two race layers below the match (the division's
// stored race_to and the tournament's game) so scanMatch can resolve raceTo /
// raceFrom in one pass, in every query that reads a match.
const matchCols = `id, tournament_id, division_id, bracket_round, slot, entrant_a_id, entrant_b_id, state, assigned_scorekeeper_user_id, table_ref, version, started_at, completed_at, created_at, updated_at, bracket, match_label, feeds_winner_match, feeds_winner_slot, feeds_loser_match, feeds_loser_slot, needs_review, race_to, (SELECT race_to FROM divisions d WHERE d.id = matches.division_id), (SELECT game FROM tournaments t WHERE t.id = matches.tournament_id)`

func scanMatch(row interface{ Scan(...any) error }) (*Match, error) {
	var m Match
	var matchRace, divRace *int
	var game string
	err := row.Scan(&m.ID, &m.TournamentID, &m.DivisionID, &m.BracketRound, &m.Slot, &m.EntrantAID, &m.EntrantBID,
		&m.State, &m.Scorekeeper, &m.TableRef, &m.Version, &m.StartedAt, &m.CompletedAt, &m.CreatedAt, &m.UpdatedAt,
		&m.Bracket, &m.MatchLabel, &m.FeedsWinnerMatch, &m.FeedsWinnerSlot, &m.FeedsLoserMatch, &m.FeedsLoserSlot,
		&m.NeedsReview, &matchRace, &divRace, &game)
	m.RaceTo, m.RaceFrom = resolveRaceTo(matchRace, divRace, game)
	return &m, err
}

func (api *API) getMatch(ctx context.Context, tid, mid string) (*Match, error) {
	row := api.DB.QueryRowContext(ctx, `SELECT `+matchCols+` FROM matches WHERE id=? AND tournament_id=?`, mid, tid)
	return scanMatch(row)
}

// generateBracket builds the winners-only single-elimination graph from a
// tournament's checked-in entrants. The field is sized up to nextPow2 and
// unpaired seeds become BYE placeholders that resolveByes auto-advances, so every
// checked-in entrant is in the bracket and none is ever dropped. Every round is
// created up front with winner edges, and the last W match is the decisive final
// (advanceBracket then has nowhere to send its winner).
//
// These matches carry a NULL `bracket` — that column is the double-elimination
// tag — which is what routes their results down the single-elimination
// advancement path in SubmitResult.
//
// Runs inside the caller's transaction.
func (api *API) generateBracket(ctx context.Context, tx *sql.Tx, tid string) (int, error) {
	ent, err := api.checkedInEntrantIDs(ctx, tx, tid)
	if err != nil {
		return 0, err
	}
	if len(ent) == 0 {
		return 0, nil
	}
	now := time.Now().Unix()
	slots, err := api.seedField(ctx, tx, tid, "", ent, now)
	if err != nil {
		return 0, err
	}

	ids := map[string]string{} // label -> match id
	idFor := func(l string) string {
		if ids[l] == "" {
			ids[l] = newID("mch_")
		}
		return ids[l]
	}
	byLabel := map[string]*mrec{}
	var recs []*mrec
	add := func(r *mrec) *mrec {
		r.fwSlot, r.flSlot = -1, -1
		recs = append(recs, r)
		byLabel[r.label] = r
		idFor(r.label)
		return r
	}
	buildWinnersRounds(add, idFor, byLabel, len(slots), slots)

	for _, r := range recs {
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO matches (id, tournament_id, bracket, match_label, bracket_round, slot,
			   entrant_a_id, entrant_b_id, state, feeds_winner_match, feeds_winner_slot, created_at, updated_at)
			 VALUES (?,?,NULL,?,?,?,?,?, 'scheduled', ?,?,?,?)`,
			ids[r.label], tid, r.label, r.round, r.slot,
			nullIfEmpty(r.a), nullIfEmpty(r.b), nullIfEmpty(r.fwMatch), nullSlot(r.fwSlot),
			now, now); err != nil {
			return 0, err
		}
	}
	if err := api.resolveByes(ctx, tx, tid); err != nil {
		return 0, err
	}
	return len(recs), nil
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
	// Attach the current winner per match in one query. A match_results row is
	// "current" when superseded_by IS NULL; there is exactly one such row per
	// completed match. Unfinished matches keep a nil winnerEntrantId.
	if len(items) > 0 {
		placeholders := make([]string, len(items))
		wargs := make([]any, 0, len(items))
		byID := make(map[string]*Match, len(items))
		for i, m := range items {
			placeholders[i] = "?"
			wargs = append(wargs, m.ID)
			byID[m.ID] = m
		}
		wq := `SELECT match_id, winner_entrant_id FROM match_results WHERE superseded_by IS NULL AND match_id IN (` +
			strings.Join(placeholders, ",") + `)`
		wrows, werr := api.DB.QueryContext(r.Context(), wq, wargs...)
		if werr != nil {
			writeErr(w, http.StatusInternalServerError, "server_error", "")
			return
		}
		defer wrows.Close()
		for wrows.Next() {
			var mid string
			var win sql.NullString
			if err := wrows.Scan(&mid, &win); err != nil {
				writeErr(w, http.StatusInternalServerError, "server_error", "")
				return
			}
			if m := byID[mid]; m != nil && win.Valid {
				v := win.String
				m.WinnerEntrantID = &v
			}
		}
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
	// verify the scorekeeper user holds the scorekeeper role (or director+).
	// Skipped in open match editing, where a scorekeeper user is optional.
	if !api.OpenMatchEditing {
		ok, _ := api.Auth.HasAnyRole(r.Context(), body.ScorekeeperUserID, append([]string{auth.RoleScorekeeper}, auth.DirectorOrAbove...)...)
		if body.ScorekeeperUserID == "" || !ok {
			writeErr(w, http.StatusBadRequest, "invalid_scorekeeper", "scorekeeperUserId must be a user with the scorekeeper role")
			return
		}
	}
	var scorekeeper interface{} // NULL when unset (FK-safe in open mode)
	if body.ScorekeeperUserID != "" {
		scorekeeper = body.ScorekeeperUserID
	}
	now := time.Now().Unix()
	tx, _ := api.DB.BeginTx(r.Context(), nil)
	defer tx.Rollback()
	// tableRef is optional; COALESCE keeps any existing assignment when omitted.
	if _, err := tx.ExecContext(r.Context(),
		`UPDATE matches SET state='assigned', assigned_scorekeeper_user_id=?, table_ref=COALESCE(?, table_ref), updated_at=?, version=version+1 WHERE id=?`,
		scorekeeper, body.TableRef, now, mid); err != nil {
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
	// A match assigned to a table is "ready" — enqueue opt-in SMS to both players
	// (idempotent per match+entrant, so re-assigns don't re-text).
	api.enqueueMatchReady(r.Context(), tx, tid, mid)
	if err := tx.Commit(); err != nil {
		writeErr(w, http.StatusInternalServerError, "server_error", "")
		return
	}
	nm, _ := api.getMatch(r.Context(), tid, mid)
	writeJSON(w, http.StatusOK, map[string]interface{}{"match": nm})
}

// enqueueMatchReady queues a match-ready SMS to each opt-in entrant of the match.
// No-op unless SMS is enabled and the match has a table assigned. Best-effort:
// enqueue failures never block the assign (the alert is advisory).
func (api *API) enqueueMatchReady(ctx context.Context, tx *sql.Tx, tid, mid string) {
	if !api.smsReady() {
		return
	}
	var aID, bID, tableRef, slug sql.NullString
	if err := tx.QueryRowContext(ctx,
		`SELECT entrant_a_id, entrant_b_id, table_ref,
		        (SELECT slug FROM tournaments WHERE id=?) FROM matches WHERE id=?`,
		tid, mid).Scan(&aID, &bID, &tableRef, &slug); err != nil {
		return
	}
	if !tableRef.Valid || tableRef.String == "" {
		return // "ready" means at a table
	}
	// The public score link. Prefer the tournament slug: it is shorter in a text.
	tour := tid
	if slug.Valid && slug.String != "" {
		tour = slug.String
	}
	base := strings.TrimRight(api.BaseURL, "/")
	if base == "" {
		base = "https://codeonline.io/15ball"
	}
	link := base + "/live.html?t=" + url.QueryEscape(tour) + "&m=" + url.QueryEscape(mid)
	// Each player is texted their own opponent's name.
	type rcpt struct{ eid, oppID string }
	pairs := []rcpt{}
	if aID.Valid && aID.String != "" {
		pairs = append(pairs, rcpt{aID.String, bID.String})
	}
	if bID.Valid && bID.String != "" {
		pairs = append(pairs, rcpt{bID.String, aID.String})
	}
	for _, p := range pairs {
		var phone string
		var optIn int
		if err := tx.QueryRowContext(ctx,
			`SELECT COALESCE(phone,''), notify_opt_in FROM entrants WHERE id=?`, p.eid).Scan(&phone, &optIn); err != nil {
			continue
		}
		if phone == "" || optIn != 1 {
			continue
		}
		oppName := "your opponent"
		if p.oppID != "" {
			var n sql.NullString
			_ = tx.QueryRowContext(ctx, `SELECT display_name FROM entrants WHERE id=?`, p.oppID).Scan(&n)
			if n.Valid && n.String != "" {
				oppName = n.String
			}
		}
		body := fmt.Sprintf("Columbia Cue Club: Your match vs %s is starting now on table %s. Live: %s Reply STOP to opt out.", oppName, tableRef.String, link)
		_ = notify.Enqueue(ctx, tx, notify.Notification{
			TournamentID: tid, MatchID: mid, EntrantID: p.eid,
			Recipient: phone, Body: body,
			DedupeKey: mid + ":" + p.eid + ":match_ready",
		})
	}
}

const enrollmentConfirmationBody = "Columbia Cue Club Match Alerts: You're enrolled. Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out."

// enqueueEnrollmentConfirmation queues the one-time confirmation after staff
// records verbal consent. It is idempotent per entrant, so the create and
// subsequent PATCH paths cannot double-text; SMS-off leaves no queued job.
func (api *API) enqueueEnrollmentConfirmation(ctx context.Context, tx *sql.Tx, tid, eid, phone string) {
	if !api.smsReady() || phone == "" {
		return
	}
	_ = notify.Enqueue(ctx, tx, notify.Notification{
		TournamentID: tid, EntrantID: eid, Recipient: phone, Body: enrollmentConfirmationBody,
		DedupeKey: eid + ":enrollment",
	})
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
	// Also try the alert at start. The assign normally sent it; this covers a match
	// assigned while SMS was off, and the dedupe key stops a double text.
	api.enqueueMatchReady(r.Context(), tx, tid, mid)
	if err := tx.Commit(); err != nil {
		writeErr(w, http.StatusInternalServerError, "server_error", "")
		return
	}
	nm, _ := api.getMatch(r.Context(), tid, mid)
	writeJSON(w, http.StatusOK, map[string]interface{}{"match": nm})
}

// PatchMatch: PATCH /api/v1/tournaments/{id}/matches/{matchId} (director+ only).
// The per-match race override is director-set on purpose: an open scoring link
// must never be able to retune the race. Body carries raceTo with absent ≠ null —
// an explicit null clears the override (the match inherits its division again),
// absence leaves it alone. Returns the resolved match.
func (api *API) PatchMatch(w http.ResponseWriter, r *http.Request) {
	tid, mid := chi.URLParam(r, "id"), chi.URLParam(r, "matchId")
	var body struct {
		RaceTo json.RawMessage `json:"raceTo"`
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
	if body.RaceTo != nil {
		var raceVal *int
		if string(body.RaceTo) != "null" {
			var n int
			if err := json.Unmarshal(body.RaceTo, &n); err != nil || !validRaceTo(n) {
				writeErr(w, http.StatusBadRequest, "invalid_race_to", "raceTo must be between 1 and 999")
				return
			}
			raceVal = &n
		}
		now := time.Now().Unix()
		tx, _ := api.DB.BeginTx(r.Context(), nil)
		defer tx.Rollback()
		if _, err := tx.ExecContext(r.Context(),
			`UPDATE matches SET race_to=?, updated_at=?, version=version+1 WHERE id=?`, raceVal, now, mid); err != nil {
			writeErr(w, http.StatusInternalServerError, "server_error", "")
			return
		}
		_ = audit.Write(r.Context(), tx, audit.Entry{
			EntityType: "match", EntityID: mid, Action: "updated",
			ActorUserID: actor(r.Context()), RequestID: reqID(r.Context()),
			After: map[string]interface{}{"raceTo": raceVal},
		})
		if err := tx.Commit(); err != nil {
			writeErr(w, http.StatusInternalServerError, "server_error", "")
			return
		}
		m, _ = api.getMatch(r.Context(), tid, mid)
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"match": m})
}

// canScoreMatch: the assigned scorekeeper, or any director+ (or anyone, when
// open match editing is enabled).
func (api *API) canScoreMatch(ctx context.Context, m *Match) bool {
	if api.OpenMatchEditing {
		return true
	}
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
	// result versions: each saved sheet, newest first is up to the caller
	// (ORDER BY result_version), carrying the payload this version wrote and who
	// saved it (submittedByEmail is "" when submitted_by is NULL — an open scoring link).
	rrows, _ := api.DB.QueryContext(r.Context(),
		`SELECT r.id, r.result_version, r.winner_entrant_id, r.loser_entrant_id, r.payload_json, r.submitted_by, u.email, r.submitted_at, r.superseded_by
		 FROM match_results r LEFT JOIN users u ON u.id = r.submitted_by
		 WHERE r.match_id=? ORDER BY r.result_version`, mid)
	versions := []map[string]interface{}{}
	if rrows != nil {
		defer rrows.Close()
		for rrows.Next() {
			var id, payload string
			var rv int
			var win, lose, by, email, sup sql.NullString
			var at int64
			_ = rrows.Scan(&id, &rv, &win, &lose, &payload, &by, &email, &at, &sup)
			raw := json.RawMessage(payload)
			if payload == "" {
				raw = json.RawMessage("{}")
			}
			versions = append(versions, map[string]interface{}{
				"id": id, "resultVersion": rv, "winnerEntrantId": win.String, "loserEntrantId": lose.String,
				"payload": raw, "submittedBy": by.String, "submittedByEmail": email.String,
				"submittedAt": at, "supersededBy": sup.String,
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
