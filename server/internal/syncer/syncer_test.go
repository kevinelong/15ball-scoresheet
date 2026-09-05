package syncer

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/kevinelong/15ball-scoresheet/server/internal/store"
)

func setup(t *testing.T) (*store.Store, string) {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "s.db"))
	if err != nil {
		t.Fatalf("store: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	now := time.Now().Unix()
	tid := "trn_test"
	if _, err := st.DB.Exec(`INSERT INTO tournaments (id,slug,name,game,state,visibility,created_by,created_at,updated_at,version) VALUES (?,?,?,?,?,?,?,?,?,1)`,
		tid, "test", "Test Cup", "15ball_rotation", "in_progress", "private", "u_x", now, now); err != nil {
		t.Fatalf("insert tournament: %v", err)
	}
	for i, n := range []string{"Ann", "Bob"} {
		st.DB.Exec(`INSERT INTO entrants (id,tournament_id,display_name,state,created_at,updated_at) VALUES (?,?,?,?,?,?)`,
			"ent_"+string(rune('a'+i)), tid, n, "checked_in", now, now)
	}
	return st, tid
}

func TestSyncHappyPath(t *testing.T) {
	st, tid := setup(t)
	ctx := context.Background()
	fake := NewFake()
	wk := &Worker{DB: st.DB, Provider: fake}

	jobID, ok, err := Enqueue(ctx, st.DB, tid, "k1")
	if err != nil || !ok || jobID == "" {
		t.Fatalf("enqueue: id=%q ok=%v err=%v", jobID, ok, err)
	}
	if !wk.processOne(ctx) {
		t.Fatalf("processOne should have run a job")
	}
	var jobStatus, syncState, provID string
	st.DB.QueryRow(`SELECT status FROM outbox_jobs WHERE id=?`, jobID).Scan(&jobStatus)
	st.DB.QueryRow(`SELECT sync_state, COALESCE(provider_tournament_id,'') FROM challonge_tournaments WHERE tournament_id=?`, tid).Scan(&syncState, &provID)
	if jobStatus != "completed" || syncState != "synced" || provID == "" {
		t.Fatalf("after sync: job=%s state=%s prov=%s", jobStatus, syncState, provID)
	}
	var mapped int
	st.DB.QueryRow(`SELECT COUNT(*) FROM challonge_participant_map WHERE tournament_id=?`, tid).Scan(&mapped)
	if mapped != 2 {
		t.Fatalf("want 2 mapped participants, got %d", mapped)
	}
	// idempotent: same key after completion returns the same job
	if id2, ok2, _ := Enqueue(ctx, st.DB, tid, "k1"); !ok2 || id2 != jobID {
		t.Fatalf("idempotent re-enqueue: id=%q ok=%v (want %s/true)", id2, ok2, jobID)
	}
}

func TestSyncOverlap(t *testing.T) {
	st, tid := setup(t)
	ctx := context.Background()
	if _, ok, _ := Enqueue(ctx, st.DB, tid, "k1"); !ok {
		t.Fatalf("first enqueue should succeed")
	}
	if _, ok, _ := Enqueue(ctx, st.DB, tid, "k2"); ok {
		t.Fatalf("overlapping enqueue should be rejected")
	}
}

func TestSyncDeadLetter(t *testing.T) {
	st, tid := setup(t)
	ctx := context.Background()
	wk := &Worker{DB: st.DB, Provider: &FakeProvider{FailFatal: true, Tournaments: map[string]string{}}}
	Enqueue(ctx, st.DB, tid, "k1")
	wk.processOne(ctx)
	var jobStatus, syncState string
	st.DB.QueryRow(`SELECT status FROM outbox_jobs WHERE aggregate_id=?`, tid).Scan(&jobStatus)
	st.DB.QueryRow(`SELECT sync_state FROM challonge_tournaments WHERE tournament_id=?`, tid).Scan(&syncState)
	if jobStatus != "dead_lettered" || syncState != "failed" {
		t.Fatalf("fatal failure: job=%s state=%s (want dead_lettered/failed)", jobStatus, syncState)
	}
	var n int
	st.DB.QueryRow(`SELECT COUNT(*) FROM audit_log WHERE entity_id=? AND action='challonge_sync_failed'`, tid).Scan(&n)
	if n != 1 {
		t.Fatalf("want 1 failure audit row, got %d", n)
	}
}

func TestSyncRetryThenSucceed(t *testing.T) {
	st, tid := setup(t)
	ctx := context.Background()
	wk := &Worker{DB: st.DB, Provider: &FakeProvider{FailUntil: 1, Tournaments: map[string]string{}}}
	jobID, _, _ := Enqueue(ctx, st.DB, tid, "k1")
	wk.processOne(ctx) // fails transiently → pending w/ backoff
	var status string
	var attempts int
	st.DB.QueryRow(`SELECT status, attempts FROM outbox_jobs WHERE id=?`, jobID).Scan(&status, &attempts)
	if status != "pending" || attempts != 1 {
		t.Fatalf("after transient fail: status=%s attempts=%d (want pending/1)", status, attempts)
	}
	// clear backoff and retry → success
	st.DB.Exec(`UPDATE outbox_jobs SET next_attempt_at=0 WHERE id=?`, jobID)
	wk.processOne(ctx)
	st.DB.QueryRow(`SELECT status FROM outbox_jobs WHERE id=?`, jobID).Scan(&status)
	if status != "completed" {
		t.Fatalf("after retry: status=%s (want completed)", status)
	}
}
