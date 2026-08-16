package auth

import (
	"context"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kevinelong/kball-scoresheet/server/internal/config"
	"github.com/kevinelong/kball-scoresheet/server/internal/store"
)

type captureMailer struct{ links []string }

func (c *captureMailer) SendMagicLink(_ context.Context, _, link string) error {
	c.links = append(c.links, link)
	return nil
}

func newTestAuth(t *testing.T, allowed ...string) (*Auth, *captureMailer) {
	t.Helper()
	dir := t.TempDir()
	st, err := store.Open(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatalf("store open: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	cfg := config.Load()
	cfg.AllowedEmails = allowed
	cfg.BaseURL = "https://codeonline.io/kball"
	m := &captureMailer{}
	return New(st.DB, cfg, m), m
}

func parseST(t *testing.T, link string) (string, string) {
	t.Helper()
	u, err := url.Parse(link)
	if err != nil {
		t.Fatalf("parse link: %v", err)
	}
	q := u.Query()
	s, tok := q.Get("s"), q.Get("t")
	if s == "" || tok == "" {
		t.Fatalf("link missing s/t: %s", link)
	}
	return s, tok
}

func TestMagicLinkHappyPath(t *testing.T) {
	ctx := context.Background()
	a, m := newTestAuth(t, "player@example.com")
	a.SendLinkIfAllowed(ctx, "Player@Example.com ", "1.2.3.4") // mixed case + space
	if len(m.links) != 1 {
		t.Fatalf("want 1 link, got %d", len(m.links))
	}
	s, tok := parseST(t, m.links[0])

	uid, err := a.ConsumeMagicLink(ctx, s, tok)
	if err != nil {
		t.Fatalf("consume: %v", err)
	}
	// single-use: a second consume must fail
	if _, err := a.ConsumeMagicLink(ctx, s, tok); err != ErrInvalidLink {
		t.Fatalf("replay should fail with ErrInvalidLink, got %v", err)
	}

	// session lifecycle
	raw, err := a.CreateSession(ctx, uid, "", "")
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	got, err := a.LookupSession(ctx, raw)
	if err != nil || got != uid {
		t.Fatalf("lookup session: uid=%q err=%v", got, err)
	}
	if err := a.RevokeSession(ctx, raw); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	if _, err := a.LookupSession(ctx, raw); err != ErrInvalidLink {
		t.Fatalf("revoked session should not resolve, got %v", err)
	}
}

func TestWrongTokenRejected(t *testing.T) {
	ctx := context.Background()
	a, m := newTestAuth(t, "player@example.com")
	a.SendLinkIfAllowed(ctx, "player@example.com", "1.2.3.4")
	s, _ := parseST(t, m.links[0])
	if _, err := a.ConsumeMagicLink(ctx, s, "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"); err != ErrInvalidLink {
		t.Fatalf("wrong token should be ErrInvalidLink, got %v", err)
	}
}

func TestAllowlistBlocksUnlisted(t *testing.T) {
	ctx := context.Background()
	a, m := newTestAuth(t, "player@example.com")
	a.SendLinkIfAllowed(ctx, "stranger@example.com", "1.2.3.4")
	if len(m.links) != 0 {
		t.Fatalf("non-allowlisted email must not receive a link, got %d", len(m.links))
	}
}

func TestRequestLinkRateLimitPerEmailHour(t *testing.T) {
	ctx := context.Background()
	a, m := newTestAuth(t, "player@example.com")
	for i := 0; i < 5; i++ {
		a.SendLinkIfAllowed(ctx, "player@example.com", "1.2.3.4")
	}
	// limit is 3/email/hour
	if len(m.links) != 3 {
		t.Fatalf("want 3 links (hourly cap), got %d", len(m.links))
	}
}

func TestEmptyAllowlistIsOpen(t *testing.T) {
	ctx := context.Background()
	a, m := newTestAuth(t) // no allowlist => open
	a.SendLinkIfAllowed(ctx, "anyone@example.com", "9.9.9.9")
	if len(m.links) != 1 {
		t.Fatalf("open sign-up should send a link, got %d", len(m.links))
	}
}

// guard: ensure the base64 token in the link round-trips without url-unsafe chars
func TestLinkTokensURLSafe(t *testing.T) {
	ctx := context.Background()
	a, m := newTestAuth(t)
	a.SendLinkIfAllowed(ctx, "x@example.com", "1.1.1.1")
	s, tok := parseST(t, m.links[0])
	if strings.ContainsAny(s+tok, "+/=") {
		t.Fatalf("tokens must be url-safe base64: s=%q t=%q", s, tok)
	}
	_ = os.Stdout
}
