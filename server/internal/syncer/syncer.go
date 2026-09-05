// Package syncer runs the transactional outbox that reflects local canonical
// tournament state into Challonge (07-challonge-sync-contract). Local records are
// authoritative; the worker consumes outbox_jobs serially with exponential
// backoff and dead-lettering. A Provider abstracts the external API so tests use
// a fake (no live calls).
package syncer

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"time"
)

// Provider is the external tournament backend (Challonge). Errors may implement
// Retryabler; otherwise they are treated as non-retryable.
type Provider interface {
	EnsureTournament(ctx context.Context, name, urlKey string) (providerID, providerURL string, err error)
	AddParticipant(ctx context.Context, providerTournamentID, name string) (providerParticipantID string, err error)
}

type Retryabler interface{ Retryable() bool }

func isRetryable(err error) bool {
	var r Retryabler
	if errors.As(err, &r) {
		return r.Retryable()
	}
	return false
}

const maxAttempts = 8

type Worker struct {
	DB       *sql.DB
	Provider Provider
	Interval time.Duration
}

func newID(p string) string {
	b := make([]byte, 10)
	_, _ = rand.Read(b)
	return p + hex.EncodeToString(b)
}

func now() int64 { return time.Now().Unix() }

// Enqueue creates a sync job for a tournament unless one is already active. Returns
// (jobID, false) if a job is already pending/processing (overlap).
func Enqueue(ctx context.Context, db *sql.DB, tournamentID, idempotencyKey string) (string, bool, error) {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return "", false, err
	}
	defer tx.Rollback()
	var active int
	if err := tx.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM outbox_jobs WHERE aggregate_id=? AND status IN ('pending','processing')`, tournamentID).Scan(&active); err != nil {
		return "", false, err
	}
	if active > 0 {
		return "", false, nil // overlap
	}
	// idempotent: same key returns the existing job
	if idempotencyKey != "" {
		var existing string
		if err := tx.QueryRowContext(ctx, `SELECT id FROM outbox_jobs WHERE idempotency_key=?`, idempotencyKey).Scan(&existing); err == nil {
			return existing, true, tx.Commit()
		}
	}
	id := newID("job_")
	t := now()
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO outbox_jobs (id, kind, aggregate_type, aggregate_id, status, next_attempt_at, idempotency_key, created_at, updated_at)
		 VALUES (?, 'challonge.sync', 'tournament', ?, 'pending', 0, ?, ?, ?)`,
		id, tournamentID, nullStr(idempotencyKey), t, t); err != nil {
		return "", false, err
	}
	_, _ = tx.ExecContext(ctx,
		`INSERT OR IGNORE INTO challonge_tournaments (tournament_id, sync_state, created_at, updated_at) VALUES (?, 'not_synced', ?, ?)`,
		tournamentID, t, t)
	return id, true, tx.Commit()
}

// Run polls for ready jobs until ctx is cancelled.
func (wk *Worker) Run(ctx context.Context) {
	if wk.Interval == 0 {
		wk.Interval = 5 * time.Second
	}
	t := time.NewTicker(wk.Interval)
	defer t.Stop()
	log.Printf("syncer: outbox worker started (interval %s)", wk.Interval)
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			for wk.processOne(ctx) {
			}
		}
	}
}

