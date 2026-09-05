package notify

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// sendErr carries retry classification through the worker.
type sendErr struct {
	msg       string
	retryable bool
}

func (e *sendErr) Error() string   { return e.msg }
func (e *sendErr) Retryable() bool { return e.retryable }

// ---- Twilio sender ---------------------------------------------------------

// TwilioSender posts to the Twilio Messages API using HTTP Basic auth
// (AccountSID:AuthToken). 429/5xx are retried; 4xx (bad number, unsubscribed,
// insufficient funds) are permanent.
type TwilioSender struct {
	AccountSID string
	AuthToken  string
	From       string
	APIBase    string // e.g. https://api.twilio.com
	HTTP       *http.Client
}

func NewTwilio(sid, token, from, apiBase string) *TwilioSender {
	if apiBase == "" {
		apiBase = "https://api.twilio.com"
	}
	return &TwilioSender{
		AccountSID: sid, AuthToken: token, From: from, APIBase: strings.TrimRight(apiBase, "/"),
		HTTP: &http.Client{Timeout: 15 * time.Second},
	}
}

func (s *TwilioSender) Send(ctx context.Context, to, body string) (string, error) {
	form := url.Values{}
	form.Set("To", to)
	form.Set("From", s.From)
	form.Set("Body", body)
	endpoint := fmt.Sprintf("%s/2010-04-01/Accounts/%s/Messages.json", s.APIBase, s.AccountSID)
	req, err := http.NewRequestWithContext(ctx, "POST", endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return "", &sendErr{err.Error(), false}
	}
	req.SetBasicAuth(s.AccountSID, s.AuthToken)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := s.HTTP.Do(req)
	if err != nil {
		return "", &sendErr{err.Error(), true} // network error → retry
	}
	defer resp.Body.Close()
	var out struct {
		SID          string `json:"sid"`
		Message      string `json:"message"`
		Code         int    `json:"code"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&out)
	switch {
	case resp.StatusCode >= 200 && resp.StatusCode < 300:
		return out.SID, nil
	case resp.StatusCode == 429 || resp.StatusCode >= 500:
		return "", &sendErr{fmt.Sprintf("twilio transient %d: %s", resp.StatusCode, out.Message), true}
	default:
		return "", &sendErr{fmt.Sprintf("twilio %d (code %d): %s", resp.StatusCode, out.Code, out.Message), false}
	}
}

// ---- Fake sender (tests) ---------------------------------------------------

type Sent struct{ To, Body string }

type FakeSender struct {
	mu        sync.Mutex
	seq       int
	FailUntil int  // fail this many sends (transient) before succeeding
	FailFatal bool // if true, fail non-retryably
	Messages  []Sent
}

func (f *FakeSender) Send(_ context.Context, to, body string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.FailUntil > 0 {
		f.FailUntil--
		return "", &sendErr{"fake transient", true}
	}
	if f.FailFatal {
		return "", &sendErr{"fake fatal", false}
	}
	f.seq++
	f.Messages = append(f.Messages, Sent{To: to, Body: body})
	return fmt.Sprintf("SM_fake_%d", f.seq), nil
}
