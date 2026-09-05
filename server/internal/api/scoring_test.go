package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// doKey is like do but also sets an Idempotency-Key header.
func (e *testEnv) doKey(t *testing.T, method, path, cookie, body, key string) (int, map[string]interface{}) {
	t.Helper()
	req := httptest.NewRequest(method, path, bytes.NewReader([]byte(body)))
	req.AddCookie(&http.Cookie{Name: "fifteenball_session", Value: cookie})
	req.Header.Set("X-CO", "1")
	req.Header.Set("Content-Type", "application/json")
	if key != "" {
		req.Header.Set("Idempotency-Key", key)
	}
	rec := httptest.NewRecorder()
	e.router.ServeHTTP(rec, req)
	var out map[string]interface{}
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

func TestScoringLoop(t *testing.T) {
	e := newTestEnv(t)
	tid := e.mkStartedTournament(t)
	// find the round-1 match + its entrants, assign + start it
	_, list := e.do(t, "GET", "/api/v1/tournaments/"+tid+"/matches", e.director, "")
	m := list["items"].([]interface{})[0].(map[string]interface{})
	mid := m["id"].(string)
	a := m["entrantAId"].(string)
	b := m["entrantBId"].(string)
	e.do(t, "POST", "/api/v1/tournaments/"+tid+"/matches/"+mid+"/assign", e.director, `{"scorekeeperUserId":"u_scorekeeper@x.com"}`)
	e.do(t, "POST", "/api/v1/tournaments/"+tid+"/matches/"+mid+"/start", e.scorekeeper, `{}`)

	body := `{"winnerEntrantId":"` + a + `","loserEntrantId":"` + b + `"}`
	// missing idempotency key → 400
	if code, _ := e.do(t, "POST", "/api/v1/tournaments/"+tid+"/matches/"+mid+"/result", e.scorekeeper, body); code != http.StatusBadRequest {
		t.Fatalf("result w/o key: want 400, got %d", code)
	}
	// viewer cannot submit → 403
	if code, _ := e.doKey(t, "POST", "/api/v1/tournaments/"+tid+"/matches/"+mid+"/result", e.viewer, body, "k1"); code != http.StatusForbidden {
		t.Fatalf("viewer result: want 403, got %d", code)
	}
	// submit → 200, resultVersion 1, match completed
	code, resp := e.doKey(t, "POST", "/api/v1/tournaments/"+tid+"/matches/"+mid+"/result", e.scorekeeper, body, "k2")
	if code != http.StatusOK || resp["resultVersion"].(float64) != 1 {
		t.Fatalf("submit result: want 200 rv1, got %d %v", code, resp["resultVersion"])
	}
	// idempotent repeat (same key) → cached 200
	if code, _ := e.doKey(t, "POST", "/api/v1/tournaments/"+tid+"/matches/"+mid+"/result", e.scorekeeper, body, "k2"); code != http.StatusOK {
		t.Fatalf("idempotent repeat: want 200, got %d", code)
	}
	// all matches terminal → tournament can complete
	if code, _ := e.do(t, "PATCH", "/api/v1/tournaments/"+tid, e.director, `{"state":"completed"}`); code != http.StatusOK {
		t.Fatalf("complete tournament: want 200, got %d", code)
	}
	// reopen match without reason → 400; with reason+key → 200 reopened
	if code, _ := e.doKey(t, "POST", "/api/v1/tournaments/"+tid+"/matches/"+mid+"/reopen", e.director, `{}`, "r1"); code != http.StatusBadRequest {
		t.Fatalf("reopen w/o reason: want 400, got %d", code)
	}
	code, resp = e.doKey(t, "POST", "/api/v1/tournaments/"+tid+"/matches/"+mid+"/reopen", e.director, `{"reason":"scoring error"}`, "r2")
	if code != http.StatusOK || resp["match"].(map[string]interface{})["state"] != "reopened" {
		t.Fatalf("reopen: want 200 reopened, got %d %v", code, resp)
	}
	// resubmit after reopen → resultVersion 2 (immutable, versioned)
	code, resp = e.doKey(t, "POST", "/api/v1/tournaments/"+tid+"/matches/"+mid+"/result", e.scorekeeper, body, "k3")
	if code != http.StatusOK || resp["resultVersion"].(float64) != 2 {
		t.Fatalf("resubmit after reopen: want rv2, got %d %v", code, resp["resultVersion"])
	}
}
