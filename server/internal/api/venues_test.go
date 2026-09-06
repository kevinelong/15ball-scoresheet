package api

import (
	"net/http"
	"testing"
)

// TestVenuesAndRecentPlayers covers the venue create (with lat/lng supplied so no
// network geocode happens), the tournament→venue link, and recent-players-at-venue:
// a player entered in one tournament at a venue is surfaced for another tournament
// at the SAME venue by the SAME organizer; a tournament with no venue returns empty.
func TestVenuesAndRecentPlayers(t *testing.T) {
	e := newTestEnv(t)

	// Create a venue with explicit coordinates → geocode is bypassed (no network).
	code, resp := e.do(t, "POST", "/api/v1/venues", e.director,
		`{"name":"Main Room","address":"123 Cue St","lat":45.5,"lng":-122.6}`)
	if code != http.StatusCreated {
		t.Fatalf("create venue: want 201, got %d (%v)", code, resp)
	}
	ven := resp["venue"].(map[string]interface{})
	venID := ven["id"].(string)
	if ven["lat"].(float64) != 45.5 || ven["lng"].(float64) != -122.6 {
		t.Fatalf("venue coords not stored: %v / %v", ven["lat"], ven["lng"])
	}

	// It shows up in the organizer's venue list.
	_, list := e.do(t, "GET", "/api/v1/venues", e.director, "")
	if len(list["items"].([]interface{})) != 1 {
		t.Fatalf("list venues: want 1, got %v", list["items"])
	}

	// Tournament A at the venue, with one checked-in entrant (→ a player).
	tidA := e.mkOpenTournamentAtVenue(t, "Tuesday Night", venID)
	playerName := "Jane Doe"
	e.addCheckedEntrant(t, tidA, playerName)

	// Tournament B at the SAME venue.
	tidB := e.mkOpenTournamentAtVenue(t, "Thursday Night", venID)
	code, rp := e.do(t, "GET", "/api/v1/tournaments/"+tidB+"/recent-players", e.director, "")
	if code != http.StatusOK {
		t.Fatalf("recent-players B: want 200, got %d (%v)", code, rp)
	}
	items := rp["items"].([]interface{})
	if len(items) != 1 {
		t.Fatalf("recent-players B: want 1 player from A, got %d (%v)", len(items), items)
	}
	pid := items[0].(map[string]interface{})["playerId"].(string)
	if got := items[0].(map[string]interface{})["displayName"]; got != playerName {
		t.Fatalf("recent-players B: want %q, got %v", playerName, got)
	}

	// Adding that player to B (linked via playerId, as the picker does) excludes
	// them from B's recent list.
	e.addCheckedEntrantLinked(t, tidB, playerName, pid)
	_, rp2 := e.do(t, "GET", "/api/v1/tournaments/"+tidB+"/recent-players", e.director, "")
	if n := len(rp2["items"].([]interface{})); n != 0 {
		t.Fatalf("recent-players B after adding the player: want 0, got %d", n)
	}

	// A tournament with NO venue returns an empty list.
	_, cr := e.do(t, "POST", "/api/v1/tournaments", e.director, `{"name":"No Venue"}`)
	tidNo := cr["tournament"].(map[string]interface{})["id"].(string)
	_, rpNo := e.do(t, "GET", "/api/v1/tournaments/"+tidNo+"/recent-players", e.director, "")
	if n := len(rpNo["items"].([]interface{})); n != 0 {
		t.Fatalf("recent-players (no venue): want 0, got %d", n)
	}
}

// mkOpenTournamentAtVenue creates a tournament linked to venueID, adds an "Open"
// division, and opens registration so entrants can be checked in. Returns the id.
func (e *testEnv) mkOpenTournamentAtVenue(t *testing.T, name, venueID string) string {
	t.Helper()
	code, resp := e.do(t, "POST", "/api/v1/tournaments", e.director,
		`{"name":"`+name+`","venueId":"`+venueID+`"}`)
	if code != http.StatusCreated {
		t.Fatalf("create tournament %q: want 201, got %d (%v)", name, code, resp)
	}
	trn := resp["tournament"].(map[string]interface{})
	tid := trn["id"].(string)
	if trn["venueId"] != venueID {
		t.Fatalf("tournament %q venueId not stored: %v", name, trn["venueId"])
	}
	if code, _ := e.do(t, "POST", "/api/v1/tournaments/"+tid+"/divisions", e.director, `{"name":"Open"}`); code != http.StatusCreated {
		t.Fatalf("division for %q: want 201, got %d", name, code)
	}
	if code, _ := e.do(t, "PATCH", "/api/v1/tournaments/"+tid, e.director, `{"state":"registration_open"}`); code != http.StatusOK {
		t.Fatalf("open reg for %q: want 200, got %d", name, code)
	}
	return tid
}

// addCheckedEntrant does create → registered → checked_in for a named entrant
// (mirrors the frontend addEntrantChecked flow; every entrant links to a player).
func (e *testEnv) addCheckedEntrant(t *testing.T, tid, name string) {
	t.Helper()
	e.addCheckedEntrantLinked(t, tid, name, "")
}

// addCheckedEntrantLinked is addCheckedEntrant but links to an existing player
// (via playerId) when pid is non-empty — mirrors the recent-players picker.
func (e *testEnv) addCheckedEntrantLinked(t *testing.T, tid, name, pid string) {
	t.Helper()
	body := `{"displayName":"` + name + `"}`
	if pid != "" {
		body = `{"displayName":"` + name + `","playerId":"` + pid + `"}`
	}
	code, resp := e.do(t, "POST", "/api/v1/tournaments/"+tid+"/entrants", e.director, body)
	if code != http.StatusCreated {
		t.Fatalf("create entrant %q: want 201, got %d (%v)", name, code, resp)
	}
	eid := resp["entrant"].(map[string]interface{})["id"].(string)
	if code, _ := e.do(t, "PATCH", "/api/v1/tournaments/"+tid+"/entrants/"+eid, e.director, `{"state":"registered"}`); code != http.StatusOK {
		t.Fatalf("register entrant %q: want 200, got %d", name, code)
	}
	if code, _ := e.do(t, "POST", "/api/v1/tournaments/"+tid+"/entrants/"+eid+"/check-in", e.director, `{}`); code != http.StatusOK {
		t.Fatalf("check-in entrant %q: want 200, got %d", name, code)
	}
}
