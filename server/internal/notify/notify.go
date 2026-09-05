// Package notify delivers outbound match-ready SMS alerts through a transactional
// outbox, mirroring the Challonge sync worker: rows in `notifications` are claimed
// serially by a worker, sent via a Sender, and retried with exponential backoff
// before dead-lettering. A Sender abstracts the SMS provider so tests use a fake.
package notify

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"log"
	"time"
)

// Sender delivers one message. Errors may implement Retryabler; otherwise the
// failure is treated as permanent (dead-lettered immediately).
type Sender interface {
	Send(ctx context.Context, to, body string) (providerMessageID string, err error)
}

type Retryabler interface{ Retryable() bool }

func isRetryable(err error) bool {
	var r Retryabler
	if errors.As(err, &r) {
		return r.Retryable()
	}
	return false
}

const maxAttempts = 5

// Execer is satisfied by *sql.DB and *sql.Tx (so enqueue can join a caller's tx).
type Execer interface {
	ExecContext(ctx context.Context, query string, args ...interface{}) (sql.Result, error)
}

type Notification struct {
	TournamentID string
	MatchID      string
	EntrantID    string
	Recipient    string // E.164 phone
	Body         string
	DedupeKey    string // idempotency: one send per (match,recipient,kind)
}

type Worker struct {
	DB       *sql.DB
	Sender   Sender
	Interval time.Duration
}

func newID(p string) string {
	b := make([]byte, 10)
	_, _ = rand.Read(b)
	return p + hex.EncodeToString(b)
}

func now() int64 { return time.Now().Unix() }

// Enqueue inserts a pending notification. Idempotent by dedupe_key: a duplicate
// key is ignored (no second text). Safe to call inside the caller's transaction.
func Enqueue(ctx context.Context, ex Execer, n Notification) error {
	_, err := ex.ExecContext(ctx,
		`INSERT OR IGNORE INTO notifications (id, tournament_id, match_id, entrant_id, channel, recipient, body, status, next_attempt_at, dedupe_key, created_at, updated_at)
		 VALUES (?,?,?,?, 'sms', ?, ?, 'pending', 0, ?, ?, ?)`,
		newID("ntf_"), n.TournamentID, nullStr(n.MatchID), nullStr(n.EntrantID),
		n.Recipient, n.Body, nullStr(n.DedupeKey), now(), now())
	return err
}

// Run polls for ready notifications until ctx is cancelled.
func (wk *Worker) Run(ctx context.Context) {
	if wk.Interval == 0 {
		wk.Interval = 5 * time.Second
	}
	t := time.NewTicker(wk.Interval)
	defer t.Stop()
	log.Printf("notify: SMS worker started (interval %s)", wk.Interval)
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			for wk.ProcessOne(ctx) {
			}
		}
	}
}

// ProcessOne claims and sends at most one ready notification. Returns true if it did.
func (wk *Worker) ProcessOne(ctx context.Context) bool {
	var id, to, body string
	err := wk.DB.QueryRowContext(ctx,
		`SELECT id, recipient, body FROM notifications
		 WHERE status='pending' AND next_attempt_at<=? ORDER BY created_at LIMIT 1`, now()).Scan(&id, &to, &body)
	if err != nil {
		return false
	}
	res, _ := wk.DB.ExecContext(ctx, `UPDATE notifications SET status='processing', updated_at=? WHERE id=? AND status='pending'`, now(), id)
	if n, _ := res.RowsAffected(); n == 0 {
		return true // claimed by someone else; keep looping
	}

	provID, sendErr := wk.Sender.Send(ctx, to, body)
	if sendErr == nil {
		_, _ = wk.DB.ExecContext(ctx,
			`UPDATE notifications SET status='sent', provider_message_id=?, last_error=NULL, updated_at=? WHERE id=?`, provID, now(), id)
		return true
	}
	var attempts int
	_ = wk.DB.QueryRowContext(ctx, `SELECT attempts FROM notifications WHERE id=?`, id).Scan(&attempts)
	attempts++
	if attempts >= maxAttempts || !isRetryable(sendErr) {
		_, _ = wk.DB.ExecContext(ctx,
			`UPDATE notifications SET status='dead_lettered', attempts=?, last_error=?, updated_at=? WHERE id=?`, attempts, sendErr.Error(), now(), id)
		log.Printf("notify: message %s dead-lettered: %v", id, sendErr)
		return true
	}
	backoff := int64(1)
	for i := 0; i < attempts; i++ {
		backoff *= 2
	}
	if backoff > 300 {
		backoff = 300
	}
	_, _ = wk.DB.ExecContext(ctx,
		`UPDATE notifications SET status='pending', attempts=?, next_attempt_at=?, last_error=?, updated_at=? WHERE id=?`,
		attempts, now()+backoff, sendErr.Error(), now(), id)
	return true
}

func nullStr(s string) interface{} {
	if s == "" {
		return nil
	}
	return s
}
