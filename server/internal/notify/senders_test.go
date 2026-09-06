package notify

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

// captures the last request the fake Twilio endpoint received.
func mockTwilio(t *testing.T, status int, respBody string) (*httptest.Server, *http.Request, *string) {
	t.Helper()
	var gotReq *http.Request
	var gotForm string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		gotReq = r
		gotForm = r.PostForm.Encode()
		w.WriteHeader(status)
		_, _ = w.Write([]byte(respBody))
	}))
	t.Cleanup(srv.Close)
	return srv, gotReq, &gotForm
}

func TestSendUsesFromAndBasicAuth(t *testing.T) {
	srv, _, form := mockTwilio(t, 201, `{"sid":"SMok","status":"queued"}`)
	s := NewTwilioAPIKey("ACacct", "SKkey", "secret", "+18887747814", srv.URL)
	id, err := s.Send(context.Background(), "+15033699277", "hi")
	if err != nil || id != "SMok" {
		t.Fatalf("send: id=%q err=%v", id, err)
	}
	if !contains(*form, "From=%2B18887747814") || contains(*form, "MessagingServiceSid") {
		t.Fatalf("expected From param, got form=%s", *form)
	}
}

func TestSendPrefersMessagingService(t *testing.T) {
	srv, _, form := mockTwilio(t, 201, `{"sid":"SMok","status":"queued"}`)
	s := NewTwilioAPIKey("ACacct", "SKkey", "secret", "+18887747814", srv.URL)
	s.MessagingServiceSID = "MGabc123"
	if _, err := s.Send(context.Background(), "+15033699277", "hi"); err != nil {
		t.Fatalf("send: %v", err)
	}
	if !contains(*form, "MessagingServiceSid=MGabc123") {
		t.Fatalf("expected MessagingServiceSid, got form=%s", *form)
	}
	if contains(*form, "From=") {
		t.Fatalf("From should be omitted when MessagingServiceSid is set: %s", *form)
	}
}

func TestSendClassifiesErrors(t *testing.T) {
	// 4xx → permanent (not retryable)
	srv, _, _ := mockTwilio(t, 400, `{"code":21211,"message":"bad number"}`)
	s := NewTwilio("ACacct", "token", "+1800", srv.URL)
	if _, err := s.Send(context.Background(), "+1", "x"); err == nil || isRetryable(err) {
		t.Fatalf("4xx should be permanent, got err=%v retry=%v", err, isRetryable(err))
	}
	// 500 → retryable
	srv2, _, _ := mockTwilio(t, 500, `{"message":"boom"}`)
	s2 := NewTwilio("ACacct", "token", "+1800", srv2.URL)
	if _, err := s2.Send(context.Background(), "+1", "x"); err == nil || !isRetryable(err) {
		t.Fatalf("5xx should be retryable, got err=%v retry=%v", err, isRetryable(err))
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
