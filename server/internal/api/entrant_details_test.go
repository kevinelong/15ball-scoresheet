package api

import (
	"fmt"
	"net/http"
	"testing"
)

// TestEntrantDetailsAndFargoSeeding verifies the optional entrant fields round-trip
// and that a higher Fargo rating earns the #1 seed (W1M1 slot A).
func TestEntrantDetailsAndFargoSeeding(t *testing.T) {
	e := newTestEnv(t)
	tid := e.mkOpenTournament(t)

	fargos := []int{700, 400, 600, 500}
	byFargo := map[int]string{}
	for i, f := range fargos {
		code, resp := e.do(t, "POST", "/api/v1/tournaments/"+tid+"/entrants", e.director,
			fmt.Sprintf(`{"displayName":"P%d","fargo":%d,"email":"p%d@x.com","externalId":"ext%d"}`, i, f, i, i))
		if code != http.StatusCreated {
			t.Fatalf("create P%d: want 201, got %d", i, code)
		}
		ent := resp["entrant"].(map[string]interface{})
		byFargo[f] = ent["id"].(string)
		if i == 0 { // round-trip the details on the first one
			if ent["fargo"].(float64) != float64(f) || ent["email"] != "p0@x.com" || ent["externalId"] != "ext0" {
				t.Fatalf("entrant details not stored: %v", ent)
			}
		}
		eid := ent["id"].(string)
		e.do(t, "PATCH", "/api/v1/tournaments/"+tid+"/entrants/"+eid, e.director, `{"state":"registered"}`)
		e.do(t, "POST", "/api/v1/tournaments/"+tid+"/entrants/"+eid+"/check-in", e.director, `{}`)
	}
	e.do(t, "PATCH", "/api/v1/tournaments/"+tid, e.director, `{"state":"registration_closed"}`)
	if code, _ := e.do(t, "PATCH", "/api/v1/tournaments/"+tid, e.director, `{"state":"in_progress"}`); code != http.StatusOK {
		t.Fatalf("start: want 200, got %d", code)
	}

	// Seed 1 (W1M1 slot A) must be the highest-Fargo entrant.
	var w1m1a string
	for _, m := range e.matches(t, tid) {
		if str(m["matchLabel"]) == "W1M1" {
			w1m1a, _ = m["entrantAId"].(string)
		}
	}
	if w1m1a != byFargo[700] {
		t.Fatalf("top seed should be the 700-Fargo entrant; W1M1.a=%s want %s", w1m1a, byFargo[700])
	}
}
