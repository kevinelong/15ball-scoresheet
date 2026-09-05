package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestSSEStream(t *testing.T) {
	e := newTestEnv(t)
	tid := e.mkStartedTournament(t) // emits tournament.updated + match.* events
	e.do(t, "PATCH", "/api/v1/tournaments/"+tid, e.director, `{"visibility":"public"}`)

	// private-by-cookieless would be 403; public → stream. Use a short-lived ctx so
	// the handler returns after one poll cycle.
	ctx, cancel := context.WithTimeout(context.Background(), 1300*time.Millisecond)
	defer cancel()
	req := httptest.NewRequest("GET", "/api/v1/tournaments/"+tid+"/events", nil).WithContext(ctx)
	rec := httptest.NewRecorder()
	e.router.ServeHTTP(rec, req)

	body := rec.Body.String()
	if rec.Code != http.StatusOK {
		t.Fatalf("events: want 200, got %d", rec.Code)
	}
	if !strings.Contains(body, "event: hello") {
		t.Fatalf("stream missing hello: %q", body)
	}
	if !strings.Contains(body, "event: tournament.updated") && !strings.Contains(body, "event: match.updated") {
		t.Fatalf("stream missing replayed events: %q", body)
	}
}

func TestSSEPrivateForbidden(t *testing.T) {
	e := newTestEnv(t)
	tid := e.mkStartedTournament(t) // private by default
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	req := httptest.NewRequest("GET", "/api/v1/tournaments/"+tid+"/events", nil).WithContext(ctx)
	rec := httptest.NewRecorder()
	e.router.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("private events unauth: want 403, got %d", rec.Code)
	}
}
