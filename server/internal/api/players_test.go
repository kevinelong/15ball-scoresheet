package api

import (
	"net/http"
	"testing"
)

// TestPlayerSuggestionsFuzzyName: an entrant "Jane Doe" creates a player; a
// suggestion query for a near-miss name surfaces that player above threshold.
func TestPlayerSuggestionsFuzzyName(t *testing.T) {
	e := newTestEnv(t)
	tid := e.mkOpenTournament(t)

	code, resp := e.do(t, "POST", "/api/v1/tournaments/"+tid+"/entrants", e.director, `{"displayName":"Jane Doe"}`)
	if code != http.StatusCreated {
		t.Fatalf("create Jane Doe: want 201, got %d", code)
	}
	ent := resp["entrant"].(map[string]interface{})
	if ent["playerId"] == nil || ent["playerId"].(string) == "" {
		t.Fatalf("entrant should have a linked playerId, got %v", ent["playerId"])
	}

	code, sug := e.do(t, "GET", "/api/v1/tournaments/"+tid+"/player-suggestions?name=Jane%20Doh", e.director, "")
	if code != http.StatusOK {
		t.Fatalf("suggestions: want 200, got %d", code)
	}
	items := sug["items"].([]interface{})
	if len(items) == 0 {
		t.Fatalf("expected a fuzzy-name suggestion for 'Jane Doh'")
	}
	top := items[0].(map[string]interface{})
	if top["displayName"] != "Jane Doe" {
		t.Fatalf("expected Jane Doe suggested, got %v", top["displayName"])
	}
	if top["score"].(float64) < 0.72 {
		t.Fatalf("score should be above threshold, got %v", top["score"])
	}
	if top["pastEntries"].(float64) != 1 {
		t.Fatalf("pastEntries should be 1, got %v", top["pastEntries"])
	}
}

// TestPlayerSuggestionsEnriched: suggestion items carry decision context —
// matchReason ("name" for a fuzzy hit, "phone" for an exact phone hit) and
// lastEvent (the most recent tournament the player entered).
func TestPlayerSuggestionsEnriched(t *testing.T) {
	e := newTestEnv(t)
	tid := e.mkOpenTournament(t)

	// fetch the tournament name for the lastEvent assertion
	var tname string
	_ = e.api.DB.QueryRow(`SELECT name FROM tournaments WHERE id=?`, tid).Scan(&tname)

	if code, _ := e.do(t, "POST", "/api/v1/tournaments/"+tid+"/entrants", e.director,
		`{"displayName":"Jane Doe","phone":"+15035550123"}`); code != http.StatusCreated {
		t.Fatalf("create Jane Doe: want 201, got %d", code)
	}

	// fuzzy name → matchReason "name", lastEvent = the tournament name
	code, sug := e.do(t, "GET", "/api/v1/tournaments/"+tid+"/player-suggestions?name=Jane%20Doh", e.director, "")
	if code != http.StatusOK {
		t.Fatalf("suggestions: want 200, got %d", code)
	}
	items := sug["items"].([]interface{})
	if len(items) == 0 {
		t.Fatalf("expected a suggestion for 'Jane Doh'")
	}
	top := items[0].(map[string]interface{})
	if top["matchReason"] != "name" {
		t.Errorf("matchReason should be 'name', got %v", top["matchReason"])
	}
	if top["lastEvent"] != tname {
		t.Errorf("lastEvent should be %q, got %v", tname, top["lastEvent"])
	}
	if top["lastEventAt"].(float64) <= 0 {
		t.Errorf("lastEventAt should be a positive unix time, got %v", top["lastEventAt"])
	}

	// exact phone → matchReason "phone"
	code, sug2 := e.do(t, "GET", "/api/v1/tournaments/"+tid+"/player-suggestions?name=Nope&phone=503-555-0123", e.director, "")
	if code != http.StatusOK {
		t.Fatalf("phone suggestions: want 200, got %d", code)
	}
	pitems := sug2["items"].([]interface{})
	if len(pitems) == 0 {
		t.Fatalf("expected a phone-match suggestion")
	}
	ptop := pitems[0].(map[string]interface{})
	if ptop["matchReason"] != "phone" {
		t.Errorf("matchReason should be 'phone', got %v", ptop["matchReason"])
	}
}

