package api

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"math"
	"time"
)

// Double-elimination bracket engine — a Go port of the frontend bracket.js so the
// two produce identical structures (winners/losers/grand-final, byes, GF reset).
// The bracket is a persisted feeder graph: each match records where its winner
// advances (feeds_winner_*) and, in the winners bracket, where its loser drops
// (feeds_loser_*). Results propagate through the edges; byes are a placeholder
// entrant that auto-resolves. Single-elimination keeps the simpler round/slot
// path in scoring.go/matches.go.

const byeName = "— BYE —"

func nextPow2(n int) int {
	p := 1
	for p < n {
		p *= 2
	}
	return p
}

// seedOrder returns the standard "vs opposite" seed layout for a bracket of size
// (a power of two): e.g. size 8 → [1,8,5,4,3,6,7,2].
func seedOrder(size int) []int {
	order := []int{1}
	for len(order) < size {
		nextRound := len(order)*2 + 1
		out := make([]int, 0, len(order)*2)
		for _, s := range order {
			out = append(out, s, nextRound-s)
		}
		order = out
	}
	return order
}

// mrec is an in-memory match while the graph is wired, before persistence.
type mrec struct {
	label, bracket string
	round, slot    int
	a, b           string // entrant ids ("" = empty slot)
	fwMatch        string // winner feeds here
	fwSlot         int    // -1 = none
	flMatch        string // loser drops here (W bracket)
	flSlot         int    // -1 = none
}

// generateDoubleElim builds and persists the full double-elimination graph for a
// tournament's checked-in entrants (registration order = seeding). Fields of 2
// fall back to a single decisive match (single-elim). Returns the match count.
func (api *API) generateDoubleElim(ctx context.Context, tx *sql.Tx, tid, divisionID string) (int, error) {
	var ent []string
	rows, err := tx.QueryContext(ctx,
		`SELECT id FROM entrants WHERE tournament_id=? AND state='checked_in' AND archived_at IS NULL ORDER BY created_at, id`, tid)
	if err != nil {
		return 0, err
	}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return 0, err
		}
		ent = append(ent, id)
	}
	rows.Close()
	n := len(ent)
	if n < 3 {
		return api.generateBracket(ctx, tx, tid) // 2 players: one game decides it
	}
	size := nextPow2(n)
	wRounds := int(math.Log2(float64(size)))
	order := seedOrder(size)
	now := time.Now().Unix()

	// Placeholder BYE entrant (FK-safe) for non-power-of-two fields.
	byeID := ""
	if size > n {
		byeID = newID("ent_")
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO entrants (id, tournament_id, division_id, display_name, state, archived_at, created_at, updated_at, version)
			 VALUES (?,?,?,?, 'withdrawn', ?, ?, ?, 1)`,
			byeID, tid, nullIfEmpty(divisionID), byeName, now, now, now); err != nil {
			return 0, err
		}
	}
	slots := make([]string, size)
	for i := 0; i < size; i++ {
		if order[i] <= n {
			slots[i] = ent[order[i]-1]
		} else {
			slots[i] = byeID
		}
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

	// ---- Winners bracket ----
	for round := 1; round <= wRounds; round++ {
		cnt := size / (1 << round)
		for m := 1; m <= cnt; m++ {
			r := add(&mrec{label: fmt.Sprintf("W%dM%d", round, m), bracket: "W", round: round, slot: m - 1})
			if round == 1 {
				r.a = slots[(m-1)*2]
				r.b = slots[(m-1)*2+1]
			}
		}
	}
	for round := 1; round < wRounds; round++ {
		cnt := size / (1 << round)
		for m := 1; m <= cnt; m++ {
			p := byLabel[fmt.Sprintf("W%dM%d", round, m)]
			p.fwMatch, p.fwSlot = idFor(fmt.Sprintf("W%dM%d", round+1, (m+1)/2)), boolToSlot(m%2 == 0)
		}
	}
	// Grand final (GF2 created lazily only if the losers champ wins GF1).
	add(&mrec{label: "GF1", bracket: "GF", round: wRounds + 1, slot: 0})
	byLabel[fmt.Sprintf("W%dM1", wRounds)].fwMatch = idFor("GF1")
	byLabel[fmt.Sprintf("W%dM1", wRounds)].fwSlot = 0

	// ---- Losers bracket ----
	lRounds := 0
	if wRounds > 1 {
		lRounds = 2 * (wRounds - 1)
	}
	lPrev := 0
	for lr := 1; lr <= lRounds; lr++ {
		var cnt int
		switch {
		case lr == 1:
			cnt = size / 4
		case lr%2 == 0:
			cnt = lPrev
		default:
			cnt = lPrev / 2
		}
		for m := 1; m <= cnt; m++ {
			add(&mrec{label: fmt.Sprintf("L%dM%d", lr, m), bracket: "L", round: lr, slot: m - 1})
		}
		switch {
		case lr == 1:
			wc := size / 2 // W1 losers, cross-paired
			for m := 1; m <= cnt; m++ {
				a := byLabel[fmt.Sprintf("W1M%d", m)]
				b := byLabel[fmt.Sprintf("W1M%d", wc-m+1)]
				a.flMatch, a.flSlot = idFor(fmt.Sprintf("L1M%d", m)), 0
				b.flMatch, b.flSlot = idFor(fmt.Sprintf("L1M%d", m)), 1
			}
		case lr%2 == 0: // drop-in: L winner (slot0) + fresh W loser (slot1)
			wr := lr/2 + 1
			wc := size / (1 << wr)
			for m := 1; m <= cnt; m++ {
				lp := byLabel[fmt.Sprintf("L%dM%d", lr-1, m)]
				lp.fwMatch, lp.fwSlot = idFor(fmt.Sprintf("L%dM%d", lr, m)), 0
				wl := byLabel[fmt.Sprintf("W%dM%d", wr, wc-m+1)]
				wl.flMatch, wl.flSlot = idFor(fmt.Sprintf("L%dM%d", lr, m)), 1
			}
		default: // consolidate: two L winners meet
			for m := 1; m <= cnt; m++ {
				pa := byLabel[fmt.Sprintf("L%dM%d", lr-1, (m-1)*2+1)]
				pb := byLabel[fmt.Sprintf("L%dM%d", lr-1, (m-1)*2+2)]
				pa.fwMatch, pa.fwSlot = idFor(fmt.Sprintf("L%dM%d", lr, m)), 0
				pb.fwMatch, pb.fwSlot = idFor(fmt.Sprintf("L%dM%d", lr, m)), 1
			}
		}
		lPrev = cnt
	}
	if lRounds > 0 {
		lf := byLabel[fmt.Sprintf("L%dM1", lRounds)]
		lf.fwMatch, lf.fwSlot = idFor("GF1"), 1
	}

	// ---- Persist ----
	for _, r := range recs {
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO matches (id, tournament_id, division_id, bracket, match_label, bracket_round, slot,
			   entrant_a_id, entrant_b_id, state, feeds_winner_match, feeds_winner_slot, feeds_loser_match, feeds_loser_slot, created_at, updated_at)
			 VALUES (?,?,?,?,?,?,?,?,?, 'scheduled', ?,?,?,?,?,?)`,
			ids[r.label], tid, nullIfEmpty(divisionID), r.bracket, r.label, r.round, r.slot,
			nullIfEmpty(r.a), nullIfEmpty(r.b), nullIfEmpty(r.fwMatch), nullSlot(r.fwSlot), nullIfEmpty(r.flMatch), nullSlot(r.flSlot),
			now, now); err != nil {
			return 0, err
		}
	}
	if err := api.resolveByes(ctx, tx, tid); err != nil {
		return 0, err
	}
	return len(recs), nil
}

