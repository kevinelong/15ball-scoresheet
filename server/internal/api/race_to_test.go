package api

import (
	"net/http"
	"testing"

	"github.com/kevinelong/15ball-scoresheet/server/internal/auth"
)

// registerRaceRoutes adds the two race PATCH routes to the test router under the
// same director+ gate main.go uses (dir = CSRF + session + director-or-above).
func registerRaceRoutes(e *testEnv) {
	dir := e.router.With(e.auth.RequireCSRF, e.auth.RequireSession, e.auth.RequireRoles(auth.DirectorOrAbove...))
	dir.Patch("/api/v1/tournaments/{id}/divisions/{divisionId}", e.api.PatchDivision)
	dir.Patch("/api/v1/tournaments/{id}/matches/{matchId}", e.api.PatchMatch)
}

func firstItem(t *testing.T, e *testEnv, path string) map[string]interface{} {
	t.Helper()
	code, resp := e.do(t, "GET", path, e.director, "")
	if code != http.StatusOK {
		t.Fatalf("GET %s: want 200, got %d (%v)", path, code, resp)
	}
	items := resp["items"].([]interface{})
	if len(items) == 0 {
		t.Fatalf("GET %s: no items", path)
	}
	return items[0].(map[string]interface{})
}

func firstDivisionID(t *testing.T, e *testEnv, tid string) string {
	t.Helper()
	return firstItem(t, e, "/api/v1/tournaments/"+tid+"/divisions")["id"].(string)
}

func firstMatchID(t *testing.T, e *testEnv, tid string) string {
	t.Helper()
	return firstItem(t, e, "/api/v1/tournaments/"+tid+"/matches")["id"].(string)
}

func matchRace(t *testing.T, e *testEnv, tid, mid string) (int, string) {
	t.Helper()
	_, resp := e.do(t, "GET", "/api/v1/tournaments/"+tid+"/matches", e.director, "")
	for _, it := range resp["items"].([]interface{}) {
		m := it.(map[string]interface{})
		if m["id"] == mid {
			return int(m["raceTo"].(float64)), m["raceFrom"].(string)
		}
	}
	t.Fatalf("match %s not in list", mid)
	return 0, ""
}

func TestGameDefaultRaceCatalog(t *testing.T) {
	// The server catalog mirrors app.js GAMES[*].defaultRaceTo.
	want := map[string]int{
		"15ball_rotation": 25, "straight_14_1": 100, "8ball": 7, "9ball": 7,
		"10ball": 7, "one_pocket": 3, "bank_pool": 5,
	}
	for g, n := range want {
		if got := gameDefaultRaceTo(g); got != n {
			t.Fatalf("gameDefaultRaceTo(%q) = %d, want %d", g, got, n)
		}
	}
	// An unknown or empty game falls back to the rotation default (25).
	for _, g := range []string{"", "bogus", "15-ball"} {
		if got := gameDefaultRaceTo(g); got != 25 {
			t.Fatalf("gameDefaultRaceTo(%q) = %d, want 25 (rotation fallback)", g, got)
		}
	}
}

func TestResolveRaceToLayers(t *testing.T) {
	d, m := 9, 11
	cases := []struct {
		name    string
		match   *int
		div     *int
		game    string
		wantN   int
		wantSrc string
	}{
		{"default", nil, nil, "8ball", 7, "default"},
		{"unknown game default", nil, nil, "nope", 25, "default"},
		{"division beats default", nil, &d, "8ball", 9, "division"},
		{"match beats division", &m, &d, "8ball", 11, "match"},
		{"match beats default", &m, nil, "one_pocket", 11, "match"},
	}
	for _, c := range cases {
		n, src := resolveRaceTo(c.match, c.div, c.game)
		if n != c.wantN || src != c.wantSrc {
			t.Fatalf("%s: resolveRaceTo = (%d,%q), want (%d,%q)", c.name, n, src, c.wantN, c.wantSrc)
		}
	}
}

