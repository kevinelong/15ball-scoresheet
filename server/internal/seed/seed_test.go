package seed

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/kevinelong/15ball-scoresheet/server/internal/store"
)

// TestSeedIdempotent verifies the fixtures load and that a second Seed is a no-op
// (deterministic IDs + INSERT OR IGNORE) — fixture invariant from 10-fixtures.
func TestSeedIdempotent(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "s.db"))
	if err != nil {
		t.Fatalf("store: %v", err)
	}
	defer st.Close()
	ctx := context.Background()

	if err := Seed(ctx, st.DB); err != nil {
		t.Fatalf("seed 1: %v", err)
	}
	count := func(table string) int {
		var n int
		if err := st.DB.QueryRow("SELECT COUNT(*) FROM " + table).Scan(&n); err != nil {
			t.Fatalf("count %s: %v", table, err)
		}
		return n
	}
	before := map[string]int{
		"users": count("users"), "user_roles": count("user_roles"),
		"tournaments": count("tournaments"), "entrants": count("entrants"),
		"matches": count("matches"), "match_results": count("match_results"),
		"challonge_tournaments": count("challonge_tournaments"),
		"challonge_participant_map": count("challonge_participant_map"),
		"outbox_jobs": count("outbox_jobs"),
	}

	// Re-seed: every count must be unchanged.
	if err := Seed(ctx, st.DB); err != nil {
		t.Fatalf("seed 2: %v", err)
	}
	for table, n := range before {
		if got := count(table); got != n {
			t.Errorf("re-seed changed %s: %d -> %d (want idempotent)", table, n, got)
		}
	}

	// Spot-check the fixture invariants that acceptance scenarios rely on.
	if before["users"] != 7 {
		t.Errorf("want 7 seed users, got %d", before["users"])
	}
	if before["tournaments"] != 4 {
		t.Errorf("want 4 tournaments, got %d", before["tournaments"])
	}
	if before["entrants"] != 32 { // 4 tournaments * 8
		t.Errorf("want 32 entrants, got %d", before["entrants"])
	}
	// live + done each have 6 matches.
	if before["matches"] != 12 {
		t.Errorf("want 12 matches, got %d", before["matches"])
	}
	// Corrected matches: 2 result versions each on live + done.
	if before["match_results"] != 4 {
		t.Errorf("want 4 match_results, got %d", before["match_results"])
	}

	// The dead-lettered outbox job (failure-path fixture) must be present.
	var status string
	var attempts int
	if err := st.DB.QueryRow(`SELECT status, attempts FROM outbox_jobs WHERE id='job_seed_open'`).Scan(&status, &attempts); err != nil {
		t.Fatalf("failed-sync fixture missing: %v", err)
	}
	if status != "dead_lettered" || attempts == 0 {
		t.Errorf("failed-sync fixture: status=%s attempts=%d (want dead_lettered w/ retries)", status, attempts)
	}

	// Pending user carries the pending flag.
	var pending int
	if err := st.DB.QueryRow(`SELECT pending_role FROM users WHERE id=?`, UserPending).Scan(&pending); err != nil {
		t.Fatalf("pending user: %v", err)
	}
	if pending != 1 {
		t.Errorf("pending user pending_role=%d, want 1", pending)
	}
}
