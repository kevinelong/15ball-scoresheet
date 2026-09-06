package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
)

// TestOpenMatchEditing verifies that with OpenMatchEditing on, the score actions
// work with no session and no scorekeeper (anyone with the link can record a
// result), and that the scorekeeper check is otherwise enforced.
func TestOpenMatchEditing(t *testing.T) {
	e := newTestEnv(t)
	// Setup (bracket) is done by the director as usual; only scoring is opened.
	tid, mid, a, b := e.mkLiveMatchUnstarted(t)
	e.api.OpenMatchEditing = true

	// A bare router with NO auth middleware — mirrors main.go's open chains.
	r := chi.NewRouter()
	r.Post("/api/v1/tournaments/{id}/matches/{matchId}/assign", e.api.AssignMatch)
	r.Post("/api/v1/tournaments/{id}/matches/{matchId}/start", e.api.StartMatch)
	r.Post("/api/v1/tournaments/{id}/matches/{matchId}/result", e.api.SubmitResult)

	do := func(path, body, key string) (int, map[string]interface{}) {
		req := httptest.NewRequest("POST", path, bytes.NewReader([]byte(body)))
		req.Header.Set("X-CO", "1")
		req.Header.Set("Content-Type", "application/json")
		if key != "" {
			req.Header.Set("Idempotency-Key", key)
		}
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		var out map[string]interface{}
		_ = json.Unmarshal(rec.Body.Bytes(), &out)
		return rec.Code, out
	}
	base := "/api/v1/tournaments/" + tid + "/matches/" + mid

	// assign with NO scorekeeper and NO session → allowed in open mode
	if code, resp := do(base+"/assign", `{"tableRef":"5"}`, ""); code != http.StatusOK {
		t.Fatalf("open assign: want 200, got %d (%v)", code, resp)
	}
	if code, _ := do(base+"/start", `{}`, ""); code != http.StatusOK {
		t.Fatalf("open start: want 200, got %d", code)
	}
	body := `{"winnerEntrantId":"` + a + `","loserEntrantId":"` + b + `"}`
	if code, resp := do(base+"/result", body, "ok1"); code != http.StatusOK {
		t.Fatalf("open result: want 200, got %d (%v)", code, resp)
	}
	// match is now completed
	nm, _ := e.api.getMatch(context.Background(), tid, mid)
	if nm == nil || nm.State != "completed" {
		t.Fatalf("match should be completed via open scoring")
	}
}

// TestScorekeeperRequiredWhenClosed confirms the scorekeeper check still applies
// when open editing is off (regression guard).
func TestScorekeeperRequiredWhenClosed(t *testing.T) {
	e := newTestEnv(t) // OpenMatchEditing defaults false
	tid, mid, _, _ := e.mkLiveMatchUnstarted(t)
	// assign with no/invalid scorekeeper → 400 (via the normal director route)
	if code, _ := e.do(t, "POST", "/api/v1/tournaments/"+tid+"/matches/"+mid+"/assign", e.director, `{"tableRef":"5"}`); code != http.StatusBadRequest {
		t.Fatalf("closed assign w/o scorekeeper: want 400, got %d", code)
	}
}
