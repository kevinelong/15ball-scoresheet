package api

import (
	"net/http"
	"testing"
)

// TestGetTournamentBySlug verifies the shareable-link lookup: GET by the
// human-readable slug resolves the same tournament as by id.
func TestGetTournamentBySlug(t *testing.T) {
	e := newTestEnv(t)
	_, resp := e.do(t, "POST", "/api/v1/tournaments", e.director, `{"name":"Fall Open"}`)
	trn := resp["tournament"].(map[string]interface{})
	id := trn["id"].(string)
	slug := trn["slug"].(string)
	if slug == "" {
		t.Fatalf("expected a slug on the created tournament")
	}
	code, got := e.do(t, "GET", "/api/v1/tournaments/"+slug, e.director, "")
	if code != http.StatusOK {
		t.Fatalf("GET by slug %q: want 200, got %d", slug, code)
	}
	if got["tournament"].(map[string]interface{})["id"] != id {
		t.Fatalf("GET by slug resolved a different tournament")
	}
}