func TestRaceToDefaultResolution(t *testing.T) {
	e := newTestEnv(t)
	registerRaceRoutes(e)
	tid := e.mkStartedTournament(t)
	mid := firstMatchID(t, e, tid)

	if n, src := matchRace(t, e, tid, mid); n != 25 || src != "default" {
		t.Fatalf("15ball default: raceTo=%d raceFrom=%q, want 25/default", n, src)
	}

	// The division layer is skipped entirely when the match has no division.
	if _, err := e.api.DB.Exec(`UPDATE matches SET division_id=NULL WHERE id=?`, mid); err != nil {
		t.Fatalf("clear division_id: %v", err)
	}
	if n, src := matchRace(t, e, tid, mid); n != 25 || src != "default" {
		t.Fatalf("no division: raceTo=%d raceFrom=%q, want 25/default", n, src)
	}

	// A non-rotation game defaults to its own target.
	if _, err := e.api.DB.Exec(`UPDATE tournaments SET game='one_pocket' WHERE id=?`, tid); err != nil {
		t.Fatalf("set game: %v", err)
	}
	if n, src := matchRace(t, e, tid, mid); n != 3 || src != "default" {
		t.Fatalf("one_pocket default: raceTo=%d raceFrom=%q, want 3/default", n, src)
	}

	// An unknown game falls back to the rotation default (25).
	if _, err := e.api.DB.Exec(`UPDATE tournaments SET game='bogus' WHERE id=?`, tid); err != nil {
		t.Fatalf("set bogus game: %v", err)
	}
	if n, src := matchRace(t, e, tid, mid); n != 25 || src != "default" {
		t.Fatalf("unknown game default: raceTo=%d raceFrom=%q, want 25/default", n, src)
	}
}

func TestRaceToDivisionBeatsDefault(t *testing.T) {
	e := newTestEnv(t)
	registerRaceRoutes(e)
	// A double-elimination field carries division_id on its matches, so the
	// division layer is in play.
	tid := e.startDoubleElim(t, 4)
	did := firstDivisionID(t, e, tid)
	mid := firstMatchID(t, e, tid)

	if code, r := e.do(t, "PATCH", "/api/v1/tournaments/"+tid+"/divisions/"+did, e.director, `{"raceTo":9}`); code != http.StatusOK {
		t.Fatalf("patch division raceTo: want 200, got %d (%v)", code, r)
	}
	// The division payload exposes the division layer's raceTo.
	div := firstItem(t, e, "/api/v1/tournaments/"+tid+"/divisions")
	if int(div["raceTo"].(float64)) != 9 {
		t.Fatalf("division raceTo = %v, want 9", div["raceTo"])
	}
	// The match payload picks it up and names the division as the source.
	if n, src := matchRace(t, e, tid, mid); n != 9 || src != "division" {
		t.Fatalf("division layer: raceTo=%d raceFrom=%q, want 9/division", n, src)
	}

	// Setting a raceTo on the division at create time is also accepted.
	code, r := e.do(t, "POST", "/api/v1/tournaments/"+tid+"/divisions", e.director, `{"name":"Second","raceTo":13}`)
	if code != http.StatusCreated {
		t.Fatalf("create division with raceTo: want 201, got %d (%v)", code, r)
	}
	if got := int(r["division"].(map[string]interface{})["raceTo"].(float64)); got != 13 {
		t.Fatalf("created division raceTo = %d, want 13", got)
	}
}

