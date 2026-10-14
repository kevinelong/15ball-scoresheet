package api

import (
	"fmt"
	"net/http"
	"testing"
)

// startSingleElim creates a tournament whose primary division is real single
// elimination, checks in n entrants and starts it (bracket generated on the
// in_progress transition). Returns the tournament id and the entrant ids.
func (e *testEnv) startSingleElim(t *testing.T, n int) (string, []string) {
	t.Helper()
	_, resp := e.do(t, "POST", "/api/v1/tournaments", e.director, `{"name":"Single Elim"}`)
	tid := resp["tournament"].(map[string]interface{})["id"].(string)
	if code, r := e.do(t, "POST", "/api/v1/tournaments/"+tid+"/divisions", e.director,
		`{"name":"Open","format":"single_elimination"}`); code != http.StatusCreated {
		t.Fatalf("single_elimination division: want 201, got %d (%v)", code, r)
	}
	e.do(t, "PATCH", "/api/v1/tournaments/"+tid, e.director, `{"state":"registration_open"}`)
	eids := make([]string, 0, n)
	for i := range n {
		_, r := e.do(t, "POST", "/api/v1/tournaments/"+tid+"/entrants", e.director, fmt.Sprintf(`{"displayName":"P%02d"}`, i))
		eid := r["entrant"].(map[string]interface{})["id"].(string)
		e.do(t, "PATCH", "/api/v1/tournaments/"+tid+"/entrants/"+eid, e.director, `{"state":"registered"}`)
		e.do(t, "POST", "/api/v1/tournaments/"+tid+"/entrants/"+eid+"/check-in", e.director, `{}`)
		eids = append(eids, eid)
	}
	e.do(t, "PATCH", "/api/v1/tournaments/"+tid, e.director, `{"state":"registration_closed"}`)
	if code, r := e.do(t, "PATCH", "/api/v1/tournaments/"+tid, e.director, `{"state":"in_progress"}`); code != http.StatusOK {
		t.Fatalf("start: want 200, got %d (%v)", code, r)
	}
	return tid, eids
}

// TestSingleElimStructure6 pins the shape of a 6-player single-elimination field:
// a size-8 bracket (W1: 4, W2: 2, W3: 1 = 7 matches) with 2 byes auto-resolved at
// generation, no losers-bracket/grand-final match, and winner edges into the next
// round (which is how resolveByes advances a bye).
func TestSingleElimStructure6(t *testing.T) {
	e := newTestEnv(t)
	tid, _ := e.startSingleElim(t, 6)

	ms := e.matches(t, tid)
	byLabel := map[string]map[string]interface{}{}
	byRound := map[int]int{}
	completed := 0
	for _, m := range ms {
		lbl := str(m["matchLabel"])
		byLabel[lbl] = m
		byRound[int(m["bracketRound"].(float64))]++
		if m["state"] == "completed" {
			completed++
		}
		if m["bracket"] != nil {
			t.Errorf("match %s: bracket = %v, want null (single elimination)", lbl, m["bracket"])
		}
	}
	for _, want := range []string{"W1M1", "W1M2", "W1M3", "W1M4", "W2M1", "W2M2", "W3M1"} {
		if byLabel[want] == nil {
			t.Errorf("missing match %s (got %v)", want, byLabel)
		}
	}
	if len(byLabel) != 7 {
		t.Fatalf("want 7 matches for a 6-player field, got %d (%v)", len(byLabel), byLabel)
	}
	if byRound[1] != 4 || byRound[2] != 2 || byRound[3] != 1 {
		t.Errorf("round shape: want {1:4, 2:2, 3:1}, got %v", byRound)
	}
	if completed != 2 {
		t.Errorf("want 2 byes auto-resolved at generation, got %d completed matches", completed)
	}

	// W1M1 holds seed 1 against the BYE (seedOrder(8)[1] = 8), so it is resolved at
	// generation and its winner must already sit in W2M1 slot a — the edge that
	// resolveByes follows, and the same edge the frontend renders from.
	w1m1, w2m1 := byLabel["W1M1"], byLabel["W2M1"]
	if w1m1 == nil || w2m1 == nil {
		t.Fatal("W1M1/W2M1 missing")
	}
	if got := str(w1m1["feedsWinnerMatch"]); got != str(w2m1["id"]) {
		t.Errorf("W1M1 winner edge: want W2M1 (%v), got %q", w2m1["id"], got)
	}
	if slot, _ := w1m1["feedsWinnerSlot"].(float64); slot != 0 {
		t.Errorf("W1M1 winner edge slot: want 0, got %v", w1m1["feedsWinnerSlot"])
	}
	if w1m1["state"] != "completed" {
		t.Errorf("W1M1 should be an auto-resolved bye, got state %v", w1m1["state"])
	}
	// Resolve the entrants so the BYE placeholder is identified by name, not by id.
	// The placeholder is archived (as in the double-elim generator), so the default
	// list hides it and contains only the checked-in field.
	_, live := e.do(t, "GET", "/api/v1/tournaments/"+tid+"/entrants", e.director, "")
	if got := len(live["items"].([]interface{})); got != 6 {
		t.Errorf("default entrant list: want the 6 checked-in entrants, got %d", got)
	}
	_, entResp := e.do(t, "GET", "/api/v1/tournaments/"+tid+"/entrants?archived=true", e.director, "")
	names := map[string]string{}
	for _, it := range entResp["items"].([]interface{}) {
		em := it.(map[string]interface{})
		names[em["id"].(string)] = str(em["displayName"])
	}
	if got := names[str(w1m1["entrantAId"])]; got == "" || got == byeName {
		t.Errorf("W1M1 slot a: want a real entrant, got %q", got)
	}
	if got := names[str(w1m1["entrantBId"])]; got != byeName {
		t.Errorf("W1M1 slot b: want the BYE placeholder, got %q", got)
	}
	if got, want := str(w2m1["entrantAId"]), str(w1m1["entrantAId"]); got != want {
		t.Errorf("W2M1 slot a: want the W1M1 bye winner %q, got %q", want, got)
	}
	if got := str(w2m1["feedsWinnerMatch"]); got != str(byLabel["W3M1"]["id"]) {
		t.Errorf("W2M1 winner edge: want W3M1 (%v), got %q", byLabel["W3M1"]["id"], got)
	}
}

