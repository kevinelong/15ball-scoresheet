package api

import (
	"net/http"
	"testing"
)

// mkOpenTournament creates a tournament with a division and opens registration.
func (e *testEnv) mkOpenTournament(t *testing.T) string {
	t.Helper()
	_, resp := e.do(t, "POST", "/api/v1/tournaments", e.director, `{"name":"Reg Open"}`)
	id := resp["tournament"].(map[string]interface{})["id"].(string)
	e.do(t, "POST", "/api/v1/tournaments/"+id+"/divisions", e.director, `{"name":"Open"}`)
	e.do(t, "PATCH", "/api/v1/tournaments/"+id, e.director, `{"state":"registration_open"}`)
	return id
}

func TestEntrantLifecycle(t *testing.T) {
	e := newTestEnv(t)
	tid := e.mkOpenTournament(t)

	// viewer cannot create entrant
	if code, _ := e.do(t, "POST", "/api/v1/tournaments/"+tid+"/entrants", e.viewer, `{"displayName":"Ann"}`); code != http.StatusForbidden {
		t.Fatalf("viewer create entrant: want 403, got %d", code)
	}
	// director creates → pending
	code, resp := e.do(t, "POST", "/api/v1/tournaments/"+tid+"/entrants", e.director, `{"displayName":"Ann Jones"}`)
	if code != http.StatusCreated {
		t.Fatalf("create entrant: want 201, got %d", code)
	}
	eid := resp["entrant"].(map[string]interface{})["id"].(string)
	if resp["entrant"].(map[string]interface{})["state"] != "pending" {
		t.Fatalf("new entrant should be pending")
	}
	// duplicate display name → 409
	if code, _ := e.do(t, "POST", "/api/v1/tournaments/"+tid+"/entrants", e.director, `{"displayName":"Ann Jones"}`); code != http.StatusConflict {
		t.Fatalf("dup display name: want 409, got %d", code)
	}
	// check-in before registered → invalid transition 409
	if code, _ := e.do(t, "POST", "/api/v1/tournaments/"+tid+"/entrants/"+eid+"/check-in", e.director, `{}`); code != http.StatusConflict {
		t.Fatalf("checkin while pending: want 409, got %d", code)
	}
	// pending→registered
	if code, _ := e.do(t, "PATCH", "/api/v1/tournaments/"+tid+"/entrants/"+eid, e.director, `{"state":"registered"}`); code != http.StatusOK {
		t.Fatalf("register: want 200, got %d", code)
	}
	// now check-in → 200; repeat safe → 200
	if code, _ := e.do(t, "POST", "/api/v1/tournaments/"+tid+"/entrants/"+eid+"/check-in", e.director, `{}`); code != http.StatusOK {
		t.Fatalf("checkin: want 200, got %d", code)
	}
	if code, _ := e.do(t, "POST", "/api/v1/tournaments/"+tid+"/entrants/"+eid+"/check-in", e.director, `{}`); code != http.StatusOK {
		t.Fatalf("checkin repeat: want 200, got %d", code)
	}
	// disqualify without reason → 400; with reason → 200
	if code, _ := e.do(t, "PATCH", "/api/v1/tournaments/"+tid+"/entrants/"+eid, e.director, `{"state":"disqualified"}`); code != http.StatusBadRequest {
		t.Fatalf("DQ w/o reason: want 400, got %d", code)
	}
	if code, _ := e.do(t, "PATCH", "/api/v1/tournaments/"+tid+"/entrants/"+eid, e.director, `{"state":"disqualified","reason":"no-show"}`); code != http.StatusOK {
		t.Fatalf("DQ w/ reason: want 200, got %d", code)
	}
	// archive → 200, excluded from default list
	if code, _ := e.do(t, "POST", "/api/v1/tournaments/"+tid+"/entrants/"+eid+"/archive", e.director, `{}`); code != http.StatusOK {
		t.Fatalf("archive entrant: want 200, got %d", code)
	}
	if _, list := e.do(t, "GET", "/api/v1/tournaments/"+tid+"/entrants", e.viewer, ""); len(list["items"].([]interface{})) != 0 {
		t.Fatalf("archived entrant should be excluded")
	}
}