func TestRaceToMatchOverrideAndClear(t *testing.T) {
	e := newTestEnv(t)
	registerRaceRoutes(e)
	tid := e.startDoubleElim(t, 4)
	did := firstDivisionID(t, e, tid)
	mid := firstMatchID(t, e, tid)
	e.do(t, "PATCH", "/api/v1/tournaments/"+tid+"/divisions/"+did, e.director, `{"raceTo":9}`)

	// A per-match override beats the division.
	code, r := e.do(t, "PATCH", "/api/v1/tournaments/"+tid+"/matches/"+mid, e.director, `{"raceTo":11}`)
	if code != http.StatusOK {
		t.Fatalf("patch match raceTo: want 200, got %d (%v)", code, r)
	}
	if rm := r["match"].(map[string]interface{}); int(rm["raceTo"].(float64)) != 11 || rm["raceFrom"] != "match" {
		t.Fatalf("patch response: %v/%v, want 11/match", rm["raceTo"], rm["raceFrom"])
	}
	if n, src := matchRace(t, e, tid, mid); n != 11 || src != "match" {
		t.Fatalf("match layer: raceTo=%d raceFrom=%q, want 11/match", n, src)
	}

	// Absent ≠ null: a body that does not mention raceTo leaves the override alone.
	if code, _ := e.do(t, "PATCH", "/api/v1/tournaments/"+tid+"/matches/"+mid, e.director, `{}`); code != http.StatusOK {
		t.Fatalf("empty patch: want 200, got %d", code)
	}
	if n, src := matchRace(t, e, tid, mid); n != 11 || src != "match" {
		t.Fatalf("absent raceTo changed the override: raceTo=%d raceFrom=%q, want 11/match", n, src)
	}

	// An explicit null clears the override → the match inherits its division again.
	code, r = e.do(t, "PATCH", "/api/v1/tournaments/"+tid+"/matches/"+mid, e.director, `{"raceTo":null}`)
	if code != http.StatusOK {
		t.Fatalf("clear match raceTo: want 200, got %d (%v)", code, r)
	}
	if n, src := matchRace(t, e, tid, mid); n != 9 || src != "division" {
		t.Fatalf("cleared override: raceTo=%d raceFrom=%q, want 9/division", n, src)
	}

	// Clearing the division override falls back to the game default.
	code, _ = e.do(t, "PATCH", "/api/v1/tournaments/"+tid+"/divisions/"+did, e.director, `{"raceTo":null}`)
	if code != http.StatusOK {
		t.Fatalf("clear division raceTo: want 200, got %d", code)
	}
	if n, src := matchRace(t, e, tid, mid); n != 25 || src != "default" {
		t.Fatalf("cleared division: raceTo=%d raceFrom=%q, want 25/default", n, src)
	}
}

func TestRaceToBounds(t *testing.T) {
	e := newTestEnv(t)
	registerRaceRoutes(e)
	tid := e.mkStartedTournament(t)
	did := firstDivisionID(t, e, tid)
	mid := firstMatchID(t, e, tid)

	for _, bad := range []string{"0", "1000", "-5"} {
		if code, r := e.do(t, "PATCH", "/api/v1/tournaments/"+tid+"/divisions/"+did, e.director, `{"raceTo":`+bad+`}`); code != http.StatusBadRequest || errCode(r) != "invalid_race_to" {
			t.Fatalf("division raceTo %s: want 400 invalid_race_to, got %d (%v)", bad, code, r)
		}
		if code, r := e.do(t, "PATCH", "/api/v1/tournaments/"+tid+"/matches/"+mid, e.director, `{"raceTo":`+bad+`}`); code != http.StatusBadRequest || errCode(r) != "invalid_race_to" {
			t.Fatalf("match raceTo %s: want 400 invalid_race_to, got %d (%v)", bad, code, r)
		}
	}
	if code, r := e.do(t, "POST", "/api/v1/tournaments/"+tid+"/divisions", e.director, `{"name":"Zero","raceTo":0}`); code != http.StatusBadRequest || errCode(r) != "invalid_race_to" {
		t.Fatalf("create division raceTo 0: want 400 invalid_race_to, got %d (%v)", code, r)
	}
	if code, r := e.do(t, "POST", "/api/v1/tournaments/"+tid+"/divisions", e.director, `{"name":"Big","raceTo":1000}`); code != http.StatusBadRequest || errCode(r) != "invalid_race_to" {
		t.Fatalf("create division raceTo 1000: want 400 invalid_race_to, got %d (%v)", code, r)
	}
	// The bounds are inclusive: 1 and 999 are accepted.
	for _, ok := range []string{"1", "999"} {
		if code, r := e.do(t, "PATCH", "/api/v1/tournaments/"+tid+"/matches/"+mid, e.director, `{"raceTo":`+ok+`}`); code != http.StatusOK {
			t.Fatalf("match raceTo %s: want 200, got %d (%v)", ok, code, r)
		}
	}
}

