package api

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/kevinelong/15ball-scoresheet/server/internal/auth"
	"github.com/kevinelong/15ball-scoresheet/server/internal/syncer"
)

// insertUser inserts a bare user row (no roles) and returns its id.
func (e *testEnv) insertUser(t *testing.T, email string) string {
	t.Helper()
	uid := "u_" + email
	now := time.Now().Unix()
	if _, err := e.api.DB.Exec(`INSERT INTO users (id,email,created_at,updated_at,pending_role) VALUES (?,?,?,?,0)`, uid, email, now, now); err != nil {
		t.Fatalf("insertUser: %v", err)
	}
	return uid
}

// mkCookie creates a user with a role and returns a session cookie for them.
func (e *testEnv) mkCookie(t *testing.T, email, role string) string {
	t.Helper()
	uid := e.insertUser(t, email)
	if err := e.auth.GrantRole(context.Background(), uid, role, ""); err != nil {
		t.Fatalf("grant %s: %v", role, err)
	}
	raw, err := e.auth.CreateSession(context.Background(), uid, "", "")
	if err != nil {
		t.Fatalf("session: %v", err)
	}
	return raw
}

// mkLiveMatchUnstarted returns a started tournament with one scheduled round-1
// match and its two entrants (match not yet assigned/started).
func (e *testEnv) mkLiveMatchUnstarted(t *testing.T) (tid, mid, a, b string) {
	t.Helper()
	tid = e.mkStartedTournament(t)
	_, list := e.do(t, "GET", "/api/v1/tournaments/"+tid+"/matches", e.director, "")
	m := list["items"].([]interface{})[0].(map[string]interface{})
	return tid, m["id"].(string), m["entrantAId"].(string), m["entrantBId"].(string)
}

// mkLiveMatch is mkLiveMatchUnstarted + assign scorekeeper + start.
func (e *testEnv) mkLiveMatch(t *testing.T) (tid, mid, a, b string) {
	t.Helper()
	tid, mid, a, b = e.mkLiveMatchUnstarted(t)
	e.do(t, "POST", "/api/v1/tournaments/"+tid+"/matches/"+mid+"/assign", e.director, `{"scorekeeperUserId":"u_scorekeeper@x.com"}`)
	e.do(t, "POST", "/api/v1/tournaments/"+tid+"/matches/"+mid+"/start", e.scorekeeper, `{}`)
	return tid, mid, a, b
}

// completeMatch submits a valid result as the assigned scorekeeper.
func (e *testEnv) completeMatch(t *testing.T, tid, mid, a, b, key string) {
	t.Helper()
	body := `{"winnerEntrantId":"` + a + `","loserEntrantId":"` + b + `"}`
	if code, _ := e.doKey(t, "POST", "/api/v1/tournaments/"+tid+"/matches/"+mid+"/result", e.scorekeeper, body, key); code != http.StatusOK {
		t.Fatalf("completeMatch: want 200, got %d", code)
	}
}

