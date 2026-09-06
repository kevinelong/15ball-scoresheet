package api

import (
	"fmt"
	"net/http"
	"testing"
)

// startDoubleElim creates a tournament with n checked-in entrants and starts it.
// The division uses the default format (double_elimination).
func (e *testEnv) startDoubleElim(t *testing.T, n int) string {
	t.Helper()
	tid := e.mkOpenTournament(t) // division "Open" defaults to double_elimination
	for i := 0; i < n; i++ {
		_, resp := e.do(t, "POST", "/api/v1/tournaments/"+tid+"/entrants", e.director, fmt.Sprintf(`{"displayName":"P%02d"}`, i))
		eid := resp["entrant"].(map[string]interface{})["id"].(string)
		e.do(t, "PATCH", "/api/v1/tournaments/"+tid+"/entrants/"+eid, e.director, `{"state":"registered"}`)
		e.do(t, "POST", "/api/v1/tournaments/"+tid+"/entrants/"+eid+"/check-in", e.director, `{}`)
	}
	e.do(t, "PATCH", "/api/v1/tournaments/"+tid, e.director, `{"state":"registration_closed"}`)
	if code, _ := e.do(t, "PATCH", "/api/v1/tournaments/"+tid, e.director, `{"state":"in_progress"}`); code != http.StatusOK {
		t.Fatalf("start: want 200, got %d", code)
	}
	return tid
}

func (e *testEnv) matches(t *testing.T, tid string) []map[string]interface{} {
	t.Helper()
	_, list := e.do(t, "GET", "/api/v1/tournaments/"+tid+"/matches", e.director, "")
	var out []map[string]interface{}
	for _, it := range list["items"].([]interface{}) {
		out = append(out, it.(map[string]interface{}))
	}
	return out
}

// play assigns + starts + scores one match.
func (e *testEnv) playMatch(t *testing.T, tid, mid, winner, loser string) {
	t.Helper()
	e.do(t, "POST", "/api/v1/tournaments/"+tid+"/matches/"+mid+"/assign", e.director, `{"scorekeeperUserId":"u_scorekeeper@x.com"}`)
	e.do(t, "POST", "/api/v1/tournaments/"+tid+"/matches/"+mid+"/start", e.director, `{}`)
	body := `{"winnerEntrantId":"` + winner + `","loserEntrantId":"` + loser + `"}`
	if code, resp := e.doKey(t, "POST", "/api/v1/tournaments/"+tid+"/matches/"+mid+"/result", e.director, body, "res-"+mid); code != http.StatusOK {
		t.Fatalf("score %s: want 200, got %d (%v)", mid, code, resp)
	}
}

// playAll drives every ready match to completion. pick(a,b,label) returns (winner,loser).
func (e *testEnv) playAll(t *testing.T, tid string, pick func(a, b, label string) (string, string)) {
	t.Helper()
	for iter := 0; iter < 500; iter++ {
		played := false
		for _, m := range e.matches(t, tid) {
			if m["state"] != "scheduled" {
				continue
			}
			a, _ := m["entrantAId"].(string)
			b, _ := m["entrantBId"].(string)
			if a == "" || b == "" {
				continue // waiting on a feeder
			}
			w, l := pick(a, b, str(m["matchLabel"]))
			e.playMatch(t, tid, m["id"].(string), w, l)
			played = true
			break // advancement changes the set — re-fetch
		}
		if !played {
			return
		}
	}
	t.Fatal("playAll did not converge")
}

func str(v interface{}) string { s, _ := v.(string); return s }

// aWins: entrant_a always wins (winners champ wins GF1 → no reset).
func aWins(a, b, _ string) (string, string) { return a, b }

// TestDoubleElimFeederEdgesExposed: GET matches on a 4-player double-elim exposes
// the persisted feeder edges (migration 0010). Winners matches feed their winner
// forward and their loser down to the losers bracket; assert at least one match
// surfaces a non-null feeder edge.
func TestDoubleElimFeederEdgesExposed(t *testing.T) {
	e := newTestEnv(t)
	tid := e.startDoubleElim(t, 4)

	byLabel := map[string]map[string]interface{}{}
	anyEdge := false
	for _, m := range e.matches(t, tid) {
		byLabel[str(m["matchLabel"])] = m
		if m["feedsWinnerMatch"] != nil || m["feedsLoserMatch"] != nil {
			anyEdge = true
		}
	}
	if !anyEdge {
		t.Fatalf("expected at least one match to expose a feeder edge")
	}
	// A round-1 winners match feeds its winner forward and its loser into L.
	w1 := byLabel["W1M1"]
	if w1 == nil {
		t.Fatalf("missing W1M1")
	}
	if w1["feedsWinnerMatch"] == nil {
		t.Errorf("W1M1 should feed its winner forward, got nil")
	}
	if w1["feedsLoserMatch"] == nil {
		t.Errorf("W1M1 should feed its loser to the losers bracket, got nil")
	}
	// slots are 0/1 int64 → JSON numbers; if present they must decode as numbers.
	if v := w1["feedsWinnerSlot"]; v != nil {
		if _, ok := v.(float64); !ok {
			t.Errorf("feedsWinnerSlot should be a number, got %T", v)
		}
	}
}