// resolveByes auto-completes any W/L match sitting on a BYE (both slots filled,
// one is the bye entrant), advancing the real player and propagating through the
// graph. Loops until stable so cascades (a dropped loser meeting a bye) resolve.
func (api *API) resolveByes(ctx context.Context, tx *sql.Tx, tid string) error {
	byeID := api.byeEntrantID(ctx, tx, tid)
	if byeID == "" {
		return nil
	}
	for i := 0; i < 4096; i++ {
		var mid string
		var a, b, fwM, flM sql.NullString
		var fwS, flS sql.NullInt64
		err := tx.QueryRowContext(ctx,
			`SELECT id, entrant_a_id, entrant_b_id, feeds_winner_match, feeds_winner_slot, feeds_loser_match, feeds_loser_slot
			 FROM matches WHERE tournament_id=? AND state='scheduled' AND bracket IN ('W','L')
			   AND entrant_a_id IS NOT NULL AND entrant_b_id IS NOT NULL
			   AND (entrant_a_id=? OR entrant_b_id=?) LIMIT 1`, tid, byeID, byeID).
			Scan(&mid, &a, &b, &fwM, &fwS, &flM, &flS)
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		winner, loser := a.String, b.String
		if a.String == byeID && b.String != byeID {
			winner, loser = b.String, a.String
		}
		now := time.Now().Unix()
		if _, err := tx.ExecContext(ctx,
			`UPDATE matches SET state='completed', completed_at=?, updated_at=?, version=version+1 WHERE id=?`, now, now, mid); err != nil {
			return err
		}
		if fwM.Valid {
			if err := api.setSlot(ctx, tx, fwM.String, int(fwS.Int64), winner); err != nil {
				return err
			}
		}
		if flM.Valid { // propagate the bye loser too, so downstream L matches resolve
			if err := api.setSlot(ctx, tx, flM.String, int(flS.Int64), loser); err != nil {
				return err
			}
		}
	}
	return nil
}