// TestSingleElimNoEntrantDropped: a non-power-of-two field used to drop its
// unpaired last entrant (round-1 pairing walked complete pairs only) and never
// size itself to a power of two. Every checked-in entrant must be in a match and
// the tournament must be playable to completion.
func TestSingleElimNoEntrantDropped(t *testing.T) {
	for _, n := range []int{3, 5, 7} {
		t.Run(fmt.Sprintf("n=%d", n), func(t *testing.T) {
			e := newTestEnv(t)
			tid, eids := e.startSingleElim(t, n)

			size := 1
			for size < n {
				size *= 2
			}
			ms := e.matches(t, tid)
			if len(ms) != size-1 {
				t.Fatalf("want %d matches for a size-%d field, got %d", size-1, size, len(ms))
			}
			inMatch := map[string]bool{}
			resolved := 0
			for _, m := range ms {
				for _, k := range []string{"entrantAId", "entrantBId"} {
					if id, ok := m[k].(string); ok && id != "" {
						inMatch[id] = true
					}
				}
				if m["bracket"] != nil {
					t.Errorf("match %v: bracket = %v, want null (single elimination)", m["matchLabel"], m["bracket"])
				}
				if lbl := str(m["matchLabel"]); lbl == "" || lbl[0] != 'W' {
					t.Errorf("unexpected match label %q", lbl)
				}
				if m["state"] == "completed" {
					resolved++
				}
			}
			for _, eid := range eids {
				if !inMatch[eid] {
					t.Errorf("entrant %s has no match (dropped from the field)", eid)
				}
			}
			if want := size - n; resolved != want {
				t.Errorf("want %d auto-resolved byes for n=%d, got %d completed matches", want, n, resolved)
			}

			e.playAll(t, tid, aWins)
			for _, m := range e.matches(t, tid) {
				if m["state"] != "completed" {
					t.Fatalf("match %v not completed: %v", m["matchLabel"], m["state"])
				}
			}
			if code, r := e.do(t, "PATCH", "/api/v1/tournaments/"+tid, e.director, `{"state":"completed"}`); code != http.StatusOK {
				t.Fatalf("complete tournament: want 200, got %d (%v)", code, r)
			}
		})
	}
}
