package api

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/kevinelong/15ball-scoresheet/server/internal/notify"
)

// mkStartedTournamentSMS builds a started tournament whose two entrants carry the
// given phone/opt-in, returning the tournament id and its single round-1 match id.
func (e *testEnv) mkStartedTournamentSMS(t *testing.T, aPhone, bPhone string, aOptIn, bOptIn bool) (string, string) {
	t.Helper()
	tid := e.mkOpenTournament(t)
	mk := func(name, phone string, optIn bool) {
		body := `{"displayName":"` + name + `","phone":"` + phone + `","notifyOptIn":` + boolStr(optIn) + `}`
		_, resp := e.do(t, "POST", "/api/v1/tournaments/"+tid+"/entrants", e.director, body)
		eid := resp["entrant"].(map[string]interface{})["id"].(string)
		e.do(t, "PATCH", "/api/v1/tournaments/"+tid+"/entrants/"+eid, e.director, `{"state":"registered"}`)
		e.do(t, "POST", "/api/v1/tournaments/"+tid+"/entrants/"+eid+"/check-in", e.director, `{}`)
	}
	mk("Ann", aPhone, aOptIn)
	mk("Bob", bPhone, bOptIn)
	e.do(t, "PATCH", "/api/v1/tournaments/"+tid, e.director, `{"state":"registration_closed"}`)
	e.do(t, "PATCH", "/api/v1/tournaments/"+tid, e.director, `{"state":"in_progress"}`)
	_, list := e.do(t, "GET", "/api/v1/tournaments/"+tid+"/matches", e.director, "")
	mid := list["items"].([]interface{})[0].(map[string]interface{})["id"].(string)
	return tid, mid
}

func boolStr(b bool) string {
	if b {
		return "true"
	}
	return "false"
}

func TestMatchReadySMS(t *testing.T) {
	e := newTestEnv(t)
	e.api.SMSEnabled = true
	ctx := context.Background()

	// Ann opts in; Bob has a phone but did NOT opt in → only Ann is texted.
	tid, mid := e.mkStartedTournamentSMS(t, "+15550000001", "+15550000002", true, false)

	// assign to a table → match ready → enqueue
	if code, _ := e.do(t, "POST", "/api/v1/tournaments/"+tid+"/matches/"+mid+"/assign", e.director,
		`{"scorekeeperUserId":"u_scorekeeper@x.com","tableRef":"7"}`); code != http.StatusOK {
		t.Fatalf("assign: want 200, got %d", code)
	}

	var pending int
	e.api.DB.QueryRow(`SELECT COUNT(*) FROM notifications WHERE match_id=? AND status='pending'`, mid).Scan(&pending)
	if pending != 1 {
		t.Fatalf("want 1 pending SMS (opt-in only), got %d", pending)
	}

	// re-assign (no table change) must not double-enqueue (dedupe per match+entrant)
	e.do(t, "POST", "/api/v1/tournaments/"+tid+"/matches/"+mid+"/assign", e.director, `{"scorekeeperUserId":"u_scorekeeper@x.com"}`)
	var total int
	e.api.DB.QueryRow(`SELECT COUNT(*) FROM notifications WHERE match_id=?`, mid).Scan(&total)
	if total != 1 {
		t.Fatalf("re-assign must not re-enqueue: got %d rows", total)
	}

	// drain via the worker with a fake sender
	fake := &notify.FakeSender{}
	wk := &notify.Worker{DB: e.api.DB, Sender: fake}
	for wk.ProcessOne(ctx) {
	}
	if len(fake.Messages) != 1 {
		t.Fatalf("want 1 sent message, got %d", len(fake.Messages))
	}
	if fake.Messages[0].To != "+15550000001" || !strings.Contains(fake.Messages[0].Body, "Table 7") {
		t.Fatalf("unexpected message: %+v", fake.Messages[0])
	}
}

func TestMatchReadySMSDisabled(t *testing.T) {
	e := newTestEnv(t) // SMSEnabled defaults to false
	tid, mid := e.mkStartedTournamentSMS(t, "+15550000001", "+15550000002", true, true)
	e.do(t, "POST", "/api/v1/tournaments/"+tid+"/matches/"+mid+"/assign", e.director,
		`{"scorekeeperUserId":"u_scorekeeper@x.com","tableRef":"7"}`)
	var n int
	e.api.DB.QueryRow(`SELECT COUNT(*) FROM notifications WHERE match_id=?`, mid).Scan(&n)
	if n != 0 {
		t.Fatalf("SMS disabled: want 0 notifications, got %d", n)
	}
}