// advanceDouble propagates a live result through the double-elim graph: the winner
// advances, and (winners bracket) the loser drops to the losers bracket; losers-
// bracket and grand-final losses eliminate. GF1 won by the losers champ spawns the
// GF2 reset. Then byes newly exposed by a dropped loser are resolved.
func (api *API) advanceDouble(ctx context.Context, tx *sql.Tx, m *Match, winnerID, loserID string) error {
	var fwM, flM sql.NullString
	var fwS, flS sql.NullInt64
	if err := tx.QueryRowContext(ctx,
		`SELECT feeds_winner_match, feeds_winner_slot, feeds_loser_match, feeds_loser_slot FROM matches WHERE id=?`, m.ID).
		Scan(&fwM, &fwS, &flM, &flS); err != nil {
		return err
	}
	label := ""
	if m.MatchLabel != nil {
		label = *m.MatchLabel
	}
	now := time.Now().Unix()

	if label == "GF1" {
		wChamp := m.EntrantAID != nil && *m.EntrantAID == winnerID // slot0 = winners champion
		if wChamp {
			return api.eliminate(ctx, tx, loserID) // decisive: winners champ wins
		}
		// Losers champ won → reset match (must beat twice).
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO matches (id, tournament_id, division_id, bracket, match_label, bracket_round, slot, entrant_a_id, entrant_b_id, state, created_at, updated_at)
			 VALUES (?,?,?, 'GF', 'GF2', ?, 0, ?, ?, 'scheduled', ?, ?)`,
			newID("mch_"), m.TournamentID, nullPtr(m.DivisionID), m.BracketRound+1, deref(m.EntrantAID), deref(m.EntrantBID), now, now); err != nil {
			return err
		}
		return nil
	}
	if label == "GF2" {
		return api.eliminate(ctx, tx, loserID)
	}

	// Winners / losers bracket match.
	if fwM.Valid {
		if err := api.setSlot(ctx, tx, fwM.String, int(fwS.Int64), winnerID); err != nil {
			return err
		}
	}
	if m.Bracket != nil && *m.Bracket == "L" {
		if err := api.eliminate(ctx, tx, loserID); err != nil {
			return err
		}
	} else if flM.Valid { // winners bracket: loser drops down
		if err := api.setSlot(ctx, tx, flM.String, int(flS.Int64), loserID); err != nil {
			return err
		}
	}
	return api.resolveByes(ctx, tx, m.TournamentID)
}

func (api *API) setSlot(ctx context.Context, tx *sql.Tx, matchID string, slot int, entrantID string) error {
	col := "entrant_a_id"
	if slot == 1 {
		col = "entrant_b_id"
	}
	_, err := tx.ExecContext(ctx, `UPDATE matches SET `+col+`=?, updated_at=? WHERE id=?`, entrantID, time.Now().Unix(), matchID)
	return err
}

func (api *API) eliminate(ctx context.Context, tx *sql.Tx, entrantID string) error {
	if entrantID == "" {
		return nil
	}
	_, err := tx.ExecContext(ctx,
		`UPDATE entrants SET state='eliminated', updated_at=? WHERE id=? AND state='checked_in'`, time.Now().Unix(), entrantID)
	return err
}

func (api *API) byeEntrantID(ctx context.Context, tx *sql.Tx, tid string) string {
	var id string
	_ = tx.QueryRowContext(ctx,
		`SELECT id FROM entrants WHERE tournament_id=? AND display_name=? AND state='withdrawn' LIMIT 1`, tid, byeName).Scan(&id)
	return id
}

// primaryDivision returns the (id, format) of the tournament's earliest active
// division, defaulting to double_elimination when unset.
func (api *API) primaryDivision(ctx context.Context, tx *sql.Tx, tid string) (string, string) {
	var id, format string
	err := tx.QueryRowContext(ctx,
		`SELECT id, format FROM divisions WHERE tournament_id=? AND archived_at IS NULL ORDER BY created_at, id LIMIT 1`, tid).
		Scan(&id, &format)
	if err != nil || format == "" {
		return id, "double_elimination"
	}
	return id, format
}

// ---- small nullable helpers ----

func nullIfEmpty(s string) interface{} {
	if s == "" {
		return nil
	}
	return s
}
func nullSlot(s int) interface{} {
	if s < 0 {
		return nil
	}
	return s
}
func nullPtr(s *string) interface{} {
	if s == nil || *s == "" {
		return nil
	}
	return *s
}
func boolToSlot(b bool) int {
	if b {
		return 1
	}
	return 0
}
func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
