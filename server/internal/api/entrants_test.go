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

// TestEntrantAutoLinkByName: a name-only add in a later event links the unique
// same-name player, copies the remembered phone/email onto the entrant, and
// backfills a missing Fargo on the player from the new entry.
func TestEntrantAutoLinkByName(t *testing.T) {
	e := newTestEnv(t)
	tid1 := e.mkOpenTournament(t)
	code, resp := e.do(t, "POST", "/api/v1/tournaments/"+tid1+"/entrants", e.director,
		`{"displayName":"Kevin Long","phone":"+15038886879","email":"kevin@example.com"}`)
	if code != http.StatusCreated {
		t.Fatalf("first entrant: want 201, got %d (%v)", code, resp)
	}
	eid1 := resp["entrant"].(map[string]interface{})["id"].(string)
	var pid string
	e.api.DB.QueryRow(`SELECT COALESCE(player_id,'') FROM entrants WHERE id=?`, eid1).Scan(&pid)
	if pid == "" {
		t.Fatal("first entrant should link a player")
	}

	tid2 := e.mkOpenTournament(t)
	code, resp = e.do(t, "POST", "/api/v1/tournaments/"+tid2+"/entrants", e.director,
		`{"displayName":"Kevin  Long","fargo":555}`)
	if code != http.StatusCreated {
		t.Fatalf("second entrant: want 201, got %d (%v)", code, resp)
	}
	eid2 := resp["entrant"].(map[string]interface{})["id"].(string)
	var phone, email, pid2 string
	var fargo int64
	e.api.DB.QueryRow(`SELECT COALESCE(phone,''), COALESCE(email,''), COALESCE(fargo,0), COALESCE(player_id,'')
	                   FROM entrants WHERE id=?`, eid2).Scan(&phone, &email, &fargo, &pid2)
	if pid2 != pid {
		t.Fatalf("same name should link the same player: got %q want %q", pid2, pid)
	}
	if phone != "+15038886879" {
		t.Fatalf("remembered phone should fill the entrant: got %q", phone)
	}
	if email != "kevin@example.com" {
		t.Fatalf("remembered email should fill the entrant: got %q", email)
	}
	if fargo != 555 {
		t.Fatalf("entrant Fargo should be 555, got %d", fargo)
	}
	var pfargo int64
	e.api.DB.QueryRow(`SELECT COALESCE(fargo,0) FROM players WHERE id=?`, pid).Scan(&pfargo)
	if pfargo != 555 {
		t.Fatalf("player Fargo should be augmented from the new entrant, got %d", pfargo)
	}
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
