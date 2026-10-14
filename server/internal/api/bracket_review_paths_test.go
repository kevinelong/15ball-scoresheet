package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// pubJSON issues an unauthenticated GET and decodes the body (the public routes need
// no session).
func (e *testEnv) pubJSON(t *testing.T, path string) (int, map[string]interface{}) {
	t.Helper()
	req := httptest.NewRequest("GET", path, nil)
	rec := httptest.NewRecorder()
	e.router.ServeHTTP(rec, req)
	var out map[string]interface{}
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

// auditActionCount counts the audit rows recorded for one entity and action.
func (e *testEnv) auditActionCount(t *testing.T, tid, entityID, action string) int {
	t.Helper()
	code, aud := e.do(t, "GET", "/api/v1/tournaments/"+tid+"/audit", e.director, "")
	if code != http.StatusOK {
		t.Fatalf("audit: want 200, got %d", code)
	}
	n := 0
	for _, it := range aud["items"].([]interface{}) {
		m := it.(map[string]interface{})
		if str(m["entityId"]) == entityID && str(m["action"]) == action {
			n++
		}
	}
	return n
}

// matchVersion reads one match's row version, used to prove a repeated write is inert.
func (e *testEnv) matchVersion(t *testing.T, tid, mid string) int64 {
	t.Helper()
	var v int64
	if err := e.api.DB.QueryRow(`SELECT version FROM matches WHERE id=? AND tournament_id=?`, mid, tid).Scan(&v); err != nil {
		t.Fatalf("match version %s: %v", mid, err)
	}
	return v
}

// TestReviewFlagPropagationPaths drives the flag through every propagation path.
// advanceDouble has two writes (the winner advances, the loser drops into the losers
// bracket) and both must be guarded; the single-elimination path goes through
// advanceBracket. Each played target is flagged exactly once, keeps its played result,
// and the corrected entrant lands in its slot so the match can be replayed.
func TestReviewFlagPropagationPaths(t *testing.T) {
	t.Run("advanceDouble_winners_bracket", func(t *testing.T) {
		e := newTestEnv(t)
		tid := e.startDoubleElim(t, 4)
		e.playAll(t, tid, aWins)
		up := byLabel(t, e.matches(t, tid))["W1M1"]
		wrong, other := str(up["entrantAId"]), str(up["entrantBId"])

		e.reopenMatch(t, tid, up["id"].(string), "path-w-open", "wrong player advanced")
		e.scoreMatch(t, tid, up["id"].(string), other, wrong, "path-w-res")

		target := byLabel(t, e.matches(t, tid))["W2M1"]
		if target["needsReview"] != true {
			t.Fatalf("W2M1 should be flagged: %v", target)
		}
		if got := str(target["entrantAId"]); got != other {
			t.Errorf("W2M1 slot a: want the corrected winner %q, got %q", other, got)
		}
		if n := e.auditActionCount(t, tid, target["id"].(string), "review_required"); n != 1 {
			t.Errorf("W2M1 review_required audit rows: want 1, got %d", n)
		}
		if n := e.sseEventCount(t, tid, "match.review_required"); n != 2 {
			t.Errorf("match.review_required events: want 2 (winner + loser drop), got %d", n)
		}
	})

	t.Run("advanceDouble_losers_bracket_drop", func(t *testing.T) {
		e := newTestEnv(t)
		tid := e.startDoubleElim(t, 4)
		e.playAll(t, tid, aWins)
		up := byLabel(t, e.matches(t, tid))["W1M1"]
		wrong, other := str(up["entrantAId"]), str(up["entrantBId"])
		before := byLabel(t, e.matches(t, tid))["L1M1"]

		e.reopenMatch(t, tid, up["id"].(string), "path-l-open", "wrong player advanced")
		e.scoreMatch(t, tid, up["id"].(string), other, wrong, "path-l-res")

		target := byLabel(t, e.matches(t, tid))["L1M1"]
		if target["needsReview"] != true {
			t.Fatalf("L1M1 should be flagged by the loser drop: %v", target)
		}
		if target["state"] != "completed" {
			t.Errorf("L1M1 state: want completed, got %v", target["state"])
		}
		if got, want := str(target["winnerEntrantId"]), str(before["winnerEntrantId"]); got != want {
			t.Errorf("L1M1 winnerEntrantId: want the recorded winner %q, got %q", want, got)
		}
		if vers := e.resultVersions(t, tid, target["id"].(string)); len(vers) != 1 {
			t.Errorf("L1M1 result versions: want 1, got %d", len(vers))
		}
		// The dropped entrant must be the corrected match's loser, and it must differ
		// from what the losers bracket held before the correction.
		beforeSlots := []string{str(before["entrantAId"]), str(before["entrantBId"])}
		nowSlots := []string{str(target["entrantAId"]), str(target["entrantBId"])}
		if beforeSlots[0] == wrong || beforeSlots[1] == wrong {
			t.Fatalf("setup: L1M1 already held the corrected loser %q (%v)", wrong, beforeSlots)
		}
		if nowSlots[0] != wrong && nowSlots[1] != wrong {
			t.Errorf("L1M1 should now hold the corrected loser %q, got %v", wrong, nowSlots)
		}
		if n := e.auditActionCount(t, tid, target["id"].(string), "review_required"); n != 1 {
			t.Errorf("L1M1 review_required audit rows: want 1, got %d", n)
		}
	})

	t.Run("advanceBracket_single_elim", func(t *testing.T) {
		e := newTestEnv(t)
		cb := e.singleElimWithCorrectedUpstream(t)
		target := byLabel(t, e.matches(t, cb.tid))["W2M1"]
		if target["needsReview"] != true {
			t.Fatalf("the single-elimination final should be flagged: %v", target)
		}
		if got := str(target["entrantAId"]); got != cb.corrected {
			t.Errorf("final slot a: want the corrected winner %q, got %q", cb.corrected, got)
		}
		if n := e.auditActionCount(t, cb.tid, cb.finalID, "review_required"); n != 1 {
			t.Errorf("review_required audit rows: want 1, got %d", n)
		}
		if n := e.sseEventCount(t, cb.tid, "match.review_required"); n != 1 {
			t.Errorf("match.review_required events: want 1, got %d", n)
		}
	})

	t.Run("resolveByes", func(t *testing.T) {
		// resolveByes is the fourth write path. No API sequence leaves a BYE match
		// unresolved while its target is already played (a bye match is either resolved
		// at generation or in the same call that fills it), so this drives the guard
		// directly on a crafted state. It is defence in depth: the guarantee it keeps
		// is that *any* propagation into a played match is recorded, not just the ones
		// the current callers reach.
		e := newTestEnv(t)
		ctx := context.Background()
		tid, _ := e.startSingleElim(t, 4)
		e.playAll(t, tid, aWins)
		finalID := byLabel(t, e.matches(t, tid))["W2M1"]["id"].(string)
		var origWinner string
		if err := e.api.DB.QueryRow(`SELECT winner_entrant_id FROM match_results WHERE match_id=?`, finalID).Scan(&origWinner); err != nil {
			t.Fatalf("final result: %v", err)
		}

		// A fresh real entrant wins a bye against a freshly inserted BYE placeholder.
		_, resp := e.do(t, "POST", "/api/v1/tournaments/"+tid+"/entrants", e.director, `{"displayName":"LateReal"}`)
		realID := resp["entrant"].(map[string]interface{})["id"].(string)
		byeID := "ent_byteest"
		now := time.Now().Unix()
		if _, err := e.api.DB.Exec(
			`INSERT INTO entrants (id, tournament_id, display_name, state, archived_at, created_at, updated_at, version)
			 VALUES (?,?,?, 'withdrawn', ?, ?, ?, 1)`, byeID, tid, byeName, now, now, now); err != nil {
			t.Fatalf("insert bye entrant: %v", err)
		}
		if _, err := e.api.DB.Exec(
			`INSERT INTO matches (id, tournament_id, bracket_round, slot, entrant_a_id, entrant_b_id, state,
			   feeds_winner_match, feeds_winner_slot, created_at, updated_at)
			 VALUES (?,?,1,9,?,?, 'scheduled', ?,0,?,?)`,
			"mch_byetest", tid, realID, byeID, finalID, now, now); err != nil {
			t.Fatalf("insert bye match: %v", err)
		}

		tx, err := e.api.DB.BeginTx(ctx, nil)
		if err != nil {
			t.Fatalf("begin: %v", err)
		}
		if err := e.api.resolveByes(ctx, tx, tid); err != nil {
			_ = tx.Rollback()
			t.Fatalf("resolveByes: %v", err)
		}
		if err := tx.Commit(); err != nil {
			t.Fatalf("commit: %v", err)
		}

		final := byLabel(t, e.matches(t, tid))["W2M1"]
		if final["needsReview"] != true {
			t.Errorf("resolveByes must flag a played target, got %v", final)
		}
		if final["state"] != "completed" {
			t.Errorf("final state: want completed, got %v", final["state"])
		}
		if got := str(final["winnerEntrantId"]); got != origWinner {
			t.Errorf("final winnerEntrantId: want %q, got %q", origWinner, got)
		}
		if got := str(final["entrantAId"]); got != realID {
			t.Errorf("final slot a: want the bye winner %q, got %q", realID, got)
		}
		if n := e.auditActionCount(t, tid, finalID, "review_required"); n != 1 {
			t.Errorf("review_required audit rows: want 1, got %d", n)
		}
		if n := e.sseEventCount(t, tid, "match.review_required"); n != 1 {
			t.Errorf("match.review_required events: want 1, got %d", n)
		}
		// The bye match itself is completed by resolveByes, not flagged.
		var byeState string
		if err := e.api.DB.QueryRow(`SELECT state FROM matches WHERE id='mch_byetest'`).Scan(&byeState); err != nil {
			t.Fatalf("bye match state: %v", err)
		}
		if byeState != "completed" {
			t.Errorf("bye match state: want completed, got %s", byeState)
		}
	})
}

// TestReviewFlagIdempotentAndInert pins the two ways a correction can leave a played
// target alone: repeating it verbatim, and re-submitting a winner that is already in
// the target's slot. Both must be completely inert - same flag, same row version, no
// extra audit row, no extra event.
func TestReviewFlagIdempotentAndInert(t *testing.T) {
	t.Run("repeating the correction is inert", func(t *testing.T) {
		e := newTestEnv(t)
		cb := e.singleElimWithCorrectedUpstream(t)
		after := byLabel(t, e.matches(t, cb.tid))["W2M1"]
		version := e.matchVersion(t, cb.tid, cb.finalID)

		upID := byLabel(t, e.matches(t, cb.tid))["W1M1"]["id"].(string)
		e.reopenMatch(t, cb.tid, upID, "idem-open", "same correction again")
		e.scoreMatch(t, cb.tid, upID, cb.corrected, cb.staleWinner, "idem-res")

		again := byLabel(t, e.matches(t, cb.tid))["W2M1"]
		if again["needsReview"] != true {
			t.Errorf("flag should still be set: %v", again)
		}
		if got := e.matchVersion(t, cb.tid, cb.finalID); got != version {
			t.Errorf("repeating the correction changed the target row (version %d -> %d)", version, got)
		}
		if got, want := str(again["entrantAId"]), str(after["entrantAId"]); got != want {
			t.Errorf("target slot moved: want %q, got %q", want, got)
		}
		if n := e.auditActionCount(t, cb.tid, cb.finalID, "review_required"); n != 1 {
			t.Errorf("review_required audit rows: want 1, got %d", n)
		}
		if n := e.sseEventCount(t, cb.tid, "match.review_required"); n != 1 {
			t.Errorf("match.review_required events: want 1, got %d", n)
		}
	})

	t.Run("an entrant already in the slot is inert", func(t *testing.T) {
		e := newTestEnv(t)
		tid, _ := e.startSingleElim(t, 4)
		e.playAll(t, tid, aWins)
		up := byLabel(t, e.matches(t, tid))["W1M1"]
		winner, loser := str(up["entrantAId"]), str(up["entrantBId"])
		finalID := byLabel(t, e.matches(t, tid))["W2M1"]["id"].(string)
		version := e.matchVersion(t, tid, finalID)

		// Re-completing with the *same* winner: the final's slot already holds it.
		e.reopenMatch(t, tid, up["id"].(string), "inert-open", "resubmit the same winner")
		e.scoreMatch(t, tid, up["id"].(string), winner, loser, "inert-res")

		final := byLabel(t, e.matches(t, tid))["W2M1"]
		if final["needsReview"] == true {
			t.Errorf("nothing changed, so nothing should be flagged: %v", final)
		}
		if got := e.matchVersion(t, tid, finalID); got != version {
			t.Errorf("inert write changed the target row (version %d -> %d)", version, got)
		}
		if n := e.auditActionCount(t, tid, finalID, "review_required"); n != 0 {
			t.Errorf("review_required audit rows: want 0, got %d", n)
		}
		if n := e.sseEventCount(t, tid, "match.review_required"); n != 0 {
			t.Errorf("match.review_required events: want 0, got %d", n)
		}
	})
}

// TestFlaggedMatchStillTransitions: the flag is a note, not a lock. A flagged match
// can still be reopened, replayed and completed, and it does not stop the tournament
// from completing (all its matches are terminal, which is all the completion guard
// asks for).
func TestFlaggedMatchStillTransitions(t *testing.T) {
	e := newTestEnv(t)
	cb := e.singleElimWithCorrectedUpstream(t)

	// The tournament completes while the flag is set.
	if code, r := e.do(t, "PATCH", "/api/v1/tournaments/"+cb.tid, e.director, `{"state":"completed"}`); code != http.StatusOK {
		t.Fatalf("complete with a flagged match: want 200, got %d (%v)", code, r)
	}
	// Reopen → replay → complete again, flag still set, then clear.
	e.reopenMatch(t, cb.tid, cb.finalID, "trans-open", "replay after the correction")
	e.scoreMatch(t, cb.tid, cb.finalID, cb.corrected, cb.finalOther, "trans-res")
	flagged := byLabel(t, e.matches(t, cb.tid))["W2M1"]
	if flagged["state"] != "completed" || flagged["needsReview"] != true {
		t.Fatalf("want a replayed, still-flagged match, got %v", flagged)
	}
	if code, _ := e.doKey(t, "POST", "/api/v1/tournaments/"+cb.tid+"/matches/"+cb.finalID+"/clear-review", e.director,
		`{"reason":"replayed"}`, "trans-clear"); code != http.StatusOK {
		t.Fatalf("clear-review: want 200, got %d", code)
	}
	if code, _ := e.do(t, "PATCH", "/api/v1/tournaments/"+cb.tid, e.director, `{"state":"in_progress","reason":"reopen"}`); code != http.StatusOK {
		t.Fatalf("tournament reopen: want 200, got %d", code)
	}
}

// TestClearReviewGuardsAndIdempotency covers the endpoint's refusals and its
// idempotency: a missing key is refused, a non-director is refused, an unflagged match
// is not a transition, and replaying the same key returns the same response without a
// second audit row or event.
func TestClearReviewGuardsAndIdempotency(t *testing.T) {
	e := newTestEnv(t)
	cb := e.singleElimWithCorrectedUpstream(t)
	path := "/api/v1/tournaments/" + cb.tid + "/matches/" + cb.finalID + "/clear-review"

	// No Idempotency-Key → 400 (the endpoint requires one, 04-api-contracts).
	if code, r := e.do(t, "POST", path, e.director, `{"reason":"x"}`); code != http.StatusBadRequest {
		t.Errorf("missing Idempotency-Key: want 400, got %d (%v)", code, r)
	}
	if code, _ := e.doKey(t, "POST", path, e.scorekeeper, `{"reason":"x"}`, "guard-spk"); code != http.StatusForbidden {
		t.Errorf("scorekeeper: want 403, got %d", code)
	}
	if code, _ := e.doKey(t, "POST", "/api/v1/tournaments/"+cb.tid+"/matches/zz/clear-review", e.director, `{}`, "guard-404"); code != http.StatusNotFound {
		t.Errorf("unknown match: want 404, got %d", code)
	}

	body := `{"reason":"replayed with the corrected players"}`
	if code, r := e.doKey(t, "POST", path, e.director, body, "guard-1"); code != http.StatusOK {
		t.Fatalf("first clear: want 200, got %d (%v)", code, r)
	}
	if n := e.auditActionCount(t, cb.tid, cb.finalID, "review_cleared"); n != 1 {
		t.Errorf("review_cleared audit rows: want 1, got %d", n)
	}
	if n := e.sseEventCount(t, cb.tid, "match.review_cleared"); n != 1 {
		t.Errorf("match.review_cleared events: want 1, got %d", n)
	}
	// Same key again: the cached response is replayed, so nothing is re-applied.
	if code, r := e.doKey(t, "POST", path, e.director, body, "guard-1"); code != http.StatusOK {
		t.Errorf("repeat with the same key: want the cached 200, got %d (%v)", code, r)
	}
	if n := e.auditActionCount(t, cb.tid, cb.finalID, "review_cleared"); n != 1 {
		t.Errorf("repeating with the same key duplicated the audit row: want 1, got %d", n)
	}
	if n := e.sseEventCount(t, cb.tid, "match.review_cleared"); n != 1 {
		t.Errorf("repeating with the same key duplicated the event: want 1, got %d", n)
	}
	// A fresh key on an unflagged match is a transition conflict, not a second clear.
	if code, _ := e.doKey(t, "POST", path, e.director, body, "guard-2"); code != http.StatusConflict {
		t.Errorf("clear an unflagged match: want 409, got %d", code)
	}
	if body := byLabel(t, e.matches(t, cb.tid))["W2M1"]; body["needsReview"] != false {
		t.Errorf("flag should be cleared: %v", body)
	}
}

// TestNeedsReviewOnMatchPayloads: the flag must be visible where clients read a match
// - the match list, the single-match payloads returned by the match actions, and the
// snapshot - and false for a match that is not flagged.
func TestNeedsReviewOnMatchPayloads(t *testing.T) {
	e := newTestEnv(t)
	cb := e.singleElimWithCorrectedUpstream(t)

	listed := byLabel(t, e.matches(t, cb.tid))
	if listed["W2M1"]["needsReview"] != true {
		t.Errorf("listMatches: W2M1 should be flagged: %v", listed["W2M1"])
	}
	if listed["W1M2"]["needsReview"] != false {
		t.Errorf("listMatches: a clean match must read false: %v", listed["W1M2"])
	}

	// Single-match payload from an action.
	code, r := e.doKey(t, "POST", "/api/v1/tournaments/"+cb.tid+"/matches/"+cb.finalID+"/reopen", e.director,
		`{"reason":"replay"}`, "payload-open")
	if code != http.StatusOK {
		t.Fatalf("reopen: want 200, got %d", code)
	}
	if m := r["match"].(map[string]interface{}); m["needsReview"] != true {
		t.Errorf("reopen payload: want needsReview true, got %v", m["needsReview"])
	}

	// Snapshot (what the console and the OBS overlay normalize from).
	code, snap := e.do(t, "GET", "/api/v1/tournaments/"+cb.tid+"/snapshot", e.director, "")
	if code != http.StatusOK {
		t.Fatalf("snapshot: want 200, got %d", code)
	}
	snapFlagged, snapClean := false, true
	for _, it := range snap["matches"].([]interface{}) {
		m := it.(map[string]interface{})
		if str(m["id"]) == cb.finalID && m["needsReview"] == true {
			snapFlagged = true
		}
		if str(m["id"]) == cb.finalID && m["needsReview"] != true {
			snapClean = false
		}
	}
	if !snapFlagged || !snapClean {
		t.Errorf("snapshot matches: the flagged match should carry needsReview true (flagged=%v clean=%v)", snapFlagged, snapClean)
	}

	// Clearing reports it as false in the same payload shape.
	if code, r := e.doKey(t, "POST", "/api/v1/tournaments/"+cb.tid+"/matches/"+cb.finalID+"/clear-review", e.director,
		`{"reason":"replayed"}`, "payload-clear"); code != http.StatusOK {
		t.Fatalf("clear-review: want 200, got %d", code)
	} else if m := r["match"].(map[string]interface{}); m["needsReview"] != false {
		t.Errorf("clear-review payload: want needsReview false, got %v", m["needsReview"])
	}
}

// TestOverlayReviewRequired pins the normalized signal for the same four states the
// overlay client renders, so a consumer that never reads the match list still sees the
// doubt: a flagged match that is not the featured one, a flagged featured match, a
// clean bracket, and a flagged bracket with nothing live.
func TestOverlayReviewRequired(t *testing.T) {
	// overlayFor starts a single-elimination tournament, plays it out and returns the
	// tournament id plus the overlay payloads it needs.
	overlayFor := func(t *testing.T, e *testEnv, withFlag bool) (string, map[string]interface{}) {
		t.Helper()
		tid, _ := e.startSingleElim(t, 4)
		e.playAll(t, tid, aWins)
		if withFlag {
			ms := byLabel(t, e.matches(t, tid))
			up, final := ms["W1M1"], ms["W2M1"]
			e.reopenMatch(t, tid, up["id"].(string), "ov-open", "wrong player advanced")
			e.scoreMatch(t, tid, up["id"].(string), str(up["entrantBId"]), str(up["entrantAId"]), "ov-res")
			if byLabel(t, e.matches(t, tid))["W2M1"]["needsReview"] != true {
				t.Fatalf("setup: %s should be flagged", str(final["matchLabel"]))
			}
		}
		code, snap := e.do(t, "GET", "/api/v1/tournaments/"+tid+"/snapshot", e.director, "")
		if code != http.StatusOK {
			t.Fatalf("snapshot: want 200, got %d", code)
		}
		return tid, snap
	}

	t.Run("flagged match that is not featured", func(t *testing.T) {
		e := newTestEnv(t)
		tid, _ := overlayFor(t, e, true)
		// Reopen a clean match so there IS a live (in_progress) match to feature.
		ms := byLabel(t, e.matches(t, tid))
		e.reopenMatch(t, tid, ms["W1M2"]["id"].(string), "ov-live", "replay")
		_, snap := e.do(t, "GET", "/api/v1/tournaments/"+tid+"/snapshot", e.director, "")
		ov := snap["overlay"].(map[string]interface{})
		if _, ok := ov["reviewRequired"]; !ok {
			t.Fatalf("overlay must always carry reviewRequired: %v", ov)
		}
		if ov["reviewRequired"] != true {
			t.Errorf("featured match is clean but the bracket is flagged: want reviewRequired true, got %v", ov["reviewRequired"])
		}
	})

	t.Run("clean bracket", func(t *testing.T) {
		e := newTestEnv(t)
		_, snap := overlayFor(t, e, false)
		ov := snap["overlay"].(map[string]interface{})
		if got, ok := ov["reviewRequired"]; !ok || got != false {
			t.Errorf("clean bracket: want reviewRequired false, got %v (present=%v)", got, ok)
		}
	})

	t.Run("flagged bracket with nothing live", func(t *testing.T) {
		e := newTestEnv(t)
		_, snap := overlayFor(t, e, true)
		ov := snap["overlay"].(map[string]interface{})
		if _, live := ov["matchId"]; live {
			t.Fatalf("setup: expected no live match, got %v", ov["matchId"])
		}
		if ov["reviewRequired"] != true {
			t.Errorf("standing by with a flagged bracket: want reviewRequired true, got %v", ov["reviewRequired"])
		}
	})

	t.Run("public overlay carries it too", func(t *testing.T) {
		e := newTestEnv(t)
		tid, _ := overlayFor(t, e, true)
		e.do(t, "PATCH", "/api/v1/tournaments/"+tid, e.director, `{"visibility":"public"}`)
		code, ov := e.pubJSON(t, "/api/v1/public/tournaments/"+tid+"/overlay")
		if code != http.StatusOK {
			t.Fatalf("public overlay: want 200, got %d", code)
		}
		if ov["reviewRequired"] != true {
			t.Errorf("public overlay: want reviewRequired true, got %v", ov["reviewRequired"])
		}
	})
}