func TestRaceToDirectorOnly(t *testing.T) {
	e := newTestEnv(t)
	registerRaceRoutes(e)
	tid := e.mkStartedTournament(t)
	did := firstDivisionID(t, e, tid)
	mid := firstMatchID(t, e, tid)

	for _, who := range []struct {
		name   string
		cookie string
	}{{"viewer", e.viewer}, {"scorekeeper", e.scorekeeper}} {
		if code, _ := e.do(t, "PATCH", "/api/v1/tournaments/"+tid+"/divisions/"+did, who.cookie, `{"raceTo":9}`); code != http.StatusForbidden {
			t.Fatalf("%s patch division: want 403, got %d", who.name, code)
		}
		if code, _ := e.do(t, "PATCH", "/api/v1/tournaments/"+tid+"/matches/"+mid, who.cookie, `{"raceTo":9}`); code != http.StatusForbidden {
			t.Fatalf("%s patch match: want 403, got %d", who.name, code)
		}
	}
	// A director may set both.
	if code, _ := e.do(t, "PATCH", "/api/v1/tournaments/"+tid+"/divisions/"+did, e.director, `{"raceTo":9}`); code != http.StatusOK {
		t.Fatalf("director patch division: want 200, got %d", code)
	}
	if code, _ := e.do(t, "PATCH", "/api/v1/tournaments/"+tid+"/matches/"+mid, e.director, `{"raceTo":11}`); code != http.StatusOK {
		t.Fatalf("director patch match: want 200, got %d", code)
	}
	// Guards the unknown-target paths too.
	if code, _ := e.do(t, "PATCH", "/api/v1/tournaments/"+tid+"/divisions/div_nope", e.director, `{"raceTo":9}`); code != http.StatusNotFound {
		t.Fatalf("unknown division: want 404, got %d", code)
	}
	if code, _ := e.do(t, "PATCH", "/api/v1/tournaments/"+tid+"/matches/mch_nope", e.director, `{"raceTo":9}`); code != http.StatusNotFound {
		t.Fatalf("unknown match: want 404, got %d", code)
	}
}

func TestMatchHistoryCarriesPayloadAndSubmitter(t *testing.T) {
	e := newTestEnv(t)
	tid, mid, a, b := e.mkLiveMatch(t)
	body := `{"winnerEntrantId":"` + a + `","loserEntrantId":"` + b + `","score":{"A":5,"B":3}}`
	if code, r := e.doKey(t, "POST", "/api/v1/tournaments/"+tid+"/matches/"+mid+"/result", e.scorekeeper, body, "race-hist-1"); code != http.StatusOK {
		t.Fatalf("submit result: want 200, got %d (%v)", code, r)
	}
	code, h := e.do(t, "GET", "/api/v1/tournaments/"+tid+"/matches/"+mid+"/history", e.director, "")
	if code != http.StatusOK {
		t.Fatalf("history: want 200, got %d (%v)", code, h)
	}
	versions := h["versions"].([]interface{})
	if len(versions) != 1 {
		t.Fatalf("versions = %d, want 1", len(versions))
	}
	v := versions[0].(map[string]interface{})
	// payload is the raw JSON this version wrote (not a re-quoted string).
	sc, ok := v["payload"].(map[string]interface{})
	if !ok {
		t.Fatalf("payload type = %T (%v), want a JSON object", v["payload"], v["payload"])
	}
	if int(sc["A"].(float64)) != 5 || int(sc["B"].(float64)) != 3 {
		t.Fatalf("payload = %v, want {A:5,B:3}", sc)
	}
	// submittedByEmail names the scorekeeper who saved it.
	if v["submittedByEmail"] != "scorekeeper@x.com" {
		t.Fatalf("submittedByEmail = %v, want scorekeeper@x.com", v["submittedByEmail"])
	}
}

// errCode pulls the contract error code out of an error envelope.
func errCode(r map[string]interface{}) string {
	e, ok := r["error"].(map[string]interface{})
	if !ok {
		return ""
	}
	s, _ := e["code"].(string)
	return s
}
