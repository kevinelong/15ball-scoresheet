package store

import (
	"database/sql"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/kevinelong/15ball-scoresheet/server/migrations"
)

// The repo had no migration test convention before this file (neither `store` nor
// `migrations` had tests; root `migration.test.js` covers the browser key rename), so
// these follow the runner's own rules instead: embedded filenames, filename order, one
// exec per file, tracked in schema_migrations.

func migrationNames(t *testing.T) []string {
	t.Helper()
	entries, err := migrations.FS.ReadDir(".")
	if err != nil {
		t.Fatalf("read migrations: %v", err)
	}
	names := []string{}
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".sql") {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	return names
}

// columnInfo returns (notnull, default expression) for one column.
func columnInfo(t *testing.T, db *sql.DB, table, column string) (bool, string) {
	t.Helper()
	rows, err := db.Query(`SELECT name, "notnull", dflt_value FROM pragma_table_info(?)`, table)
	if err != nil {
		t.Fatalf("pragma table_info(%s): %v", table, err)
	}
	defer rows.Close()
	for rows.Next() {
		var name string
		var notNull int
		var dflt sql.NullString
		if err := rows.Scan(&name, &notNull, &dflt); err != nil {
			t.Fatalf("scan pragma: %v", err)
		}
		if name == column {
			return notNull == 1, dflt.String
		}
	}
	t.Fatalf("column %s.%s not found", table, column)
	return false, ""
}

// TestOpenAppliesMigrations: a fresh store runs every embedded migration and records
// it, and the review flag arrives as a NOT NULL column defaulting to 0.
func TestOpenAppliesMigrations(t *testing.T) {
	st, err := Open(filepath.Join(t.TempDir(), "fresh.db"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer st.Close()

	for _, want := range migrationNames(t) {
		var n int
		if err := st.DB.QueryRow(`SELECT COUNT(*) FROM schema_migrations WHERE name=?`, want).Scan(&n); err != nil {
			t.Fatalf("schema_migrations %s: %v", want, err)
		}
		if n != 1 {
			t.Errorf("migration %s: want 1 recorded row, got %d", want, n)
		}
	}
	notNull, dflt := columnInfo(t, st.DB, "matches", "needs_review")
	if !notNull || dflt != "0" {
		t.Errorf("matches.needs_review: want NOT NULL DEFAULT 0, got notnull=%v default=%q", notNull, dflt)
	}
}

// TestMigration0017IsAdditive drives 0017 against a database that already holds
// matches, which store.Open cannot do (it only ever migrates an empty file): apply the
// migrations up to 0016, populate, then apply 0017. The flag must arrive additively, so
// existing rows read back as 0 and inserts that never mention the column still land.
func TestMigration0017IsAdditive(t *testing.T) {
	dir := t.TempDir()
	db, err := sql.Open("sqlite", filepath.Join(dir, "legacy.db")+"?_pragma=busy_timeout(5000)&_pragma=foreign_keys(ON)")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)

	apply := func(name string) {
		body, err := migrations.FS.ReadFile(name)
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		if _, err := db.Exec(string(body)); err != nil {
			t.Fatalf("apply %s: %v", name, err)
		}
	}
	before := 0
	for _, name := range migrationNames(t) {
		if name >= "0017" {
			break
		}
		apply(name)
		before++
	}
	if before == 0 {
		t.Fatal("no migrations found before 0017")
	}

	// Populate the way the pre-0017 code did: no needs_review column in sight.
	if _, err := db.Exec(`INSERT INTO tournaments (id, slug, name, created_by, created_at, updated_at)
	                      VALUES ('t_legacy','legacy','Legacy Cup','u_test',1,1)`); err != nil {
		t.Fatalf("insert tournament: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO matches (id, tournament_id, bracket_round, slot, state, created_at, updated_at)
	                      VALUES ('mch_legacy','t_legacy',1,0,'completed',1,1)`); err != nil {
		t.Fatalf("insert pre-0017 match: %v", err)
	}

	apply("0017_match_review_flag.sql")

	var legacy int
	if err := db.QueryRow(`SELECT needs_review FROM matches WHERE id='mch_legacy'`).Scan(&legacy); err != nil {
		t.Fatalf("read pre-existing row: %v", err)
	}
	if legacy != 0 {
		t.Errorf("pre-existing match: want needs_review 0, got %d", legacy)
	}
	// The column is optional for writers: the old column list still works.
	if _, err := db.Exec(`INSERT INTO matches (id, tournament_id, bracket_round, slot, state, created_at, updated_at)
	                      VALUES ('mch_new','t_legacy',1,1,'scheduled',1,1)`); err != nil {
		t.Fatalf("insert after 0017 with the old column list: %v", err)
	}
	var fresh int
	if err := db.QueryRow(`SELECT needs_review FROM matches WHERE id='mch_new'`).Scan(&fresh); err != nil {
		t.Fatalf("read new row: %v", err)
	}
	if fresh != 0 {
		t.Errorf("new match: want needs_review 0 from the default, got %d", fresh)
	}
	notNull, dflt := columnInfo(t, db, "matches", "needs_review")
	if !notNull || dflt != "0" {
		t.Errorf("matches.needs_review: want NOT NULL DEFAULT 0, got notnull=%v default=%q", notNull, dflt)
	}
}
