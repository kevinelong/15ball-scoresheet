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
// in_progress/reopened (a fresh idempotency key, so the earlier submission's
// cached response is never replayed).
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

// sseEventCount counts the emitted events of a type for a tournament (the SSE
// replay window is the log itself).
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

// TestReviewFlagOnCorrectedUpstreamSingleElim drives the option-3 flow end to end
// on a single-elimination bracket: a director reopens an upstream match whose
// winner already played downstream and re-completes it with the other winner. The
// played downstream result must survive untouched, the inconsistency must be
// recorded (flag + audit + SSE), and the documented repair path — reopen the
// downstream match, re-enter the corrected result, clear the flag — must resolve it.
func TestReviewFlagOnCorrectedUpstreamSingleElim(t *testing.T) {
	e := newTestEnv(t)
	tid, _ := e.startSingleElim(t, 4) // W1M1, W1M2 → W2M1 (the final)
	e.playAll(t, tid, aWins)

	ms := byLabel(t, e.matches(t, tid))
	up, final := ms["W1M1"], ms["W2M1"]
	if up == nil || final == nil {
		t.Fatalf("expected W1M1 + W2M1, got %v", ms)
	}
	upID, finalID := up["id"].(string), final["id"].(string)

	wrong, other := str(up["entrantAId"]), str(up["entrantBId"])
	if str(up["winnerEntrantId"]) != wrong || wrong == "" || other == "" {
		t.Fatalf("aWins should have advanced W1M1 slot a: %v", up)
	}
	origFinalWinner, origFinalB := str(final["winnerEntrantId"]), str(final["entrantBId"])
	if origFinalWinner == "" || origFinalB == "" || str(final["entrantAId"]) != wrong {
		t.Fatalf("the final should have played the W1M1 winner: %v", final)
	}

	// 1. Correct the upstream match: reopen it and re-complete it with the other winner.
	e.reopenMatch(t, tid, upID, "rev-open-1", "wrong player advanced")
	e.scoreMatch(t, tid, upID, other, wrong, "rev-res-1")

	// Read the correction back from the result versions: listMatches' "current
	// winner" cannot be used here because two append-only rows end up with
	// superseded_by NULL after a reopen+re-submit (see OPEN-QUESTIONS, "Which
	// result version is the current winner after a reopen and re-submit?").
	upVersions := e.resultVersions(t, tid, upID)
	if len(upVersions) != 2 {
		t.Fatalf("upstream result versions: want 2, got %d", len(upVersions))
	}
	if v := upVersions[1].(map[string]interface{}); str(v["winnerEntrantId"]) != other {
		t.Fatalf("upstream correction not recorded: %v", upVersions[1])
	}
	if got := byLabel(t, e.matches(t, tid))["W1M1"]["state"]; got != "completed" {
		t.Fatalf("the reopened upstream match should be re-completed, got %v", got)
	}

	final = byLabel(t, e.matches(t, tid))["W2M1"]

	// 2. The played downstream result is never rewritten.
	if final["state"] != "completed" {
		t.Errorf("downstream state: want completed, got %v", final["state"])
	}
	if got := str(final["winnerEntrantId"]); got != origFinalWinner {
		t.Errorf("downstream winnerEntrantId: want the recorded winner %q, got %q", origFinalWinner, got)
	}
	if versions := e.resultVersions(t, tid, finalID); len(versions) != 1 {
		t.Errorf("downstream result versions: want the single original result, got %d", len(versions))
	} else if v := versions[0].(map[string]interface{}); str(v["winnerEntrantId"]) != origFinalWinner {
		t.Errorf("original result row was rewritten: %v", versions[0])
	}

	// 3. The corrected winner reaches the flagged match, so it can be replayed;
	//    the other slot keeps the entrant that qualified there.
	if got := str(final["entrantAId"]); got != other {
		t.Errorf("flagged match slot a: want the corrected winner %q, got %q", other, got)
	}
	if got := str(final["entrantBId"]); got != origFinalB {
		t.Errorf("flagged match slot b: want it untouched (%q), got %q", origFinalB, got)
	}

	// 4. The inconsistency is recorded: persistent flag, audit row, SSE event.
	if final["needsReview"] != true {
		t.Errorf("downstream match should be flagged for review: %v", final)
	}
	if !e.hasAuditAction(t, tid, finalID, "review_required") {
		t.Errorf("no review_required audit row for the flagged match")
	}
	if n := e.sseEventCount(t, tid, "match.review_required"); n != 1 {
		t.Errorf("match.review_required events: want 1, got %d", n)
	}
	// The flag is idempotent per state: re-correcting the same slot must not pile
	// up duplicate audit rows or events.
	e.reopenMatch(t, tid, upID, "rev-open-1b", "same correction again")
	e.scoreMatch(t, tid, upID, other, wrong, "rev-res-1b")
	if !e.hasAuditAction(t, tid, finalID, "review_required") {
		t.Errorf("review_required audit row disappeared")
	}
	if n := e.sseEventCount(t, tid, "match.review_required"); n != 1 {
		t.Errorf("a second blocked write re-emitted match.review_required: want 1, got %d", n)
	}

	// 5. Repair path. Clearing is a director+ action and is refused while the flag
	//    is not set / by a non-director.
	if code, _ := e.doKey(t, "POST", "/api/v1/tournaments/"+tid+"/matches/"+finalID+"/clear-review", e.scorekeeper, `{"reason":"x"}`, "rev-clear-0"); code != http.StatusForbidden {
		t.Errorf("scorekeeper clear-review: want 403, got %d", code)
	}
	e.reopenMatch(t, tid, finalID, "rev-open-2", "replay with the corrected players")
	e.scoreMatch(t, tid, finalID, other, origFinalB, "rev-res-2")
	replayed := byLabel(t, e.matches(t, tid))["W2M1"]
	if replayed["state"] != "completed" {
		t.Fatalf("the repaired match should be re-completed, got %v", replayed["state"])
	}
	if replayed["needsReview"] != true {
		t.Fatalf("clearing must be explicit, not a side effect of re-submitting: %v", replayed)
	}
	versions := e.resultVersions(t, tid, finalID)
	if len(versions) != 2 {
		t.Fatalf("replay should append a second result version, got %d", len(versions))
	}
	if v := versions[1].(map[string]interface{}); str(v["winnerEntrantId"]) != other {
		t.Errorf("replay result not recorded: %v", versions[1])
	}
	if got := str(versions[0].(map[string]interface{})["winnerEntrantId"]); got != origFinalWinner {
		t.Errorf("the original result row must stay immutable, got %q", got)
	}
	if code, r := e.doKey(t, "POST", "/api/v1/tournaments/"+tid+"/matches/"+finalID+"/clear-review", e.director, `{"reason":"replayed with the corrected players"}`, "rev-clear-1"); code != http.StatusOK {
		t.Fatalf("clear-review: want 200, got %d (%v)", code, r)
	}
	cleared := byLabel(t, e.matches(t, tid))["W2M1"]
	if cleared["needsReview"] != false {
		t.Errorf("flag should be cleared: %v", cleared)
	}
	if !e.hasAuditAction(t, tid, finalID, "review_cleared") {
		t.Errorf("no review_cleared audit row")
	}
	if n := e.sseEventCount(t, tid, "match.review_cleared"); n != 1 {
		t.Errorf("match.review_cleared events: want 1, got %d", n)
	}
	// Clearing an unflagged match is not a transition.
	if code, r := e.doKey(t, "POST", "/api/v1/tournaments/"+tid+"/matches/"+finalID+"/clear-review", e.director, `{}`, "rev-clear-2"); code != http.StatusConflict {
		t.Errorf("clear-review on an unflagged match: want 409, got %d (%v)", code, r)
	}
}

