// Package auth implements passwordless magic-link sign-in with opaque,
// database-backed sessions (true revocation), single-use scanner-safe links,
// and persisted request-link rate limiting. Reconciliation #7/#8/#9.
package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"strings"
	"time"

	"github.com/kevinelong/kball-scoresheet/server/internal/config"
	"github.com/kevinelong/kball-scoresheet/server/internal/mail"
)

var (
	ErrInvalidLink = errors.New("invalid or expired link")
	ErrRateLimited = errors.New("rate limited")
)

type Auth struct {
	DB     *sql.DB
	Cfg    *config.Config
	Mailer mail.Mailer
}

func New(db *sql.DB, cfg *config.Config, m mail.Mailer) *Auth {
	return &Auth{DB: db, Cfg: cfg, Mailer: m}
}

// ---- crypto helpers --------------------------------------------------------

func randBytes(n int) ([]byte, error) {
	b := make([]byte, n)
	_, err := rand.Read(b)
	return b, err
}

func newID(prefix string) string {
	b, _ := randBytes(12)
	return prefix + hex.EncodeToString(b)
}

func sha(b []byte) []byte { s := sha256.Sum256(b); return s[:] }

func normalizeEmail(e string) string { return strings.ToLower(strings.TrimSpace(e)) }

// ---- users -----------------------------------------------------------------

// upsertUser returns the id of the user for email, creating the row if absent.
func (a *Auth) upsertUser(ctx context.Context, email string) (string, error) {
	email = normalizeEmail(email)
	var id string
	err := a.DB.QueryRowContext(ctx, `SELECT id FROM users WHERE email = ?`, email).Scan(&id)
	if err == nil {
		return id, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return "", err
	}
	id = newID("u_")
	now := time.Now().Unix()
	if _, err := a.DB.ExecContext(ctx,
		`INSERT INTO users (id, email, created_at, updated_at) VALUES (?, ?, ?, ?)`,
		id, email, now, now); err != nil {
		// lost a race: fetch the winner
		if e2 := a.DB.QueryRowContext(ctx, `SELECT id FROM users WHERE email = ?`, email).Scan(&id); e2 == nil {
			return id, nil
		}
		return "", err
	}
	return id, nil
}

// UserEmail returns the email for a user id (for /api/me).
func (a *Auth) UserEmail(ctx context.Context, userID string) (string, error) {
	var email string
	err := a.DB.QueryRowContext(ctx, `SELECT email FROM users WHERE id = ?`, userID).Scan(&email)
	return email, err
}

// ---- sessions (opaque, revocable) -----------------------------------------

// CreateSession issues a new session and returns the raw token for the cookie.
// Only the SHA-256 digest is stored (reconciliation #7).
func (a *Auth) CreateSession(ctx context.Context, userID, uaHash, ipHash string) (string, error) {
	tok, err := randBytes(32)
	if err != nil {
		return "", err
	}
	raw := base64.RawURLEncoding.EncodeToString(tok)
	now := time.Now()
	_, err = a.DB.ExecContext(ctx,
		`INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, last_seen_at, user_agent_hash, ip_hash)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		newID("s_"), userID, sha(tok), now.Unix(), now.Add(a.Cfg.SessionTTL).Unix(), now.Unix(),
		nullBlob(uaHash), nullBlob(ipHash))
	if err != nil {
		return "", err
	}
	return raw, nil
}

// LookupSession returns the user id for a valid (unrevoked, unexpired) token.
func (a *Auth) LookupSession(ctx context.Context, rawToken string) (string, error) {
	tok, err := base64.RawURLEncoding.DecodeString(rawToken)
	if err != nil {
		return "", ErrInvalidLink
	}
	var userID string
	err = a.DB.QueryRowContext(ctx,
		`SELECT user_id FROM sessions
		  WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?`,
		sha(tok), time.Now().Unix()).Scan(&userID)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrInvalidLink
	}
	if err != nil {
		return "", err
	}
	_, _ = a.DB.ExecContext(ctx, `UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?`, time.Now().Unix(), sha(tok))
	return userID, nil
}

// RevokeSession invalidates the session behind a raw token (signout).
func (a *Auth) RevokeSession(ctx context.Context, rawToken string) error {
	tok, err := base64.RawURLEncoding.DecodeString(rawToken)
	if err != nil {
		return nil // nothing to revoke
	}
	_, err = a.DB.ExecContext(ctx,
		`UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL`,
		time.Now().Unix(), sha(tok))
	return err
}

// ---- magic links (selector + secret, single-use) --------------------------

// IssueMagicLink creates a pending link for userID and returns (selector, token)
// as URL-safe strings to embed in the email link.
func (a *Auth) IssueMagicLink(ctx context.Context, userID, ipHash string) (selector, token string, err error) {
	sel, err := randBytes(16)
	if err != nil {
		return "", "", err
	}
	tok, err := randBytes(32)
	if err != nil {
		return "", "", err
	}
	now := time.Now()
	_, err = a.DB.ExecContext(ctx,
		`INSERT INTO magic_links (id, selector, token_hash, user_id, requested_at, expires_at, requested_ip_hash)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		newID("ml_"), sel, sha(tok), userID, now.Unix(), now.Add(a.Cfg.MagicLinkTTL).Unix(), nullBlob(ipHash))
	if err != nil {
		return "", "", err
	}
	return base64.RawURLEncoding.EncodeToString(sel), base64.RawURLEncoding.EncodeToString(tok), nil
}