// processOne claims and runs a single ready job. Returns true if it processed one.
func (wk *Worker) processOne(ctx context.Context) bool {
	var id, kind, aggID string
	err := wk.DB.QueryRowContext(ctx,
		`SELECT id, kind, aggregate_id FROM outbox_jobs
		 WHERE status='pending' AND next_attempt_at<=? ORDER BY created_at LIMIT 1`, now()).Scan(&id, &kind, &aggID)
	if err != nil {
		return false
	}
	res, _ := wk.DB.ExecContext(ctx, `UPDATE outbox_jobs SET status='processing', updated_at=? WHERE id=? AND status='pending'`, now(), id)
	if n, _ := res.RowsAffected(); n == 0 {
		return true // someone else claimed it; keep looping
	}
	_, _ = wk.DB.ExecContext(ctx, `UPDATE challonge_tournaments SET sync_state='in_progress', updated_at=? WHERE tournament_id=?`, now(), aggID)

	runErr := wk.runSync(ctx, aggID)
	if runErr == nil {
		_, _ = wk.DB.ExecContext(ctx, `UPDATE outbox_jobs SET status='completed', updated_at=? WHERE id=?`, now(), id)
		_, _ = wk.DB.ExecContext(ctx, `UPDATE challonge_tournaments SET sync_state='synced', last_synced_at=?, last_error=NULL, updated_at=? WHERE tournament_id=?`, now(), now(), aggID)
		return true
	}
	// failure: classify + backoff/dead-letter
	var attempts int
	_ = wk.DB.QueryRowContext(ctx, `SELECT attempts FROM outbox_jobs WHERE id=?`, id).Scan(&attempts)
	attempts++
	if attempts >= maxAttempts || !isRetryable(runErr) {
		_, _ = wk.DB.ExecContext(ctx, `UPDATE outbox_jobs SET status='dead_lettered', attempts=?, last_error=?, updated_at=? WHERE id=?`, attempts, runErr.Error(), now(), id)
		_, _ = wk.DB.ExecContext(ctx, `UPDATE challonge_tournaments SET sync_state='failed', last_error=?, updated_at=? WHERE tournament_id=?`, runErr.Error(), now(), aggID)
		_, _ = wk.DB.ExecContext(ctx,
			`INSERT INTO audit_log (id, entity_type, entity_id, action, reason, created_at) VALUES (?, 'tournament', ?, 'challonge_sync_failed', ?, ?)`,
			newID("aud_"), aggID, runErr.Error(), now())
		_, _ = wk.DB.ExecContext(ctx,
			`INSERT INTO sse_event_log (tournament_id, event_type, event_version, payload_json, created_at) VALUES (?, 'challonge.sync_updated', 1, '{"state":"failed"}', ?)`, aggID, now())
		log.Printf("syncer: job %s dead-lettered: %v", id, runErr)
		return true
	}
	backoff := int64(1)
	for i := 0; i < attempts; i++ {
		backoff *= 2
	}
	if backoff > 300 {
		backoff = 300
	}
	_, _ = wk.DB.ExecContext(ctx, `UPDATE outbox_jobs SET status='pending', attempts=?, next_attempt_at=?, last_error=?, updated_at=? WHERE id=?`,
		attempts, now()+backoff, runErr.Error(), now(), id)
	return true
}

// runSync reflects local state into the provider: ensure the tournament exists,
// then map every entrant as a participant. Idempotent via the mapping tables.
func (wk *Worker) runSync(ctx context.Context, tid string) error {
	var name string
	if err := wk.DB.QueryRowContext(ctx, `SELECT name FROM tournaments WHERE id=?`, tid).Scan(&name); err != nil {
		return err
	}
	var provID sql.NullString
	_ = wk.DB.QueryRowContext(ctx, `SELECT provider_tournament_id FROM challonge_tournaments WHERE tournament_id=?`, tid).Scan(&provID)
	if !provID.Valid || provID.String == "" {
		pid, purl, err := wk.Provider.EnsureTournament(ctx, name, "fb-"+tid)
		if err != nil {
			return fmt.Errorf("ensure_tournament: %w", err)
		}
		if _, err := wk.DB.ExecContext(ctx,
			`UPDATE challonge_tournaments SET provider_tournament_id=?, provider_url=?, updated_at=? WHERE tournament_id=?`,
			pid, purl, now(), tid); err != nil {
			return err
		}
		provID = sql.NullString{String: pid, Valid: true}
	}
	// map unmapped entrants
	rows, err := wk.DB.QueryContext(ctx,
		`SELECT e.id, e.display_name FROM entrants e
		 WHERE e.tournament_id=? AND e.archived_at IS NULL
		   AND NOT EXISTS (SELECT 1 FROM challonge_participant_map m WHERE m.tournament_id=e.tournament_id AND m.entrant_id=e.id)`, tid)
	if err != nil {
		return err
	}
	type ent struct{ id, name string }
	var todo []ent
	for rows.Next() {
		var e ent
		_ = rows.Scan(&e.id, &e.name)
		todo = append(todo, e)
	}
	rows.Close()
	for _, e := range todo {
		ppid, err := wk.Provider.AddParticipant(ctx, provID.String, e.name)
		if err != nil {
			return fmt.Errorf("add_participant: %w", err)
		}
		if _, err := wk.DB.ExecContext(ctx,
			`INSERT OR IGNORE INTO challonge_participant_map (tournament_id, entrant_id, provider_participant_id) VALUES (?,?,?)`,
			tid, e.id, ppid); err != nil {
			return err
		}
	}
	return nil
}

func nullStr(s string) interface{} {
	if s == "" {
		return nil
	}
	return s
}
