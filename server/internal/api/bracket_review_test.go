package api

import (
	"net/http"
	"testing"
)

// byLabel indexes a match list by match label.
func byLabel(t *testing.T, ms []map[string]interface{}) map[string]map[string]interface{} {
	t.Helper()
	out := map[string]map[string]interface{}{}
	for _, m := range ms {
		out[str(m["matchLabel"])] = m
	}
	return out
}

// reopenMatch reopens a completed match (director + reason + idempotency key).
func (e *testEnv) reopenMatch(t *testing.T, tid, mid, key, reason string) {
	t.Helper()
	body := `{"reason":"` + reason + `"}`
	if code, r := e.doKey(t, "POST", "/api/v1/tournaments/"+tid+"/matches/"+mid+"/reopen", e.director, body, key); code != http.StatusOK {
		t.Fatalf("reopen %s: want 200, got %d (%v)", mid, code, r)
	}
}

// scoreMatch submits a result directly to a match that is already in
// in_progress/reopened (a fresh idempotency key, so an earlier submission's cached
// response is never replayed).
func (e *testEnv) scoreMatch(t *testing.T, tid, mid, winner, loser, key string) {
	t.Helper()
	body := `{"winnerEntrantId":"` + winner + `","loserEntrantId":"` + loser + `"}`
	if code, r := e.doKey(t, "POST", "/api/v1/tournaments/"+tid+"/matches/"+mid+"/result", e.director, body, key); code != http.StatusOK {
		t.Fatalf("score %s: want 200, got %d (%v)", mid, code, r)
	}
}

// hasAuditAction reports whether the tournament audit feed holds an entry for
// (entityId, action).
func (e *testEnv) hasAuditAction(t *testing.T, tid, entityID, action string) bool {
	t.Helper()
	code, aud := e.do(t, "GET", "/api/v1/tournaments/"+tid+"/audit", e.director, "")
	if code != http.StatusOK {
		t.Fatalf("audit: want 200, got %d", code)
	}
	for _, it := range aud["items"].([]interface{}) {
		m := it.(map[string]interface{})
		if str(m["entityId"]) == entityID && str(m["action"]) == action {
			return true
		}
	}
	return false
}

// sseEventCount counts the emitted events of a type for a tournament (the retained
// log is the replay window).
func (e *testEnv) sseEventCount(t *testing.T, tid, eventType string) int {
	t.Helper()
	var n int
	if err := e.api.DB.QueryRow(
		`SELECT COUNT(*) FROM sse_event_log WHERE tournament_id=? AND event_type=?`, tid, eventType).Scan(&n); err != nil {
		t.Fatalf("sse event count %s: %v", eventType, err)
	}
	return n
}

// resultVersions returns a match's recorded result versions.
func (e *testEnv) resultVersions(t *testing.T, tid, mid string) []interface{} {
	t.Helper()
	code, hist := e.do(t, "GET", "/api/v1/tournaments/"+tid+"/matches/"+mid+"/history", e.director, "")
	if code != http.StatusOK {
		t.Fatalf("history %s: want 200, got %d", mid, code)
	}
	return hist["versions"].([]interface{})
}

// correctedBracket is a played-out 4-player single-elimination bracket whose
// upstream match W1M1 was corrected after its winner had already played the final.
type correctedBracket struct {
	tid, finalID          string
	corrected, finalOther string // the final's participants once the correction landed
	staleWinner           string // the final's recorded winner: no longer a participant
}