// TestPlayerSuggestionsBatch: POST batch with two queries (one matching an
// existing player, one not) keys results by the caller-supplied key.
func TestPlayerSuggestionsBatch(t *testing.T) {
	e := newTestEnv(t)
	tid := e.mkOpenTournament(t)

	if code, _ := e.do(t, "POST", "/api/v1/tournaments/"+tid+"/entrants", e.director,
		`{"displayName":"Jane Doe"}`); code != http.StatusCreated {
		t.Fatalf("create Jane Doe: want 201, got %d", code)
	}

	body := `{"queries":[
		{"key":"row-1","name":"Jane Doh"},
		{"key":"row-2","name":"Zzxqwv Nobody"}
	]}`
	code, resp := e.do(t, "POST", "/api/v1/tournaments/"+tid+"/player-suggestions/batch", e.director, body)
	if code != http.StatusOK {
		t.Fatalf("batch: want 200, got %d (%v)", code, resp)
	}
	results := resp["results"].(map[string]interface{})
	r1, ok := results["row-1"].([]interface{})
	if !ok || len(r1) == 0 {
		t.Fatalf("row-1 should match Jane Doe, got %v", results["row-1"])
	}
	if r1[0].(map[string]interface{})["displayName"] != "Jane Doe" {
		t.Errorf("row-1 top should be Jane Doe, got %v", r1[0])
	}
	r2, ok := results["row-2"].([]interface{})
	if !ok || len(r2) != 0 {
		t.Errorf("row-2 should have no matches, got %v", results["row-2"])
	}
}

// TestPlayerSuggestionsPhoneMatch: an exact phone match surfaces the player even
// when the queried name differs.
func TestPlayerSuggestionsPhoneMatch(t *testing.T) {
	e := newTestEnv(t)
	tid := e.mkOpenTournament(t)

	if code, _ := e.do(t, "POST", "/api/v1/tournaments/"+tid+"/entrants", e.director,
		`{"displayName":"Bob","phone":"+15033699277"}`); code != http.StatusCreated {
		t.Fatalf("create Bob: want 201, got %d", code)
	}

	code, sug := e.do(t, "GET", "/api/v1/tournaments/"+tid+"/player-suggestions?name=Bobby&phone=503-369-9277", e.director, "")
	if code != http.StatusOK {
		t.Fatalf("suggestions: want 200, got %d", code)
	}
	items := sug["items"].([]interface{})
	if len(items) == 0 {
		t.Fatalf("expected a phone-match suggestion for Bob")
	}
	top := items[0].(map[string]interface{})
	if top["displayName"] != "Bob" || top["score"].(float64) < 1.0 {
		t.Fatalf("expected strong Bob match, got %v", top)
	}
}

