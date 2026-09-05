package api

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestSnapshotPublicAudit(t *testing.T) {
	e := newTestEnv(t)
	tid := e.mkStartedTournament(t)

	// snapshot (authenticated) → 200 with tournament + matches + overlay
	code, snap := e.do(t, "GET", "/api/v1/tournaments/"+tid+"/snapshot", e.viewer, "")
	if code != http.StatusOK || snap["tournament"] == nil || snap["overlay"] == nil {
		t.Fatalf("snapshot: want 200 w/ tournament+overlay, got %d", code)
	}

	// public endpoint on a private tournament → 404
	if code := e.pub(t, "/api/v1/public/tournaments/"+tid); code != http.StatusNotFound {
		t.Fatalf("public private tournament: want 404, got %d", code)
	}
	// make it public, then public endpoints → 200
	e.do(t, "PATCH", "/api/v1/tournaments/"+tid, e.director, `{"visibility":"public"}`)
	if code := e.pub(t, "/api/v1/public/tournaments/"+tid); code != http.StatusOK {
		t.Fatalf("public public tournament: want 200, got %d", code)
	}
	if code := e.pub(t, "/api/v1/public/tournaments/"+tid+"/overlay"); code != http.StatusOK {
		t.Fatalf("public overlay: want 200, got %d", code)
	}

	// audit: director can read, viewer forbidden
	if code, aud := e.do(t, "GET", "/api/v1/tournaments/"+tid+"/audit", e.director, ""); code != http.StatusOK || len(aud["items"].([]interface{})) == 0 {
		t.Fatalf("audit director: want 200 w/ items, got %d", code)
	}
	if code, _ := e.do(t, "GET", "/api/v1/tournaments/"+tid+"/audit", e.viewer, ""); code != http.StatusForbidden {
		t.Fatalf("audit viewer: want 403, got %d", code)
	}
}

// pub issues an unauthenticated GET.
func (e *testEnv) pub(t *testing.T, path string) int {
	t.Helper()
	req := httptest.NewRequest("GET", path, nil)
	rec := httptest.NewRecorder()
	e.router.ServeHTTP(rec, req)
	return rec.Code
}