// singleElimWithCorrectedUpstream plays out W1M1, W1M2 → W2M1, then reopens W1M1 and
// re-completes it with the other entrant — the collision option 3 records.
func (e *testEnv) singleElimWithCorrectedUpstream(t *testing.T) correctedBracket {
	t.Helper()
	tid, _ := e.startSingleElim(t, 4)
	e.playAll(t, tid, aWins)
	ms := byLabel(t, e.matches(t, tid))
	up, final := ms["W1M1"], ms["W2M1"]
	if up == nil || final == nil {
		t.Fatalf("expected W1M1 + W2M1, got %v", ms)
	}
	wrong, other := str(up["entrantAId"]), str(up["entrantBId"])
	if str(up["winnerEntrantId"]) != wrong || wrong == "" || other == "" {
		t.Fatalf("aWins should have advanced W1M1 slot a: %v", up)
	}
	cb := correctedBracket{
		tid: tid, finalID: final["id"].(string), corrected: other,
		finalOther:  str(final["entrantBId"]),
		staleWinner: str(final["winnerEntrantId"]),
	}
	if cb.staleWinner == "" || cb.finalOther == "" || str(final["entrantAId"]) != wrong {
		t.Fatalf("the final should have played the W1M1 winner: %v", final)
	}
	e.reopenMatch(t, tid, up["id"].(string), "rev-open-1", "wrong player advanced")
	e.scoreMatch(t, tid, up["id"].(string), other, wrong, "rev-res-1")
	// Read the correction back from the result versions: listMatches' "current
	// winner" cannot be used because two append-only rows end up with superseded_by
	// NULL after a reopen+re-submit (see OPEN-QUESTIONS, "Which result version is the
	// current winner after a reopen and re-submit?").
	vers := e.resultVersions(t, tid, up["id"].(string))
	if len(vers) != 2 || str(vers[1].(map[string]interface{})["winnerEntrantId"]) != other {
		t.Fatalf("upstream correction not recorded: %v", vers)
	}
	return cb
}

// TestReviewFlagOnCorrectedUpstreamSingleElim: correcting an upstream result must
// never silently rewrite the result it already fed, and the inconsistency must be
// recorded rather than hidden.
func TestReviewFlagOnCorrectedUpstreamSingleElim(t *testing.T) {
	e := newTestEnv(t)
	cb := e.singleElimWithCorrectedUpstream(t)
	final := byLabel(t, e.matches(t, cb.tid))["W2M1"]

	// 1. The played result is untouched.
	if final["state"] != "completed" {
		t.Errorf("downstream state: want completed, got %v", final["state"])
	}
	if got := str(final["winnerEntrantId"]); got != cb.staleWinner {
		t.Errorf("downstream winnerEntrantId: want the recorded winner %q, got %q", cb.staleWinner, got)
	}
	vers := e.resultVersions(t, cb.tid, cb.finalID)
	if len(vers) != 1 {
		t.Errorf("downstream result versions: want the single original result, got %d", len(vers))
	} else if v := vers[0].(map[string]interface{}); str(v["winnerEntrantId"]) != cb.staleWinner {
		t.Errorf("the original result row was rewritten: %v", vers[0])
	}

	// 2. The corrected winner reaches the flagged match, so it can be replayed; the
	//    other slot keeps the entrant that qualified there.
	if got := str(final["entrantAId"]); got != cb.corrected {
		t.Errorf("flagged match slot a: want the corrected winner %q, got %q", cb.corrected, got)
	}
	if got := str(final["entrantBId"]); got != cb.finalOther {
		t.Errorf("flagged match slot b: want it untouched (%q), got %q", cb.finalOther, got)
	}

	// 3. Recorded, not hidden: persistent flag, audit row, SSE event.
	if final["needsReview"] != true {
		t.Errorf("downstream match should be flagged for review: %v", final)
	}
	if !e.hasAuditAction(t, cb.tid, cb.finalID, "review_required") {
		t.Errorf("no review_required audit row for the flagged match")
	}
	if n := e.sseEventCount(t, cb.tid, "match.review_required"); n != 1 {
		t.Errorf("match.review_required events: want 1, got %d", n)
	}

	// 4. Idempotent per state: repeating the same correction neither duplicates the
	//    audit row/event nor moves a slot.
	e.reopenMatch(t, cb.tid, byLabel(t, e.matches(t, cb.tid))["W1M1"]["id"].(string), "rev-open-1b", "same correction again")
	e.scoreMatch(t, cb.tid, byLabel(t, e.matches(t, cb.tid))["W1M1"]["id"].(string), cb.corrected, cb.staleWinner, "rev-res-1b")
	again := byLabel(t, e.matches(t, cb.tid))["W2M1"]
	if again["needsReview"] != true || str(again["entrantAId"]) != cb.corrected {
		t.Errorf("repeating the correction should change nothing: %v", again)
	}
	if n := e.sseEventCount(t, cb.tid, "match.review_required"); n != 1 {
		t.Errorf("a repeated correction re-emitted match.review_required: want 1, got %d", n)
	}
}

