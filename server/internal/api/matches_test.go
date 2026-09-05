package api

import (
	"net/http"
	"testing"
)

// mkStartedTournament: 2 checked-in entrants, registration closed, then started
// (bracket generated). Returns tournament id.
func (e *testEnv) mkStartedTournament(t *testing.T) string {
	t.Helper()
	tid := e.mkOpenTournament(t)
	for _, name := range []string{"Ann", "Bob"} {
		_, resp := e.do(t, "POST", "/api/v1/tournaments/"+tid+"/entrants", e.director, `{"displayName":"`+name+`"}`)
		eid := resp["entrant"].(map[string]interface{})["id"].(string)
		e.do(t, "PATCH", "/api/v1/tournaments/"+tid+"/entrants/"+eid, e.director, `{"state":"registered"}`)
		e.do(t, "POST", "/api/v1/tournaments/"+tid+"/entrants/"+eid+"/check-in", e.director, `{}`)
	}
	e.do(t, "PATCH", "/api/v1/tournaments/"+tid, e.director, `{"state":"registration_closed"}`)
	if code, _ := e.do(t, "PATCH", "/api/v1/tournaments/"+tid, e.director, `{"state":"in_progress"}`); code != http.StatusOK {
		t.Fatalf("start tournament: want 200, got %d", code)
	}
	return tid
}

func TestBracketGenerationAndMatchFlow(t *testing.T) {
	e := newTestEnv(t)
	tid := e.mkStartedTournament(t)

	// bracket generated → exactly 1 round-1 match for 2 entrants
	code, list := e.do(t, "GET", "/api/v1/tournaments/"+tid+"/matches", e.viewer, "")
	items := list["items"].([]interface{})
	if code != http.StatusOK || len(items) != 1 {
		t.Fatalf("want 1 match after start, got %d items (code %d)", len(items), code)
	}
	m := items[0].(map[string]interface{})
	mid := m["id"].(string)
	if m["state"] != "scheduled" {
		t.Fatalf("new match should be scheduled, got %v", m["state"])
	}

	// assign a non-scorekeeper user (viewer) → 400 invalid_scorekeeper
	if code, _ := e.do(t, "POST", "/api/v1/tournaments/"+tid+"/matches/"+mid+"/assign", e.director, `{"scorekeeperUserId":"u_viewer@x.com"}`); code != http.StatusBadRequest {
		t.Fatalf("assign non-scorekeeper: want 400, got %d", code)
	}
	// assign the real scorekeeper → 200
	if code, _ := e.do(t, "POST", "/api/v1/tournaments/"+tid+"/matches/"+mid+"/assign", e.director, `{"scorekeeperUserId":"u_scorekeeper@x.com"}`); code != http.StatusOK {
		t.Fatalf("assign scorekeeper: want 200, got %d", code)
	}
	// viewer cannot start; assigned scorekeeper can
	if code, _ := e.do(t, "POST", "/api/v1/tournaments/"+tid+"/matches/"+mid+"/start", e.viewer, `{}`); code != http.StatusForbidden {
		t.Fatalf("viewer start: want 403, got %d", code)
	}
	if code, _ := e.do(t, "POST", "/api/v1/tournaments/"+tid+"/matches/"+mid+"/start", e.scorekeeper, `{}`); code != http.StatusOK {
		t.Fatalf("scorekeeper start: want 200, got %d", code)
	}
	// completing the tournament while the match is open → 409
	if code, _ := e.do(t, "PATCH", "/api/v1/tournaments/"+tid, e.director, `{"state":"completed"}`); code != http.StatusConflict {
		t.Fatalf("complete with open match: want 409, got %d", code)
	}
	// history endpoint works (no results yet)
	if code, _ := e.do(t, "GET", "/api/v1/tournaments/"+tid+"/matches/"+mid+"/history", e.viewer, ""); code != http.StatusOK {
		t.Fatalf("history: want 200, got %d", code)
	}
}
