package api

import (
	"net/http"
	"testing"
)

// TestPatchEntrantMetadata verifies that a metadata-only PATCH can set fargo,
// email, and phone together and that the response + a later GET reflect them.
func TestPatchEntrantMetadata(t *testing.T) {
	e := newTestEnv(t)
	tid := e.mkOpenTournament(t)

	_, resp := e.do(t, "POST", "/api/v1/tournaments/"+tid+"/entrants", e.director, `{"displayName":"Pat Metadata"}`)
	eid := resp["entrant"].(map[string]interface{})["id"].(string)

	code, patched := e.do(t, "PATCH", "/api/v1/tournaments/"+tid+"/entrants/"+eid, e.director,
		`{"fargo":555,"email":"pat@x.com","phone":"+15035551212"}`)
	if code != http.StatusOK {
		t.Fatalf("patch metadata: want 200, got %d", code)
	}
	ent := patched["entrant"].(map[string]interface{})
	if ent["fargo"].(float64) != 555 || ent["email"] != "pat@x.com" || ent["phone"] != "+15035551212" {
		t.Fatalf("patch response did not reflect new values: %v", ent)
	}

	// GET (via list) reflects the persisted values too.
	_, list := e.do(t, "GET", "/api/v1/tournaments/"+tid+"/entrants", e.director, "")
	items := list["items"].([]interface{})
	var found map[string]interface{}
	for _, it := range items {
		m := it.(map[string]interface{})
		if m["id"] == eid {
			found = m
		}
	}
	if found == nil {
		t.Fatalf("entrant %s not found in list", eid)
	}
	if found["fargo"].(float64) != 555 || found["email"] != "pat@x.com" || found["phone"] != "+15035551212" {
		t.Fatalf("GET did not reflect patched values: %v", found)
	}
}