// TestReviewFlagOnCorrectedUpstreamDoubleElim is the same collision on the
// double-elimination path: advanceDouble propagates the winner forward AND drops the
// loser into the losers bracket, and both downstream matches have already been
// played, so both must be flagged.
func TestReviewFlagOnCorrectedUpstreamDoubleElim(t *testing.T) {
	e := newTestEnv(t)
	tid := e.startDoubleElim(t, 4) // W1M1, W1M2 → W2M1; L1M1, L2M1; GF1
	e.playAll(t, tid, aWins)

	ms := byLabel(t, e.matches(t, tid))
	up := ms["W1M1"]
	if up == nil {
		t.Fatalf("expected W1M1, got %v", ms)
	}
	wrong, other := str(up["entrantAId"]), str(up["entrantBId"])
	if str(up["winnerEntrantId"]) != wrong || wrong == "" || other == "" {
		t.Fatalf("aWins should have advanced W1M1 slot a: %v", up)
	}

	before := map[string]map[string]interface{}{}
	for _, lbl := range []string{"W2M1", "L1M1", "GF1"} {
		m := ms[lbl]
		if m == nil {
			t.Fatalf("missing %s in %v", lbl, ms)
		}
		if m["state"] != "completed" {
			t.Fatalf("%s should be played out, got %v", lbl, m["state"])
		}
		before[lbl] = m
	}

	e.reopenMatch(t, tid, up["id"].(string), "revd-open-1", "wrong player advanced")
	e.scoreMatch(t, tid, up["id"].(string), other, wrong, "revd-res-1")

	after := byLabel(t, e.matches(t, tid))
	for _, lbl := range []string{"W2M1", "L1M1"} {
		m := after[lbl]
		if m["state"] != "completed" {
			t.Errorf("%s state: want completed, got %v", lbl, m["state"])
		}
		if got, want := str(m["winnerEntrantId"]), str(before[lbl]["winnerEntrantId"]); got != want {
			t.Errorf("%s winnerEntrantId: want the recorded winner %q, got %q", lbl, want, got)
		}
		if m["needsReview"] != true {
			t.Errorf("%s should be flagged for review: %v", lbl, m)
		}
		if !e.hasAuditAction(t, tid, m["id"].(string), "review_required") {
			t.Errorf("%s has no review_required audit row", lbl)
		}
		if vers := e.resultVersions(t, tid, m["id"].(string)); len(vers) != 1 {
			t.Errorf("%s result versions: want 1, got %d", lbl, len(vers))
		}
	}
	// The grand final was not re-fed by the correction, so it stays clean.
	if after["GF1"]["needsReview"] == true {
		t.Errorf("GF1 should not have been touched by the correction: %v", after["GF1"])
	}
	if n := e.sseEventCount(t, tid, "match.review_required"); n != 2 {
		t.Errorf("match.review_required events: want 2 (winner advance + loser drop), got %d", n)
	}
}