// TestPlayerMerge: two tournaments (same director/organizer), an entrant in each
// with slightly different names → two players; merge repoints entrants, deletes
// the source, and combines contact fields.
func TestPlayerMerge(t *testing.T) {
	e := newTestEnv(t)
	t1 := e.mkOpenTournament(t)
	t2 := e.mkOpenTournament(t)

	_, r1 := e.do(t, "POST", "/api/v1/tournaments/"+t1+"/entrants", e.director,
		`{"displayName":"Robert Smith","phone":"+15551234567"}`)
	p1 := r1["entrant"].(map[string]interface{})["playerId"].(string)

	_, r2 := e.do(t, "POST", "/api/v1/tournaments/"+t2+"/entrants", e.director,
		`{"displayName":"Rob Smith","email":"rob@x.com"}`)
	e2 := r2["entrant"].(map[string]interface{})
	p2 := e2["playerId"].(string)
	e2id := e2["id"].(string)

	if p1 == p2 {
		t.Fatalf("expected two distinct players, got %s twice", p1)
	}

	// merge p2 into p1
	code, mr := e.do(t, "POST", "/api/v1/players/"+p2+"/merge", e.director, `{"intoId":"`+p1+`"}`)
	if code != http.StatusOK {
		t.Fatalf("merge: want 200, got %d (%v)", code, mr)
	}
	merged := mr["player"].(map[string]interface{})
	if merged["id"] != p1 {
		t.Fatalf("merge should return target player %s, got %v", p1, merged["id"])
	}
	// contact fields combined: p1 had phone, p2 had email
	if merged["phone"] == nil || merged["email"] == nil {
		t.Fatalf("target should have both phone and email after merge, got %v", merged)
	}

	// source player gone
	var n int
	_ = e.api.DB.QueryRow(`SELECT COUNT(*) FROM players WHERE id=?`, p2).Scan(&n)
	if n != 0 {
		t.Fatalf("source player should be deleted, found %d", n)
	}
	// e2 entrant repointed to p1
	var pid string
	_ = e.api.DB.QueryRow(`SELECT player_id FROM entrants WHERE id=?`, e2id).Scan(&pid)
	if pid != p1 {
		t.Fatalf("entrant should repoint to %s, got %s", p1, pid)
	}

	// merge into self → 400
	if code, _ := e.do(t, "POST", "/api/v1/players/"+p1+"/merge", e.director, `{"intoId":"`+p1+`"}`); code != http.StatusBadRequest {
		t.Fatalf("self-merge: want 400, got %d", code)
	}
	// merge nonexistent source → 404
	if code, _ := e.do(t, "POST", "/api/v1/players/plr_missing/merge", e.director, `{"intoId":"`+p1+`"}`); code != http.StatusNotFound {
		t.Fatalf("missing source merge: want 404, got %d", code)
	}
}

// dupPairFor returns the {a,b,score,reason} pair from a /duplicates response
// whose two player ids match p1/p2 (order-insensitive), or nil.
func dupPairFor(resp map[string]interface{}, p1, p2 string) map[string]interface{} {
	pairs, _ := resp["pairs"].([]interface{})
	for _, raw := range pairs {
		pr, _ := raw.(map[string]interface{})
		if pr == nil {
			continue
		}
		a, _ := pr["a"].(map[string]interface{})
		b, _ := pr["b"].(map[string]interface{})
		if a == nil || b == nil {
			continue
		}
		ai, _ := a["playerId"].(string)
		bi, _ := b["playerId"].(string)
		if (ai == p1 && bi == p2) || (ai == p2 && bi == p1) {
			return pr
		}
	}
	return nil
}

// TestDuplicatePlayersNameAndDismiss: two players in the SAME organizer with
// near-identical names (across two tournaments) surface as a "name" pair; after
// dismissing it, the pair no longer appears.
func TestDuplicatePlayersNameAndDismiss(t *testing.T) {
	e := newTestEnv(t)
	t1 := e.mkOpenTournament(t)
	t2 := e.mkOpenTournament(t)

	_, r1 := e.do(t, "POST", "/api/v1/tournaments/"+t1+"/entrants", e.director, `{"displayName":"Jon Smith"}`)
	p1 := r1["entrant"].(map[string]interface{})["playerId"].(string)
	_, r2 := e.do(t, "POST", "/api/v1/tournaments/"+t2+"/entrants", e.director, `{"displayName":"Jhon Smith"}`)
	p2 := r2["entrant"].(map[string]interface{})["playerId"].(string)
	if p1 == p2 {
		t.Fatalf("expected two distinct players, got %s twice", p1)
	}

	code, resp := e.do(t, "GET", "/api/v1/players/duplicates", e.director, "")
	if code != http.StatusOK {
		t.Fatalf("duplicates: want 200, got %d (%v)", code, resp)
	}
	pr := dupPairFor(resp, p1, p2)
	if pr == nil {
		t.Fatalf("expected the Jon/Jhon Smith pair, got %v", resp["pairs"])
	}
	if pr["reason"] != "name" {
		t.Fatalf("reason should be 'name', got %v", pr["reason"])
	}
	// each side carries decision context
	a := pr["a"].(map[string]interface{})
	if a["pastEntries"].(float64) != 1 || a["lastEvent"] == "" {
		t.Fatalf("pair sides should carry pastEntries/lastEvent, got %v", a)
	}

	// dismiss the pair → gone
	code, dr := e.do(t, "POST", "/api/v1/players/dismiss-duplicate", e.director,
		`{"aId":"`+p1+`","bId":"`+p2+`"}`)
	if code != http.StatusOK || dr["ok"] != true {
		t.Fatalf("dismiss: want 200 ok, got %d (%v)", code, dr)
	}
	_, resp2 := e.do(t, "GET", "/api/v1/players/duplicates", e.director, "")
	if dupPairFor(resp2, p1, p2) != nil {
		t.Fatalf("dismissed pair should not reappear, got %v", resp2["pairs"])
	}

	// dismiss with equal ids → 400; missing player → 404
	if code, _ := e.do(t, "POST", "/api/v1/players/dismiss-duplicate", e.director,
		`{"aId":"`+p1+`","bId":"`+p1+`"}`); code != http.StatusBadRequest {
		t.Fatalf("equal-ids dismiss: want 400, got %d", code)
	}
	if code, _ := e.do(t, "POST", "/api/v1/players/dismiss-duplicate", e.director,
		`{"aId":"`+p1+`","bId":"plr_missing"}`); code != http.StatusNotFound {
		t.Fatalf("missing-player dismiss: want 404, got %d", code)
	}
}

