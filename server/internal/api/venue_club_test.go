package api

import (
	"net/http"
	"testing"
)

// TestTournamentVenueClub verifies the optional venue/club labels round-trip and
// are omitted (null) when not provided.
func TestTournamentVenueClub(t *testing.T) {
	e := newTestEnv(t)

	code, resp := e.do(t, "POST", "/api/v1/tournaments", e.director,
		`{"name":"Labor Day","venue":"Main Room","club":"Columbia Cue Club"}`)
	if code != http.StatusCreated {
		t.Fatalf("create with venue/club: want 201, got %d", code)
	}
	trn := resp["tournament"].(map[string]interface{})
	if trn["venue"] != "Main Room" || trn["club"] != "Columbia Cue Club" {
		t.Fatalf("venue/club not stored: %v / %v", trn["venue"], trn["club"])
	}

	// Omitted → null in the JSON.
	_, resp2 := e.do(t, "POST", "/api/v1/tournaments", e.director, `{"name":"No Labels"}`)
	trn2 := resp2["tournament"].(map[string]interface{})
	if trn2["venue"] != nil || trn2["club"] != nil {
		t.Fatalf("unset venue/club should be null, got %v / %v", trn2["venue"], trn2["club"])
	}
}