func TestDoubleElimStructure4(t *testing.T) {
	e := newTestEnv(t)
	tid := e.startDoubleElim(t, 4)
	labels := map[string]bool{}
	for _, m := range e.matches(t, tid) {
		labels[str(m["matchLabel"])] = true
	}
	for _, want := range []string{"W1M1", "W1M2", "W2M1", "L1M1", "L2M1", "GF1"} {
		if !labels[want] {
			t.Errorf("missing match %s (got %v)", want, labels)
		}
	}
	if len(labels) != 6 {
		t.Fatalf("want 6 matches for 4-player double-elim, got %d (%v)", len(labels), labels)
	}
}

func TestDoubleElimPlaythrough4(t *testing.T) {
	e := newTestEnv(t)
	tid := e.startDoubleElim(t, 4)
	e.playAll(t, tid, aWins)
	// winners champ won GF1 → no GF2, every match completed → tournament completes.
	for _, m := range e.matches(t, tid) {
		if m["state"] != "completed" {
			t.Fatalf("match %s not completed: %s", str(m["matchLabel"]), m["state"])
		}
		if str(m["matchLabel"]) == "GF2" {
			t.Fatalf("GF2 should not exist when the winners champ wins GF1")
		}
	}
	if code, _ := e.do(t, "PATCH", "/api/v1/tournaments/"+tid, e.director, `{"state":"completed"}`); code != http.StatusOK {
		t.Fatalf("complete tournament: want 200, got %d", code)
	}
}

func TestDoubleElimGrandFinalReset(t *testing.T) {
	e := newTestEnv(t)
	tid := e.startDoubleElim(t, 4)
	// Losers champ (slot b) wins GF1 → GF2 reset must be created.
	e.playAll(t, tid, func(a, b, label string) (string, string) {
		if label == "GF1" {
			return b, a // losers champ wins
		}
		return a, b
	})
	sawGF2 := false
	for _, m := range e.matches(t, tid) {
		if str(m["matchLabel"]) == "GF2" {
			sawGF2 = true
			if m["state"] != "completed" {
				t.Fatalf("GF2 not completed: %s", m["state"])
			}
		}
	}
	if !sawGF2 {
		t.Fatalf("expected a GF2 reset match after losers champ won GF1")
	}
	if code, _ := e.do(t, "PATCH", "/api/v1/tournaments/"+tid, e.director, `{"state":"completed"}`); code != http.StatusOK {
		t.Fatalf("complete after reset: want 200, got %d", code)
	}
}

func TestDoubleElimByes3(t *testing.T) {
	e := newTestEnv(t)
	tid := e.startDoubleElim(t, 3) // 1 bye → auto-resolved
	e.playAll(t, tid, aWins)
	for _, m := range e.matches(t, tid) {
		if m["state"] != "completed" {
			t.Fatalf("match %s not completed: %s", str(m["matchLabel"]), m["state"])
		}
	}
	if code, _ := e.do(t, "PATCH", "/api/v1/tournaments/"+tid, e.director, `{"state":"completed"}`); code != http.StatusOK {
		t.Fatalf("complete 3-player: want 200, got %d", code)
	}
}

func TestDoubleElimEight(t *testing.T) {
	e := newTestEnv(t)
	tid := e.startDoubleElim(t, 8)
	// 8-player double-elim: W(4+2+1=7) + L(2*(3-1)=4 rounds: 2+2+1+1=6) + GF1 = 14.
	if got := len(e.matches(t, tid)); got != 14 {
		t.Fatalf("want 14 matches for 8-player double-elim, got %d", got)
	}
	e.playAll(t, tid, aWins)
	for _, m := range e.matches(t, tid) {
		if m["state"] != "completed" {
			t.Fatalf("match %s not completed: %s", str(m["matchLabel"]), m["state"])
		}
	}
	if code, _ := e.do(t, "PATCH", "/api/v1/tournaments/"+tid, e.director, `{"state":"completed"}`); code != http.StatusOK {
		t.Fatalf("complete 8-player: want 200, got %d", code)
	}
}
