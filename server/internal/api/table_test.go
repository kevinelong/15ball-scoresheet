package api

import (
	"net/http"
	"testing"
)

// TestTableAssignment verifies tableRef is persisted on assign, surfaced on the
// match + overlay, and preserved (COALESCE) when a later assign omits it.
func TestTableAssignment(t *testing.T) {
	e := newTestEnv(t)
	tid, mid, _, _ := e.mkLiveMatchUnstarted(t)

	// assign with a table ref
	code, resp := e.do(t, "POST", "/api/v1/tournaments/"+tid+"/matches/"+mid+"/assign", e.director,
		`{"scorekeeperUserId":"u_scorekeeper@x.com","tableRef":"Diamond 3"}`)
	if code != http.StatusOK {
		t.Fatalf("assign: want 200, got %d", code)
	}
	if got := resp["match"].(map[string]interface{})["tableRef"]; got != "Diamond 3" {
		t.Fatalf("tableRef not persisted: got %v", got)
	}

	// re-assign without tableRef → keeps the prior table (COALESCE)
	_, resp = e.do(t, "POST", "/api/v1/tournaments/"+tid+"/matches/"+mid+"/assign", e.director,
		`{"scorekeeperUserId":"u_scorekeeper@x.com"}`)
	if got := resp["match"].(map[string]interface{})["tableRef"]; got != "Diamond 3" {
		t.Fatalf("tableRef should be preserved when omitted: got %v", got)
	}

	// start the match, then the public overlay should expose the table
	e.do(t, "POST", "/api/v1/tournaments/"+tid+"/matches/"+mid+"/start", e.scorekeeper, `{}`)
	e.do(t, "PATCH", "/api/v1/tournaments/"+tid, e.director, `{"visibility":"public"}`)
	code, ov := e.do(t, "GET", "/api/v1/public/tournaments/"+tid+"/overlay", "", "")
	if code != http.StatusOK {
		t.Fatalf("overlay: want 200, got %d", code)
	}
	if ov["tableRef"] != "Diamond 3" {
		t.Fatalf("overlay tableRef: got %v", ov["tableRef"])
	}
}
