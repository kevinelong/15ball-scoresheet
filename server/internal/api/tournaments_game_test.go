package api

import (
	"net/http"
	"testing"
)

func TestCreateTournamentGame(t *testing.T) {
	e := newTestEnv(t)

	// explicit valid game → 201, echoed back
	code, resp := e.do(t, "POST", "/api/v1/tournaments", e.director, `{"name":"Nine","game":"9ball"}`)
	if code != http.StatusCreated {
		t.Fatalf("create 9ball: want 201, got %d (%v)", code, resp)
	}
	trn := resp["tournament"].(map[string]interface{})
	if trn["game"] != "9ball" {
		t.Fatalf("want game=9ball, got %v", trn["game"])
	}

	// unknown discipline → 400
	if code, _ := e.do(t, "POST", "/api/v1/tournaments", e.director, `{"name":"Bad","game":"cricket"}`); code != http.StatusBadRequest {
		t.Fatalf("create cricket: want 400, got %d", code)
	}

	// no game → defaults to 15ball_rotation
	code, resp = e.do(t, "POST", "/api/v1/tournaments", e.director, `{"name":"Default"}`)
	if code != http.StatusCreated {
		t.Fatalf("create default: want 201, got %d (%v)", code, resp)
	}
	trn = resp["tournament"].(map[string]interface{})
	if trn["game"] != "15ball_rotation" {
		t.Fatalf("want default game=15ball_rotation, got %v", trn["game"])
	}
}
