// Package config loads server configuration from the environment. The only
// secret source in production is /etc/kball/kball.env (root:root, 0600), loaded
// by the OpenRC init before dropping privileges (reconciliation #12).
package config

import (
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	ListenAddr   string // LISTEN_ADDR, default 127.0.0.1:8093 (loopback, behind nginx)
	DatabasePath string // DATABASE_PATH, default /var/lib/kball/data.db
	BaseURL      string // BASE_URL, public origin+path, e.g. https://codeonline.io/kball

	MagicLinkTTL time.Duration // MAGIC_LINK_TTL_MINUTES, default 15m
	SessionTTL   time.Duration // SESSION_TTL_DAYS, default 30d

	AllowedEmails []string // ALLOWED_EMAILS, comma-separated; empty = open sign-up

	// Email (SMTP required; Postmark optional behind the same Mailer interface).
	EmailTransport string // EMAIL_TRANSPORT, default "smtp"
	SMTPHost       string
	SMTPPort       int
	SMTPUsername   string
	SMTPPassword   string
	EmailFrom      string
	PostmarkToken  string

	// Challonge Connect (OAuth2 client-credentials; shared club app).
	ChallongeClientID     string
	ChallongeClientSecret string
	ChallongeTokenURL     string
	ChallongeAPIBase      string
	ChallongeScope        string
	ChallongeSubdomain    string
}

func getenv(key, def string) string {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		return v
	}
	return def
}

func atoi(key string, def int) int {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

// Load reads config from the process environment, applying safe defaults.
func Load() *Config {
	emails := []string{}
	for _, e := range strings.Split(getenv("ALLOWED_EMAILS", ""), ",") {
		if s := strings.ToLower(strings.TrimSpace(e)); s != "" {
			emails = append(emails, s)
		}
	}
	return &Config{
		ListenAddr:         getenv("LISTEN_ADDR", "127.0.0.1:8093"),
		DatabasePath:       getenv("DATABASE_PATH", "/var/lib/kball/data.db"),
		BaseURL:            strings.TrimRight(getenv("BASE_URL", "https://codeonline.io/kball"), "/"),
		MagicLinkTTL:       time.Duration(atoi("MAGIC_LINK_TTL_MINUTES", 15)) * time.Minute,
		SessionTTL:         time.Duration(atoi("SESSION_TTL_DAYS", 30)) * 24 * time.Hour,
		AllowedEmails:      emails,
		EmailTransport:     getenv("EMAIL_TRANSPORT", "smtp"),
		SMTPHost:           getenv("SMTP_HOST", ""),
		SMTPPort:           atoi("SMTP_PORT", 587),
		SMTPUsername:       getenv("SMTP_USERNAME", ""),
		SMTPPassword:       getenv("SMTP_PASSWORD", ""),
		EmailFrom:          getenv("SMTP_FROM", getenv("EMAIL_FROM", "")),
		PostmarkToken:      getenv("POSTMARK_TOKEN", ""),
		ChallongeClientID:     getenv("CHALLONGE_CLIENT_ID", ""),
		ChallongeClientSecret: getenv("CHALLONGE_CLIENT_SECRET", ""),
		ChallongeTokenURL:     getenv("CHALLONGE_TOKEN_URL", "https://api.challonge.com/oauth/token"),
		ChallongeAPIBase:      strings.TrimRight(getenv("CHALLONGE_API_BASE", "https://api.challonge.com/v2"), "/"),
		ChallongeScope:        getenv("CHALLONGE_SCOPE", "me application:manage tournaments:read tournaments:write matches:read matches:write participants:read participants:write"),
		ChallongeSubdomain:    getenv("CHALLONGE_SUBDOMAIN", ""),
	}
}

// EmailAllowed reports whether an address may sign in. Empty allowlist = open.
func (c *Config) EmailAllowed(email string) bool {
	if len(c.AllowedEmails) == 0 {
		return true
	}
	e := strings.ToLower(strings.TrimSpace(email))
	for _, a := range c.AllowedEmails {
		if a == e {
			return true
		}
	}
	return false
}
