package api

import (
	"testing"
)

// TestListMatchesWinnerEntrantID scores W1M1 in a 4-player double-elim and
// asserts that a subsequent GET of the match list reports winnerEntrantId equal
// to the scored winner, and that unfinished matches report a nil winner.
func TestListMatchesWinnerEntrantID(t *testing.T) {
	e := newTestEnv(t)
	tid := e.startDoubleElim(t, 4)

	// Find W1M1 and score entrant A as the winner.
	var mid, a, b string
	for _, m := range e.matches(t, tid) {
		if str(m["matchLabel"]) == "W1M1" {
			mid = m["id"].(string)
			a, _ = m["entrantAId"].(string)
			b, _ = m["entrantBId"].(string)
			break
		}
	}
	if mid == "" || a == "" || b == "" {
		t.Fatalf("W1M1 not found or missing entrants (mid=%q a=%q b=%q)", mid, a, b)
	}
	e.playMatch(t, tid, mid, a, b)

	// Re-fetch via GET and assert the winner is attached to the completed match
	// while another (unfinished) match reports no winner.
	sawScored, sawUnfinished := false, false
	for _, m := range e.matches(t, tid) {
		if m["id"].(string) == mid {
			if got, _ := m["winnerEntrantId"].(string); got != a {
				t.Fatalf("W1M1 winnerEntrantId: want %q, got %v", a, m["winnerEntrantId"])
			}
			sawScored = true
			continue
		}
		if m["winnerEntrantId"] == nil {
			sawUnfinished = true
		}
	}
	if !sawScored {
		t.Fatalf("scored match %s not present in list", mid)
	}
	if !sawUnfinished {
		t.Fatalf("expected at least one unfinished match with nil winnerEntrantId")
	}
}
