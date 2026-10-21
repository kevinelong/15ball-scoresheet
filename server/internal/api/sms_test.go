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
	e.api.SMSReady = func() bool { return true }
	e.api.BaseURL = "https://codeonline.io/15ball"
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
	// Ann's opt-in queues one enrollment confirmation; the table assignment
	// queues her match alert. Both are drained here.
	if len(fake.Messages) != 2 {
		t.Fatalf("want enrollment confirmation + match alert, got %d messages", len(fake.Messages))
	}
	var matchBody string
	var sawConfirm bool
	for _, m := range fake.Messages {
		if strings.Contains(m.Body, "You're enrolled") {
			sawConfirm = true
		}
		if strings.Contains(m.Body, "Your match vs Bob") {
			matchBody = m.Body
			if m.To != "+15550000001" {
				t.Fatalf("match alert sent to %s, want Ann", m.To)
			}
		}
	}
	if !sawConfirm {
		t.Fatalf("missing enrollment confirmation: %+v", fake.Messages)
	}
	// The match alert names the sender, opponent and table, and carries the live link.
	if !strings.Contains(matchBody, "Columbia Cue Club: Your match vs Bob is starting now") ||
		!strings.Contains(matchBody, "table 7") ||
		!strings.Contains(matchBody, "Live: https://codeonline.io/15ball/live.html?t=") ||
		!strings.Contains(matchBody, "&m="+mid) {
		t.Fatalf("unexpected match alert: %q", matchBody)
	}
}

// TestStartMatchSMS: if the match was assigned while SMS was off, starting it (with
// SMS now configured) still texts both opted-in players. The dedupe key means a
// normal assign→start flow does not double-text.
func TestStartMatchSMS(t *testing.T) {
	e := newTestEnv(t)
	e.api.BaseURL = "https://codeonline.io/15ball"
	tid, mid := e.mkStartedTournamentSMS(t, "+15550000011", "+15550000012", true, true)

	e.api.SMSReady = func() bool { return false }
	if code, _ := e.do(t, "POST", "/api/v1/tournaments/"+tid+"/matches/"+mid+"/assign", e.director,
		`{"scorekeeperUserId":"u_scorekeeper@x.com","tableRef":"9"}`); code != http.StatusOK {
		t.Fatalf("assign: want 200, got %d", code)
	}
	var n int
	e.api.DB.QueryRow(`SELECT COUNT(*) FROM notifications WHERE match_id=?`, mid).Scan(&n)
	if n != 0 {
		t.Fatalf("SMS off at assign: want 0 notifications, got %d", n)
	}

	e.api.SMSReady = func() bool { return true }
	if code, _ := e.do(t, "POST", "/api/v1/tournaments/"+tid+"/matches/"+mid+"/start", e.director, ""); code != http.StatusOK {
		t.Fatalf("start: want 200, got %d", code)
	}
	e.api.DB.QueryRow(`SELECT COUNT(*) FROM notifications WHERE match_id=?`, mid).Scan(&n)
	if n != 2 {
		t.Fatalf("start with SMS on: want 2 pending, got %d", n)
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

func TestEnrollmentConfirmationOnCreate(t *testing.T) {
	e := newTestEnv(t)
	e.api.SMSReady = func() bool { return true }
	tid := e.mkOpenTournament(t)

	code, resp := e.do(t, "POST", "/api/v1/tournaments/"+tid+"/entrants", e.director,
		`{"displayName":"Ann","phone":"+15550000001","notifyOptIn":true}`)
	if code != http.StatusCreated {
		t.Fatalf("create entrant: want 201, got %d", code)
	}
	eid := resp["entrant"].(map[string]interface{})["id"].(string)

	var pending int
	e.api.DB.QueryRow(`SELECT COUNT(*) FROM notifications WHERE entrant_id=? AND match_id IS NULL AND status='pending'`, eid).Scan(&pending)
	if pending != 1 {
		t.Fatalf("want 1 pending enrollment confirmation, got %d", pending)
	}

	fake := &notify.FakeSender{}
	wk := &notify.Worker{DB: e.api.DB, Sender: fake}
	for wk.ProcessOne(context.Background()) {
	}
	if len(fake.Messages) != 1 {
		t.Fatalf("want 1 sent confirmation, got %d", len(fake.Messages))
	}
	want := "Columbia Cue Club Match Alerts: You're enrolled. Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out."
	if fake.Messages[0].To != "+15550000001" || fake.Messages[0].Body != want {
		t.Fatalf("unexpected confirmation: %+v", fake.Messages[0])
	}
}

func TestEnrollmentConfirmationOnOptIn(t *testing.T) {
	e := newTestEnv(t)
	e.api.SMSReady = func() bool { return true }
	tid := e.mkOpenTournament(t)

	_, resp := e.do(t, "POST", "/api/v1/tournaments/"+tid+"/entrants", e.director,
		`{"displayName":"Bob","phone":"+15550000002"}`)
	eid := resp["entrant"].(map[string]interface{})["id"].(string)
	var pending int
	e.api.DB.QueryRow(`SELECT COUNT(*) FROM notifications WHERE entrant_id=?`, eid).Scan(&pending)
	if pending != 0 {
		t.Fatalf("no confirmation before consent, got %d", pending)
	}

	if code, _ := e.do(t, "PATCH", "/api/v1/tournaments/"+tid+"/entrants/"+eid, e.director, `{"notifyOptIn":true}`); code != http.StatusOK {
		t.Fatalf("opt in: want 200, got %d", code)
	}
	e.api.DB.QueryRow(`SELECT COUNT(*) FROM notifications WHERE entrant_id=? AND match_id IS NULL AND status='pending'`, eid).Scan(&pending)
	if pending != 1 {
		t.Fatalf("want 1 pending confirmation after opt-in, got %d", pending)
	}

	fake := &notify.FakeSender{}
	wk := &notify.Worker{DB: e.api.DB, Sender: fake}
	for wk.ProcessOne(context.Background()) {
	}
	if len(fake.Messages) != 1 || !strings.Contains(fake.Messages[0].Body, "You're enrolled") {
		t.Fatalf("unexpected confirmation messages: %+v", fake.Messages)
	}
}
