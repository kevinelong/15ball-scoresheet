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

// TwilioSender posts to the Twilio Messages API using HTTP Basic auth. The URL is
// always scoped to the Account SID; the Basic-auth credentials are either the
// Account SID + Auth Token, or an API Key SID + Secret (preferred, revocable).
// 429/5xx are retried; 4xx (bad number, unsubscribed, insufficient funds) are permanent.
type TwilioSender struct {
	AccountSID string // used in the request URL
	AuthUser   string // Basic-auth username: Account SID or API Key SID
	AuthPass   string // Basic-auth password: Auth Token or API Key Secret
	From       string
	// MessagingServiceSID (MG…), when set, is sent instead of From — the A2P 10DLC
	// path (Twilio picks the number from the service's pool / campaign).
	MessagingServiceSID string
	APIBase             string // e.g. https://api.twilio.com
	HTTP                *http.Client
}

func newTwilioSender(accountSID, user, pass, from, apiBase string) *TwilioSender {
	if apiBase == "" {
		apiBase = "https://api.twilio.com"
	}
	return &TwilioSender{
		AccountSID: accountSID, AuthUser: user, AuthPass: pass, From: from,
		APIBase: strings.TrimRight(apiBase, "/"),
		HTTP:    &http.Client{Timeout: 15 * time.Second},
	}
}

// NewTwilio authenticates with the Account SID + Auth Token.
func NewTwilio(accountSID, authToken, from, apiBase string) *TwilioSender {
	return newTwilioSender(accountSID, accountSID, authToken, from, apiBase)
}

// NewTwilioAPIKey authenticates with an API Key SID + Secret (URL still scoped to
// the Account SID). Preferred over the long-lived Auth Token.
func NewTwilioAPIKey(accountSID, keySID, keySecret, from, apiBase string) *TwilioSender {
	return newTwilioSender(accountSID, keySID, keySecret, from, apiBase)
}

func (s *TwilioSender) Send(ctx context.Context, to, body string) (string, error) {
	form := url.Values{}
	form.Set("To", to)
	if s.MessagingServiceSID != "" {
		form.Set("MessagingServiceSid", s.MessagingServiceSID)
	} else {
		form.Set("From", s.From)
	}
	form.Set("Body", body)
	endpoint := fmt.Sprintf("%s/2010-04-01/Accounts/%s/Messages.json", s.APIBase, s.AccountSID)
	req, err := http.NewRequestWithContext(ctx, "POST", endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return "", &sendErr{err.Error(), false}
	}
	req.SetBasicAuth(s.AuthUser, s.AuthPass)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := s.HTTP.Do(req)
	if err != nil {
		return "", &sendErr{err.Error(), true} // network error → retry
	}
	defer resp.Body.Close()
	var out struct {
		SID     string `json:"sid"`
		Message string `json:"message"`
		Code    int    `json:"code"`
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
