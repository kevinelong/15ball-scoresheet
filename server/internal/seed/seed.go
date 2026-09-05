// Package seed provides deterministic, idempotent fixtures for tests and local
// bring-up (10-fixtures-and-seeds). Every row has a stable primary key so the
// whole set is written with INSERT OR IGNORE and re-running Seed is a no-op.
//
// Fixtures deliberately include both success- and failure-path data:
//   - t_live_001 exercises the full match state machine incl. a corrected match
//     (two match_results versions) and a partially-mapped Challonge tournament;
//   - t_done_001 is a completed, fully-synced tournament;
//   - t_open_001 carries a dead-lettered outbox job (failed sync + retry metadata);
//   - t_arch_001 is archived (excluded from default listings).
package seed

import (
	"context"
	"database/sql"
	"fmt"
)

// base is a fixed epoch (2026-01-01T00:00:00Z) so created_at/updated_at are
// stable across runs — determinism the fixture invariants require.
const base int64 = 1767225600

// Execer is satisfied by *sql.DB and *sql.Tx.
type Execer interface {
	ExecContext(ctx context.Context, query string, args ...interface{}) (sql.Result, error)
}

// User / tournament IDs are exported so acceptance tests can reference them.
const (
	UserSysAdmin  = "u_sysadmin"
	UserClubAdmin = "u_clubadmin"
	UserDirector  = "u_director"
	UserScorer1   = "u_scorer1"
	UserPlayer1   = "u_player1"
	UserViewer1   = "u_viewer1"
	UserPending   = "u_pending"

	TournamentOpen = "t_open_001"
	TournamentLive = "t_live_001"
	TournamentDone = "t_done_001"
	TournamentArch = "t_arch_001"
)

type seedUser struct {
	id, email, role string
	pending         bool
}

var seedUsers = []seedUser{
	{UserSysAdmin, "sysadmin@club.test", "system_admin", false},
	{UserClubAdmin, "clubadmin@club.test", "club_admin", false},
	{UserDirector, "director@club.test", "tournament_director", false},
	{UserScorer1, "scorer1@club.test", "scorekeeper", false},
	{UserPlayer1, "player1@club.test", "player", false},
	{UserViewer1, "viewer1@club.test", "viewer", false},
	{UserPending, "pending@club.test", "viewer", true},
}

// Seed writes all fixtures idempotently. Safe to call repeatedly.
func Seed(ctx context.Context, ex Execer) error {
	for _, u := range seedUsers {
		pending := 0
		if u.pending {
			pending = 1
		}
		if err := exec(ctx, ex,
			`INSERT OR IGNORE INTO users (id,email,created_at,updated_at,pending_role) VALUES (?,?,?,?,?)`,
			u.id, u.email, base, base, pending); err != nil {
			return err
		}
		if err := exec(ctx, ex,
			`INSERT OR IGNORE INTO user_roles (id,user_id,role,granted_by,granted_at) VALUES (?,?,?,NULL,?)`,
			"ur_"+u.id+"_"+u.role, u.id, u.role, base); err != nil {
			return err
		}
	}

	if err := seedTournament(ctx, ex, TournamentOpen, "Spring Open", "registration_open", "public", false); err != nil {
		return err
	}
	if err := seedTournament(ctx, ex, TournamentLive, "Summer Live", "in_progress", "public", false); err != nil {
		return err
	}
	if err := seedTournament(ctx, ex, TournamentDone, "Winter Done", "completed", "public", false); err != nil {
		return err
	}
	if err := seedTournament(ctx, ex, TournamentArch, "Old Archived", "archived", "private", true); err != nil {
		return err
	}

	// Matches + results + Challonge mapping live on the tournaments where they make sense.
	if err := seedMatches(ctx, ex, TournamentLive, true); err != nil { // includes in_progress + corrected
		return err
	}
	if err := seedMatches(ctx, ex, TournamentDone, false); err != nil { // all completed
		return err
	}
	return seedChallonge(ctx, ex)
}

