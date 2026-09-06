package api

import (
	"fmt"
	"net/http"
	"testing"
)

// TestManualSeedOverridesFargo verifies that an explicit seed:1 on the LOWEST-Fargo
// entrant beats Fargo ordering and earns the #1 seed (W1M1 slot A).
func TestManualSeedOverridesFargo(t *testing.T) {
	e := newTestEnv(t)
	tid := e.mkOpenTournament(t)

	fargos := []int{700, 400, 600, 500}
	byFargo := map[int]string{}
	for i, f := range fargos {
		body := fmt.Sprintf(`{"displayName":"P%d","fargo":%d}`, i, f)
		if f == 400 { // lowest Fargo gets the manual #1 seed
			body = fmt.Sprintf(`{"displayName":"P%d","fargo":%d,"seed":1}`, i, f)
		}
		code, resp := e.do(t, "POST", "/api/v1/tournaments/"+tid+"/entrants", e.director, body)
		if code != http.StatusCreated {
			t.Fatalf("create P%d: want 201, got %d", i, code)
		}
		ent := resp["entrant"].(map[string]interface{})
		byFargo[f] = ent["id"].(string)
		eid := ent["id"].(string)
		e.do(t, "PATCH", "/api/v1/tournaments/"+tid+"/entrants/"+eid, e.director, `{"state":"registered"}`)
		e.do(t, "POST", "/api/v1/tournaments/"+tid+"/entrants/"+eid+"/check-in", e.director, `{}`)
	}
	e.do(t, "PATCH", "/api/v1/tournaments/"+tid, e.director, `{"state":"registration_closed"}`)
	if code, _ := e.do(t, "PATCH", "/api/v1/tournaments/"+tid, e.director, `{"state":"in_progress"}`); code != http.StatusOK {
		t.Fatalf("start: want 200, got %d", code)
	}

	// The manually seeded (400-Fargo) entrant must be W1M1 slot A, despite the lowest Fargo.
	var w1m1a string
	for _, m := range e.matches(t, tid) {
		if str(m["matchLabel"]) == "W1M1" {
			w1m1a, _ = m["entrantAId"].(string)
		}
	}
	if w1m1a != byFargo[400] {
		t.Fatalf("manual seed should override Fargo; W1M1.a=%s want %s (the 400-Fargo seed:1 entrant)", w1m1a, byFargo[400])
	}
}