// TestDuplicatePlayersPhoneMatch: two players sharing an E.164 phone (distinct
// names) surface as a "phone" pair with score 1.0.
func TestDuplicatePlayersPhoneMatch(t *testing.T) {
	e := newTestEnv(t)
	t1 := e.mkOpenTournament(t)
	t2 := e.mkOpenTournament(t)

	_, r1 := e.do(t, "POST", "/api/v1/tournaments/"+t1+"/entrants", e.director,
		`{"displayName":"Alice Anderson","phone":"+15035550199"}`)
	p1 := r1["entrant"].(map[string]interface{})["playerId"].(string)
	_, r2 := e.do(t, "POST", "/api/v1/tournaments/"+t2+"/entrants", e.director,
		`{"displayName":"Ally A","phone":"503-555-0199"}`)
	p2 := r2["entrant"].(map[string]interface{})["playerId"].(string)

	code, resp := e.do(t, "GET", "/api/v1/players/duplicates", e.director, "")
	if code != http.StatusOK {
		t.Fatalf("duplicates: want 200, got %d", code)
	}
	pr := dupPairFor(resp, p1, p2)
	if pr == nil {
		t.Fatalf("expected the phone-equal pair, got %v", resp["pairs"])
	}
	if pr["reason"] != "phone" || pr["score"].(float64) < 1.0 {
		t.Fatalf("expected reason phone score 1.0, got %v", pr)
	}
}

// TestCreateEntrantWithExplicitPlayerID: passing a known playerId reuses that
// player and backfills its empty contact fields from the entrant.
func TestCreateEntrantWithExplicitPlayerID(t *testing.T) {
	e := newTestEnv(t)
	t1 := e.mkOpenTournament(t)
	t2 := e.mkOpenTournament(t)

	_, r1 := e.do(t, "POST", "/api/v1/tournaments/"+t1+"/entrants", e.director, `{"displayName":"Carol"}`)
	pid := r1["entrant"].(map[string]interface{})["playerId"].(string)

	code, r2 := e.do(t, "POST", "/api/v1/tournaments/"+t2+"/entrants", e.director,
		`{"displayName":"Carol","phone":"+15550001111","playerId":"`+pid+`"}`)
	if code != http.StatusCreated {
		t.Fatalf("create with playerId: want 201, got %d", code)
	}
	if r2["entrant"].(map[string]interface{})["playerId"].(string) != pid {
		t.Fatalf("entrant should reuse player %s", pid)
	}
	// player backfilled with the phone
	var phone *string
	_ = e.api.DB.QueryRow(`SELECT phone FROM players WHERE id=?`, pid).Scan(&phone)
	if phone == nil || *phone != "+15550001111" {
		t.Fatalf("player phone should be backfilled, got %v", phone)
	}
	// only one player exists across both tournaments
	var n int
	_ = e.api.DB.QueryRow(`SELECT COUNT(*) FROM players WHERE id=?`, pid).Scan(&n)
	if n != 1 {
		t.Fatalf("expected exactly the reused player, got %d", n)
	}
}