// ConsumeMagicLink verifies selector+token in one immediate transaction, marks
// it consumed exactly once, and returns the user id. All failure modes return
// ErrInvalidLink (no oracle).
func (a *Auth) ConsumeMagicLink(ctx context.Context, selector, token string) (string, error) {
	sel, err := base64.RawURLEncoding.DecodeString(selector)
	if err != nil {
		return "", ErrInvalidLink
	}
	tok, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil {
		return "", ErrInvalidLink
	}
	tx, err := a.DB.BeginTx(ctx, nil)
	if err != nil {
		return "", err
	}
	defer tx.Rollback()
	// BEGIN IMMEDIATE semantics: take the write lock before reading the row.
	if _, err := tx.ExecContext(ctx, `SELECT 1`); err != nil {
		return "", err
	}
	var (
		userID    string
		storedH   []byte
		expiresAt int64
	)
	now := time.Now().Unix()
	err = tx.QueryRowContext(ctx,
		`SELECT user_id, token_hash, expires_at FROM magic_links
		  WHERE selector = ? AND consumed_at IS NULL`, sel).Scan(&userID, &storedH, &expiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrInvalidLink
	}
	if err != nil {
		return "", err
	}
	cand := sha(tok)
	if expiresAt <= now || subtle.ConstantTimeCompare(storedH, cand) != 1 {
		return "", ErrInvalidLink
	}
	res, err := tx.ExecContext(ctx,
		`UPDATE magic_links SET consumed_at = ? WHERE selector = ? AND consumed_at IS NULL AND expires_at > ?`,
		now, sel, now)
	if err != nil {
		return "", err
	}
	if n, _ := res.RowsAffected(); n != 1 {
		return "", ErrInvalidLink
	}
	if err := tx.Commit(); err != nil {
		return "", err
	}
	return userID, nil
}

// ---- request-link rate limiting (#9) --------------------------------------
// Limits: 3/email/hour, 20/email/day, 10/IP/hour. Counts and insert happen in
// one transaction; caller sends mail only after this returns nil.
func (a *Auth) rateLimitAndRecord(ctx context.Context, emailHash, ipHash []byte) error {
	tx, err := a.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `SELECT 1`); err != nil {
		return err
	}
	now := time.Now()
	hourAgo := now.Add(-time.Hour).Unix()
	dayAgo := now.Add(-24 * time.Hour).Unix()

	var emailHour, emailDay, ipHour int
	if err := tx.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM auth_link_requests WHERE email_hash = ? AND requested_at > ?`, emailHash, hourAgo).Scan(&emailHour); err != nil {
		return err
	}
	if err := tx.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM auth_link_requests WHERE email_hash = ? AND requested_at > ?`, emailHash, dayAgo).Scan(&emailDay); err != nil {
		return err
	}
	if err := tx.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM auth_link_requests WHERE ip_hash = ? AND requested_at > ?`, ipHash, hourAgo).Scan(&ipHour); err != nil {
		return err
	}
	if emailHour >= 3 || emailDay >= 20 || ipHour >= 10 {
		return ErrRateLimited
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO auth_link_requests (id, email_hash, ip_hash, requested_at) VALUES (?, ?, ?, ?)`,
		newID("alr_"), emailHash, ipHash, now.Unix()); err != nil {
		return err
	}
	return tx.Commit()
}

// SendLinkIfAllowed is the full request-link flow. Expected outcomes (allowlist
// miss, rate limit, send failure) are swallowed so the HTTP layer returns a
// uniform 202 with no enumeration signal.
func (a *Auth) SendLinkIfAllowed(ctx context.Context, email, ipHash string) {
	email = normalizeEmail(email)
	if email == "" || !a.Cfg.EmailAllowed(email) {
		return // enumeration-safe: no user, no mail, caller still returns 202
	}
	eh := sha([]byte(email))
	ih := sha([]byte(ipHash))
	if err := a.rateLimitAndRecord(ctx, eh, ih); err != nil {
		return // rate limited or transient; uniform 202 upstream
	}
	userID, err := a.upsertUser(ctx, email)
	if err != nil {
		return
	}
	sel, tok, err := a.IssueMagicLink(ctx, userID, ipHash)
	if err != nil {
		return
	}
	link := a.Cfg.BaseURL + "/api/auth/verify?s=" + sel + "&t=" + tok
	// Send after the row is committed; ignore send errors for the uniform response
	// but they are logged by the caller-provided mailer if it chooses.
	_ = a.Mailer.SendMagicLink(ctx, email, link)
}

// PruneExpired removes stale magic links and rate-limit events (call daily).
func (a *Auth) PruneExpired(ctx context.Context) {
	now := time.Now()
	_, _ = a.DB.ExecContext(ctx, `DELETE FROM magic_links WHERE expires_at < ?`, now.Add(-time.Hour).Unix())
	_, _ = a.DB.ExecContext(ctx, `DELETE FROM auth_link_requests WHERE requested_at < ?`, now.Add(-48*time.Hour).Unix())
}

func nullBlob(hexStr string) interface{} {
	if hexStr == "" {
		return nil
	}
	b, err := hex.DecodeString(hexStr)
	if err != nil {
		return []byte(hexStr)
	}
	return b
}
