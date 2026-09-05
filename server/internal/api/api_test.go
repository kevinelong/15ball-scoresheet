package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/kevinelong/15ball-scoresheet/server/internal/auth"
	"github.com/kevinelong/15ball-scoresheet/server/internal/config"
	"github.com/kevinelong/15ball-scoresheet/server/internal/mail"
	"github.com/kevinelong/15ball-scoresheet/server/internal/store"
)

type testEnv struct {
	api      *API
	auth     *auth.Auth
	router   *chi.Mux
	director    string // session cookie value
	viewer      string
	scorekeeper string
}

func newTestEnv(t *testing.T) *testEnv {
	t.Helper()
	dir := t.TempDir()
	st, err := store.Open(filepath.Join(dir, "t.db"))
	if err != nil {
		t.Fatalf("store: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	cfg := config.Load()
	cfg.BootstrapAdmins = nil
	a := auth.New(st.DB, cfg, &mail.LogMailer{})
	dapi := New(st.DB, a)
	ctx := context.Background()

	mkUser := func(email, role string) string {
		uid := "u_" + email
		now := time.Now().Unix()
		if _, err := st.DB.ExecContext(ctx, `INSERT INTO users (id,email,created_at,updated_at,pending_role) VALUES (?,?,?,?,0)`, uid, email, now, now); err != nil {
			t.Fatalf("mkuser: %v", err)
		}
		if role != "" {
			if err := a.GrantRole(ctx, uid, role, ""); err != nil {
				t.Fatalf("grant: %v", err)
			}
		} else {
			_ = a.GrantRole(ctx, uid, auth.RoleViewer, "")
		}
		raw, err := a.CreateSession(ctx, uid, "", "")
		if err != nil {
			t.Fatalf("session: %v", err)
		}
		return raw
	}

	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	sess := r.With(a.RequireSession)
	director := r.With(a.RequireCSRF, a.RequireSession, a.RequireRoles(auth.DirectorOrAbove...))
	sess.Get("/api/v1/tournaments", dapi.ListTournaments)
	director.Post("/api/v1/tournaments", dapi.CreateTournament)
	sess.Get("/api/v1/tournaments/{id}", dapi.GetTournament)
	director.Patch("/api/v1/tournaments/{id}", dapi.PatchTournament)
	director.Post("/api/v1/tournaments/{id}/archive", dapi.ArchiveTournament)
	sess.Get("/api/v1/tournaments/{id}/divisions", dapi.ListDivisions)
	director.Post("/api/v1/tournaments/{id}/divisions", dapi.CreateDivision)
	sess.Get("/api/v1/tournaments/{id}/entrants", dapi.ListEntrants)
	director.Post("/api/v1/tournaments/{id}/entrants", dapi.CreateEntrant)
	director.Patch("/api/v1/tournaments/{id}/entrants/{entrantId}", dapi.PatchEntrant)
	director.Post("/api/v1/tournaments/{id}/entrants/{entrantId}/check-in", dapi.CheckInEntrant)
	director.Post("/api/v1/tournaments/{id}/entrants/{entrantId}/archive", dapi.ArchiveEntrant)

	sess.Get("/api/v1/tournaments/{id}/matches", dapi.ListMatches)
	director.Post("/api/v1/tournaments/{id}/matches/{matchId}/assign", dapi.AssignMatch)
	sess.With(a.RequireCSRF).Post("/api/v1/tournaments/{id}/matches/{matchId}/start", dapi.StartMatch)
	sess.Get("/api/v1/tournaments/{id}/matches/{matchId}/history", dapi.MatchHistory)

	return &testEnv{api: dapi, auth: a, router: r,
		director:   mkUser("director@x.com", auth.RoleTournamentDirector),
		viewer:     mkUser("viewer@x.com", auth.RoleViewer),
		scorekeeper: mkUser("scorekeeper@x.com", auth.RoleScorekeeper)}
}

func (e *testEnv) do(t *testing.T, method, path, cookie, body string) (int, map[string]interface{}) {
	t.Helper()
	var rdr *bytes.Reader
	if body != "" {
		rdr = bytes.NewReader([]byte(body))
	} else {
		rdr = bytes.NewReader(nil)
	}
	req := httptest.NewRequest(method, path, rdr)
	if cookie != "" {
		req.AddCookie(&http.Cookie{Name: "fifteenball_session", Value: cookie})
	}
	if method != http.MethodGet {
		req.Header.Set("X-CO", "1")
		req.Header.Set("Content-Type", "application/json")
	}
	rec := httptest.NewRecorder()
	e.router.ServeHTTP(rec, req)
	var out map[string]interface{}
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

func TestTournamentLifecycle(t *testing.T) {
	e := newTestEnv(t)

	// viewer cannot create → 403
	if code, _ := e.do(t, "POST", "/api/v1/tournaments", e.viewer, `{"name":"Fall Open"}`); code != http.StatusForbidden {
		t.Fatalf("viewer create: want 403, got %d", code)
	}
	// director creates → 201, draft
	code, resp := e.do(t, "POST", "/api/v1/tournaments", e.director, `{"name":"Fall Open"}`)
	if code != http.StatusCreated {
		t.Fatalf("create: want 201, got %d (%v)", code, resp)
	}
	trn := resp["tournament"].(map[string]interface{})
	id := trn["id"].(string)
	if trn["state"] != "draft" {
		t.Fatalf("new tournament should be draft, got %v", trn["state"])
	}

	// open registration with no division → 409
	if code, _ := e.do(t, "PATCH", "/api/v1/tournaments/"+id, e.director, `{"state":"registration_open"}`); code != http.StatusConflict {
		t.Fatalf("open w/o division: want 409, got %d", code)
	}
	// add a division
	if code, _ := e.do(t, "POST", "/api/v1/tournaments/"+id+"/divisions", e.director, `{"name":"Open"}`); code != http.StatusCreated {
		t.Fatalf("division create: want 201, got %d", code)
	}
	// duplicate division → 409
	if code, _ := e.do(t, "POST", "/api/v1/tournaments/"+id+"/divisions", e.director, `{"name":"Open"}`); code != http.StatusConflict {
		t.Fatalf("dup division: want 409, got %d", code)
	}
	// now open registration → 200
	if code, _ := e.do(t, "PATCH", "/api/v1/tournaments/"+id, e.director, `{"state":"registration_open"}`); code != http.StatusOK {
		t.Fatalf("open registration: want 200, got %d", code)
	}
	// unsupported transition registration_open→completed → 409
	if code, _ := e.do(t, "PATCH", "/api/v1/tournaments/"+id, e.director, `{"state":"completed"}`); code != http.StatusConflict {
		t.Fatalf("bad transition: want 409, got %d", code)
	}
	// list (viewer can read) → 200 with the item
	code, list := e.do(t, "GET", "/api/v1/tournaments", e.viewer, "")
	if code != http.StatusOK || len(list["items"].([]interface{})) != 1 {
		t.Fatalf("list: want 200 w/ 1 item, got %d %v", code, list["items"])
	}
	// archive → 200, then again → 409
	if code, _ := e.do(t, "POST", "/api/v1/tournaments/"+id+"/archive", e.director, `{"reason":"test"}`); code != http.StatusOK {
		t.Fatalf("archive: want 200, got %d", code)
	}
	if code, _ := e.do(t, "POST", "/api/v1/tournaments/"+id+"/archive", e.director, `{}`); code != http.StatusConflict {
		t.Fatalf("re-archive: want 409, got %d", code)
	}
	// default list now excludes archived
	if _, list := e.do(t, "GET", "/api/v1/tournaments", e.viewer, ""); len(list["items"].([]interface{})) != 0 {
		t.Fatalf("archived should be excluded by default")
	}
	// audit rows exist for this tournament
	var n int
	_ = e.api.DB.QueryRow(`SELECT COUNT(*) FROM audit_log WHERE entity_type='tournament' AND entity_id=?`, id).Scan(&n)
	if n < 3 { // created, state_changed, archived
		t.Fatalf("want >=3 audit rows, got %d", n)
	}
}