// runSyncAcceptance covers G25–G30 using the HTTP sync endpoints for the
// enqueue/overlap/idempotency contract and the syncer worker with a FakeProvider
// for retry/dead-letter — no live external mutations (scenario 30).
func (e *testEnv) runSyncAcceptance(t *testing.T) {
	ctx := context.Background()
	// Register the Challonge sync routes on this env's router (not part of the
	// base test router). Mirrors main.go authz: director+ for POST, session for GET.
	dir := e.router.With(e.auth.RequireCSRF, e.auth.RequireSession, e.auth.RequireRoles(auth.DirectorOrAbove...))
	dir.Post("/api/v1/tournaments/{id}/challonge/sync", e.api.StartSync)
	e.router.With(e.auth.RequireSession).Get("/api/v1/tournaments/{id}/challonge/sync", e.api.SyncStatus)

	// One fake provider shared across the sync scenarios so its generated provider
	// IDs stay unique within this single database (distinct instances would each
	// restart numbering and collide on challonge_tournaments.provider_tournament_id).
	fake := syncer.NewFake()

	// A live tournament with checked-in entrants to sync.
	tid, _, _, _ := e.mkLiveMatch(t)

	// G25: enqueue returns 202.
	code, resp := e.doKey(t, "POST", "/api/v1/tournaments/"+tid+"/challonge/sync", e.director, `{}`, "sync-k1")
	if code != http.StatusAccepted {
		t.Fatalf("G25 enqueue: want 202, got %d (%v)", code, resp)
	}
	jobID := resp["jobId"].(string)

	// G27: overlap (different key, job still pending) → 409 sync_in_progress.
	if code, r := e.doKey(t, "POST", "/api/v1/tournaments/"+tid+"/challonge/sync", e.director, `{}`, "sync-k2"); code != http.StatusConflict {
		t.Fatalf("G27 overlap: want 409, got %d (%v)", code, r)
	}

	// Process the pending job with the fake provider → completes (no live calls).
	wk := &syncer.Worker{DB: e.api.DB, Provider: fake}
	if !wk.ProcessOne(ctx) {
		t.Fatalf("G_process: worker did not pick up the pending job")
	}
	var status string
	e.api.DB.QueryRow(`SELECT status FROM outbox_jobs WHERE id=?`, jobID).Scan(&status)
	if status != "completed" {
		t.Fatalf("G_process: job status=%s (want completed)", status)
	}
	if len(fake.Participants) == 0 {
		t.Fatalf("G30: fake provider should have received participant writes (no live calls)")
	}

	// G26: duplicate request with the SAME key after completion is idempotent
	// (returns the same job, 202) — not a new sync.
	code, resp = e.doKey(t, "POST", "/api/v1/tournaments/"+tid+"/challonge/sync", e.director, `{}`, "sync-k1")
	if code != http.StatusAccepted || resp["jobId"].(string) != jobID {
		t.Fatalf("G26 idempotent: want 202 same job %s, got %d %v", jobID, code, resp["jobId"])
	}

	// G28: retryable provider error backs off (stays pending) then recovers.
	fake.FailUntil = 1
	tid28, _, _, _ := e.mkLiveMatch(t)
	rjob, _, _ := syncer.Enqueue(ctx, e.api.DB, tid28, "sync-retry")
	wk.ProcessOne(ctx) // transient fail → pending
	var rstatus string
	var attempts int
	e.api.DB.QueryRow(`SELECT status, attempts FROM outbox_jobs WHERE id=?`, rjob).Scan(&rstatus, &attempts)
	if rstatus != "pending" || attempts != 1 {
		t.Fatalf("G28 retry: status=%s attempts=%d (want pending/1)", rstatus, attempts)
	}
	e.api.DB.Exec(`UPDATE outbox_jobs SET next_attempt_at=0 WHERE id=?`, rjob)
	wk.ProcessOne(ctx)
	e.api.DB.QueryRow(`SELECT status FROM outbox_jobs WHERE id=?`, rjob).Scan(&rstatus)
	if rstatus != "completed" {
		t.Fatalf("G28 recover: status=%s (want completed)", rstatus)
	}

	// G29: permanent provider error → dead_lettered + audit + SSE notification.
	fake.FailFatal = true
	tid29, _, _, _ := e.mkLiveMatch(t)
	djob, _, _ := syncer.Enqueue(ctx, e.api.DB, tid29, "sync-fatal")
	wk.ProcessOne(ctx)
	var dstatus string
	e.api.DB.QueryRow(`SELECT status FROM outbox_jobs WHERE id=?`, djob).Scan(&dstatus)
	if dstatus != "dead_lettered" {
		t.Fatalf("G29 fatal: status=%s (want dead_lettered)", dstatus)
	}
	var auditN, sseN int
	e.api.DB.QueryRow(`SELECT COUNT(*) FROM audit_log WHERE entity_id=? AND action='challonge_sync_failed'`, tid29).Scan(&auditN)
	e.api.DB.QueryRow(`SELECT COUNT(*) FROM sse_event_log WHERE tournament_id=? AND event_type='challonge.sync_updated'`, tid29).Scan(&sseN)
	if auditN != 1 || sseN != 1 {
		t.Fatalf("G29 notifications: audit=%d sse=%d (want 1/1)", auditN, sseN)
	}
}