func seedTournament(ctx context.Context, ex Execer, id, name, state, vis string, archived bool) error {
	var archAt interface{}
	var archBy interface{}
	if archived {
		archAt = base
		archBy = UserDirector
	}
	if err := exec(ctx, ex,
		`INSERT OR IGNORE INTO tournaments (id,slug,name,game,state,visibility,archived_at,archived_by,created_by,created_at,updated_at,version)
		 VALUES (?,?,?, '15ball_rotation', ?, ?, ?, ?, ?, ?, ?, 1)`,
		id, id, name, state, vis, archAt, archBy, UserDirector, base, base); err != nil {
		return err
	}
	if err := exec(ctx, ex,
		`INSERT OR IGNORE INTO divisions (id,tournament_id,name,format,state,created_at,updated_at)
		 VALUES (?,?, 'Open', 'single_elimination', 'active', ?, ?)`,
		"d_"+id, id, base, base); err != nil {
		return err
	}
	// 8 entrants with mixed states.
	states := []string{"checked_in", "checked_in", "checked_in", "checked_in", "registered", "pending", "withdrawn", "eliminated"}
	for i, st := range states {
		eid := fmt.Sprintf("e_%s_%d", id, i+1)
		var checkIn interface{}
		if st == "checked_in" {
			checkIn = base
		}
		if err := exec(ctx, ex,
			`INSERT OR IGNORE INTO entrants (id,tournament_id,division_id,display_name,state,check_in_at,created_at,updated_at,version)
			 VALUES (?,?,?,?,?,?,?,?,1)`,
			eid, id, "d_"+id, fmt.Sprintf("Player %d", i+1), st, checkIn, base, base); err != nil {
			return err
		}
	}
	if err := exec(ctx, ex,
		`INSERT OR IGNORE INTO audit_log (id,entity_type,entity_id,action,actor_user_id,created_at)
		 VALUES (?, 'tournament', ?, 'created', ?, ?)`,
		"aud_"+id+"_created", id, UserDirector, base); err != nil {
		return err
	}
	return nil
}

// seedMatches writes 6 matches covering scheduled/assigned/in_progress/completed/reopened
// plus one corrected match with two match_results versions.
func seedMatches(ctx context.Context, ex Execer, tid string, withInProgress bool) error {
	completed3 := "completed"
	if withInProgress {
		completed3 = "in_progress"
	}
	// (localSlot, state)
	specs := []struct {
		slot  int
		state string
	}{
		{0, "scheduled"},
		{1, "assigned"},
		{2, completed3},
		{3, "completed"},
		{4, "reopened"},
		{5, "completed"}, // the corrected match
	}
	for _, s := range specs {
		mid := fmt.Sprintf("m_%s_%d", tid, s.slot)
		// Pair entrants within the 8 seeded (wrap so slots 4/5 reuse earlier entrants).
		ea := fmt.Sprintf("e_%s_%d", tid, (s.slot*2)%8+1)
		eb := fmt.Sprintf("e_%s_%d", tid, (s.slot*2+1)%8+1)
		var scorer, started, completed interface{}
		if s.state == "assigned" || s.state == "in_progress" || s.state == "completed" || s.state == "reopened" {
			scorer = UserScorer1
		}
		if s.state == "in_progress" || s.state == "completed" || s.state == "reopened" {
			started = base
		}
		if s.state == "completed" || s.state == "reopened" {
			completed = base
		}
		if err := exec(ctx, ex,
			`INSERT OR IGNORE INTO matches (id,tournament_id,division_id,bracket_round,slot,entrant_a_id,entrant_b_id,state,assigned_scorekeeper_user_id,started_at,completed_at,version,created_at,updated_at)
			 VALUES (?,?,?,1,?,?,?,?,?,?,?,1,?,?)`,
			mid, tid, "d_"+tid, s.slot, ea, eb, s.state, scorer, started, completed, base, base); err != nil {
			return err
		}
	}
	// Corrected match: m_<tid>_5 has two result versions (v1 superseded by v2).
	// Slot 5 pairs entrants 3 & 4 (see wrap above).
	corrected := fmt.Sprintf("m_%s_5", tid)
	ea := fmt.Sprintf("e_%s_3", tid)
	eb := fmt.Sprintf("e_%s_4", tid)
	if err := exec(ctx, ex,
		`INSERT OR IGNORE INTO match_results (id,match_id,result_version,winner_entrant_id,loser_entrant_id,payload_json,submitted_by,submitted_at,superseded_by)
		 VALUES (?,?,1,?,?, '{"score":"75-40"}', ?, ?, ?)`,
		"mr_"+corrected+"_1", corrected, ea, eb, UserScorer1, base, "mr_"+corrected+"_2"); err != nil {
		return err
	}
	if err := exec(ctx, ex,
		`INSERT OR IGNORE INTO match_results (id,match_id,result_version,winner_entrant_id,loser_entrant_id,payload_json,submitted_by,submitted_at,superseded_by)
		 VALUES (?,?,2,?,?, '{"score":"75-55","corrected":true}', ?, ?, NULL)`,
		"mr_"+corrected+"_2", corrected, eb, ea, UserDirector, base); err != nil {
		return err
	}
	return nil
}