// TestReviewFlagRepairPath walks the documented manual repair path: reopen the
// flagged match, re-enter the corrected result, clear the flag (audited). Clearing is
// a director action and is refused when the match is not flagged.
func TestReviewFlagRepairPath(t *testing.T) {
	e := newTestEnv(t)
	cb := e.singleElimWithCorrectedUpstream(t)

	// Guards: clearing is director+ only.
	if code, _ := e.doKey(t, "POST", "/api/v1/tournaments/"+cb.tid+"/matches/"+cb.finalID+"/clear-review", e.scorekeeper, `{"reason":"x"}`, "rev-clear-spk"); code != http.StatusForbidden {
		t.Errorf("scorekeeper clear-review: want 403, got %d", code)
	}
	if code, _ := e.doKey(t, "POST", "/api/v1/tournaments/"+cb.tid+"/matches/"+cb.finalID+"/clear-review", e.viewer, `{}`, "rev-clear-vw"); code != http.StatusForbidden {
		t.Errorf("viewer clear-review: want 403, got %d", code)
	}
	if code, _ := e.doKey(t, "POST", "/api/v1/tournaments/"+cb.tid+"/matches/zz_nope/clear-review", e.director, `{}`, "rev-clear-missing"); code != http.StatusNotFound {
		t.Errorf("clear-review on an unknown match: want 404, got %d", code)
	}

	// Replay the flagged match with the participants the correction put in its slots.
	e.reopenMatch(t, cb.tid, cb.finalID, "rev-open-2", "replay with the corrected players")
	e.scoreMatch(t, cb.tid, cb.finalID, cb.corrected, cb.finalOther, "rev-res-2")
	replayed := byLabel(t, e.matches(t, cb.tid))["W2M1"]
	if replayed["state"] != "completed" {
		t.Fatalf("the repaired match should be re-completed, got %v", replayed["state"])
	}
	if replayed["needsReview"] != true {
		t.Fatalf("clearing must be explicit, not a side effect of re-submitting: %v", replayed)
	}
	vers := e.resultVersions(t, cb.tid, cb.finalID)
	if len(vers) != 2 {
		t.Fatalf("the replay should append a second result version, got %d", len(vers))
	}
	if got := str(vers[0].(map[string]interface{})["winnerEntrantId"]); got != cb.staleWinner {
		t.Errorf("the original result row must stay immutable, got %q", got)
	}
	if got := str(vers[1].(map[string]interface{})["winnerEntrantId"]); got != cb.corrected {
		t.Errorf("the replay result was not recorded: %v", vers[1])
	}

	// Clear it: audited, evented, and only once.
	body := `{"reason":"replayed with the corrected players"}`
	if code, r := e.doKey(t, "POST", "/api/v1/tournaments/"+cb.tid+"/matches/"+cb.finalID+"/clear-review", e.director, body, "rev-clear-1"); code != http.StatusOK {
		t.Fatalf("clear-review: want 200, got %d (%v)", code, r)
	}
	cleared := byLabel(t, e.matches(t, cb.tid))["W2M1"]
	if cleared["needsReview"] != false {
		t.Errorf("flag should be cleared: %v", cleared)
	}
	if !e.hasAuditAction(t, cb.tid, cb.finalID, "review_cleared") {
		t.Errorf("no review_cleared audit row")
	}
	if n := e.sseEventCount(t, cb.tid, "match.review_cleared"); n != 1 {
		t.Errorf("match.review_cleared events: want 1, got %d", n)
	}
	// The played result the repair kept is still the recorded one.
	if got := str(cleared["winnerEntrantId"]); got != cb.staleWinner {
		t.Errorf("clearing must not touch the result: winner %q", got)
	}
	// Clearing an unflagged match is not a transition.
	if code, r := e.doKey(t, "POST", "/api/v1/tournaments/"+cb.tid+"/matches/"+cb.finalID+"/clear-review", e.director, `{}`, "rev-clear-2"); code != http.StatusConflict {
		t.Errorf("clear-review on an unflagged match: want 409, got %d (%v)", code, r)
	}
}
