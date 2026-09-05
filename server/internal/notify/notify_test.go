package notify

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/kevinelong/15ball-scoresheet/server/internal/store"
)

func setup(t *testing.T) *store.Store {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "n.db"))
	if err != nil {
		t.Fatalf("store: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	return st
}

func mk(tid, key string) Notification {
	return Notification{TournamentID: tid, MatchID: "m1", EntrantID: "e1", Recipient: "+15551234567", Body: "ready", DedupeKey: key}
}

func TestEnqueueIdempotent(t *testing.T) {
	st := setup(t)
	ctx := context.Background()
	if err := Enqueue(ctx, st.DB, mk("t1", "dk1")); err != nil {
		t.Fatalf("enqueue: %v", err)
	}
	if err := Enqueue(ctx, st.DB, mk("t1", "dk1")); err != nil {
		t.Fatalf("enqueue 2: %v", err)
	}
	var n int
	st.DB.QueryRow(`SELECT COUNT(*) FROM notifications WHERE dedupe_key='dk1'`).Scan(&n)
	if n != 1 {
		t.Fatalf("dedupe: want 1 row, got %d", n)
	}
}

func TestSendHappyPath(t *testing.T) {
	st := setup(t)
	ctx := context.Background()
	Enqueue(ctx, st.DB, mk("t1", "dk1"))
	fake := &FakeSender{}
	wk := &Worker{DB: st.DB, Sender: fake}
	if !wk.ProcessOne(ctx) {
		t.Fatalf("ProcessOne should have sent a message")
	}
	var status, provID string
	st.DB.QueryRow(`SELECT status, COALESCE(provider_message_id,'') FROM notifications WHERE dedupe_key='dk1'`).Scan(&status, &provID)
	if status != "sent" || provID == "" {
		t.Fatalf("after send: status=%s prov=%s", status, provID)
	}
	if len(fake.Messages) != 1 || fake.Messages[0].To != "+15551234567" {
		t.Fatalf("fake did not record the send: %+v", fake.Messages)
	}
}

func TestSendRetryThenSucceed(t *testing.T) {
	st := setup(t)
	ctx := context.Background()
	Enqueue(ctx, st.DB, mk("t1", "dk1"))
	wk := &Worker{DB: st.DB, Sender: &FakeSender{FailUntil: 1}}
	wk.ProcessOne(ctx) // transient fail → pending
	var status string
	var attempts int
	st.DB.QueryRow(`SELECT status, attempts FROM notifications WHERE dedupe_key='dk1'`).Scan(&status, &attempts)
	if status != "pending" || attempts != 1 {
		t.Fatalf("after transient: status=%s attempts=%d (want pending/1)", status, attempts)
	}
	st.DB.Exec(`UPDATE notifications SET next_attempt_at=0 WHERE dedupe_key='dk1'`)
	wk.ProcessOne(ctx)
	st.DB.QueryRow(`SELECT status FROM notifications WHERE dedupe_key='dk1'`).Scan(&status)
	if status != "sent" {
		t.Fatalf("after retry: status=%s (want sent)", status)
	}
}

// TestLazyResolveActivates verifies the worker no-ops while Resolve returns nil
// (SMS not configured), then sends once a sender becomes available — the
// hot-load-without-restart path.
func TestLazyResolveActivates(t *testing.T) {
	st := setup(t)
	ctx := context.Background()
	Enqueue(ctx, st.DB, mk("t1", "dk1"))

	fake := &FakeSender{}
	var ready bool
	wk := &Worker{DB: st.DB, Resolve: func() Sender {
		if !ready {
			return nil
		}
		return fake
	}}

	// Not configured yet → job stays pending, nothing sent.
	if wk.ProcessOne(ctx) {
		t.Fatalf("should no-op while resolver returns nil")
	}
	var status string
	st.DB.QueryRow(`SELECT status FROM notifications WHERE dedupe_key='dk1'`).Scan(&status)
	if status != "pending" {
		t.Fatalf("job should remain pending, got %s", status)
	}

	// Creds arrive → worker activates and sends.
	ready = true
	if !wk.ProcessOne(ctx) {
		t.Fatalf("should send once resolver yields a sender")
	}
	st.DB.QueryRow(`SELECT status FROM notifications WHERE dedupe_key='dk1'`).Scan(&status)
	if status != "sent" || len(fake.Messages) != 1 {
		t.Fatalf("after activation: status=%s sent=%d", status, len(fake.Messages))
	}
}

func TestSendDeadLetter(t *testing.T) {
	st := setup(t)
	ctx := context.Background()
	Enqueue(ctx, st.DB, mk("t1", "dk1"))
	wk := &Worker{DB: st.DB, Sender: &FakeSender{FailFatal: true}}
	wk.ProcessOne(ctx)
	var status string
	st.DB.QueryRow(`SELECT status FROM notifications WHERE dedupe_key='dk1'`).Scan(&status)
	if status != "dead_lettered" {
		t.Fatalf("fatal send: status=%s (want dead_lettered)", status)
	}
}