// seedChallonge writes the three mapping fixtures: fully mapped (done),
// partially mapped (live), and a failed/dead-lettered sync (open).
func seedChallonge(ctx context.Context, ex Execer) error {
	// Fully mapped + synced.
	if err := exec(ctx, ex,
		`INSERT OR IGNORE INTO challonge_tournaments (tournament_id,provider_tournament_id,provider_url,sync_state,last_synced_at,created_at,updated_at)
		 VALUES (?, 'prov_done_1', 'https://challonge.com/winterdone', 'synced', ?, ?, ?)`,
		TournamentDone, base, base, base); err != nil {
		return err
	}
	for i := 1; i <= 8; i++ {
		if err := exec(ctx, ex,
			`INSERT OR IGNORE INTO challonge_participant_map (tournament_id,entrant_id,provider_participant_id) VALUES (?,?,?)`,
			TournamentDone, fmt.Sprintf("e_%s_%d", TournamentDone, i), fmt.Sprintf("pp_done_%d", i)); err != nil {
			return err
		}
	}
	// Partially mapped (only 4 of 8 participants mapped → reconcile has work to do).
	if err := exec(ctx, ex,
		`INSERT OR IGNORE INTO challonge_tournaments (tournament_id,provider_tournament_id,provider_url,sync_state,last_synced_at,created_at,updated_at)
		 VALUES (?, 'prov_live_1', 'https://challonge.com/summerlive', 'synced', ?, ?, ?)`,
		TournamentLive, base, base, base); err != nil {
		return err
	}
	for i := 1; i <= 4; i++ {
		if err := exec(ctx, ex,
			`INSERT OR IGNORE INTO challonge_participant_map (tournament_id,entrant_id,provider_participant_id) VALUES (?,?,?)`,
			TournamentLive, fmt.Sprintf("e_%s_%d", TournamentLive, i), fmt.Sprintf("pp_live_%d", i)); err != nil {
			return err
		}
	}
	// Failed sync record with retry metadata (dead-lettered outbox job).
	if err := exec(ctx, ex,
		`INSERT OR IGNORE INTO challonge_tournaments (tournament_id,sync_state,last_error,created_at,updated_at)
		 VALUES (?, 'failed', 'challonge 422: invalid url', ?, ?)`,
		TournamentOpen, base, base); err != nil {
		return err
	}
	if err := exec(ctx, ex,
		`INSERT OR IGNORE INTO outbox_jobs (id,kind,aggregate_type,aggregate_id,status,attempts,next_attempt_at,last_error,idempotency_key,created_at,updated_at)
		 VALUES ('job_seed_open', 'challonge.sync', 'tournament', ?, 'dead_lettered', 8, 0, 'challonge 422: invalid url', 'seed-open-1', ?, ?)`,
		TournamentOpen, base, base); err != nil {
		return err
	}
	return nil
}

func exec(ctx context.Context, ex Execer, q string, args ...interface{}) error {
	_, err := ex.ExecContext(ctx, q, args...)
	return err
}