// TestReviewFlagOnCorrectedUpstreamDoubleElim is the same collision on the
// double-elimination path: advanceDouble propagates the winner forward AND drops
// the loser into the losers bracket, and both downstream matches have already been
// played, so both must be flagged instead of quietly rewritten.
func TestReviewFlagOnCorrectedUpstreamDoubleElim(t *testing.T) {
	e := newTestEnv(t)
	tid := e.startDoubleElim(t, 4) // W1M1, W1M2 → W2M1; L1M1, L2M1; GF1
	e.playAll(t, tid, aWins)

	ms := byLabel(t, e.matches(t, tid))
	up := ms["W1M1"]
	if up == nil {
		t.Fatalf("expected W1M1, got %v", ms)
	}
	upID := up["id"].(string)
	wrong, other := str(up["entrantAId"]), str(up["entrantBId"])
	if str(up["winnerEntrantId"]) != wrong {
		t.Fatalf("aWins should have advanced W1M1 slot a: %v", up)
	}

	// Snapshot both downstream matches before the correction.
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
	if str(before["W2M1"]["feedsWinnerMatch"]) == "" {
		t.Fatalf("W2M1 should carry a winner edge to GF1")
	}

	e.reopenMatch(t, tid, upID, "revd-open-1", "wrong player advanced")
	e.scoreMatch(t, tid, upID, other, wrong, "revd-res-1")

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
	}
	// The grand final itself was not re-fed by the correction, so it stays clean.
	if after["GF1"]["needsReview"] == true {
		t.Errorf("GF1 should not have been touched by the correction: %v", after["GF1"])
	}
	if n := e.sseEventCount(t, tid, "match.review_required"); n != 2 {
		t.Errorf("match.review_required events: want 2 (winner + loser drop), got %d", n)
	}
	// Distinct matters: the blocked rewrite must be explainable from the audit trail.
	for _, lbl := range []string{"W2M1", "L1M1"} {
		if vers := e.resultVersions(t, tid, after[lbl]["id"].(string)); len(vers) != 1 {
			t.Errorf("%s result versions: want 1, got %d", lbl, len(vers))
		}
	}
}

// TestReviewFlagClearedOnlyOnFlaggedMatch covers the clear-review guards that do
// not depend on a bracket: the endpoint refuses a match that is not flagged and a
// director-only caller.
func TestReviewFlagClearedOnlyOnFlaggedMatch(t *testing.T) {
	e := newTestEnv(t)
	tid := e.startDoubleElim(t, 4)
	e.playAll(t, tid, aWins)
	mid := byLabel(t, e.matches(t, tid))["W2M1"]["id"].(string)

	if code, _ := e.doKey(t, "POST", "/api/v1/tournaments/"+tid+"/matches/"+mid+"/clear-review", e.director, `{}`, "rev-empty"); code != http.StatusConflict {
		t.Errorf("clear-review on an unflagged match: want 409, got %d", code)
	}
	if code, _ := e.doKey(t, "POST", "/api/v1/tournaments/"+tid+"/matches/"+mid+"/clear-review", e.viewer, `{}`, "rev-viewer"); code != http.StatusForbidden {
		t.Errorf("viewer clear-review: want 403, got %d", code)
	}
	if code, _ := e.doKey(t, "POST", "/api/v1/tournaments/"+tid+"/matches/zz_nope/clear-review", e.director, `{}`, "rev-missing"); code != http.StatusNotFound {
		t.Errorf("clear-review on an unknown match: want 404, got %d", code)
	}
}
