// Package config loads server configuration from the environment. The only
// secret source in production is /etc/fifteenball/fifteenball.env (0640
// root:fifteenball so the service can hot-read it; see DECISIONS/020), loaded by
// the OpenRC init before dropping privileges (reconciliation #12).
package config

import (
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	ListenAddr   string // LISTEN_ADDR, default 127.0.0.1:8093 (loopback, behind nginx)
	DatabasePath string // DATABASE_PATH, default /var/lib/fifteenball/data.db
	BaseURL      string // BASE_URL, public origin+path, e.g. https://codeonline.io/15ball

	MagicLinkTTL time.Duration // MAGIC_LINK_TTL_MINUTES, default 15m
	SessionTTL   time.Duration // SESSION_TTL_DAYS, default 30d

	AllowedEmails   []string // ALLOWED_EMAILS, comma-separated; empty = open sign-up gate
	BootstrapAdmins []string // BOOTSTRAP_ADMINS; these emails get system_admin (DECISIONS/019 §D3)

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

	// Twilio SMS (match-ready alerts). Requires the Account SID + From number plus
	// EITHER the Auth Token OR an API Key SID+Secret (preferred, revocable).
	TwilioAccountSID   string
	TwilioAuthToken    string
	TwilioAPIKeySID    string
	TwilioAPIKeySecret string
	TwilioFromNumber   string
	// TwilioMessagingServiceSID (MG…) sends via a Messaging Service instead of a
	// bare From number — the reliable path for A2P 10DLC. When set it takes
	// precedence over the From number.
	TwilioMessagingServiceSID string
	TwilioAPIBase             string // override for tests; defaults to the live API

	// EnvFilePath is the on-disk env file the service is booted from. The SMS
	// worker re-reads it at runtime so Twilio creds added to the file take effect
	// without a restart (requires the file be readable by the service user).
	EnvFilePath string

	// OpenMatchEditing (OPEN_MATCH_EDITING): when true, the match board reads and
	// the score actions (assign/start/result/reopen) are reachable WITHOUT a
	// session — anyone with the tournament link can record results. Tournament and
	// entrant setup stays director-gated. Trusted-room convenience; off by default.
	OpenMatchEditing bool
}

// SMSConfigured reports whether Twilio SMS sending is enabled: Account SID, a
// sender (From number or Messaging Service SID), and a credential (Auth Token or
// API Key SID+Secret).
func (c *Config) SMSConfigured() bool {
	if c.TwilioAccountSID == "" {
		return false
	}
	if c.TwilioFromNumber == "" && c.TwilioMessagingServiceSID == "" {
		return false
	}
	return c.TwilioAuthToken != "" || (c.TwilioAPIKeySID != "" && c.TwilioAPIKeySecret != "")
}

func getenv(key, def string) string {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		return v
	}
	return def
}

func truthy(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
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
	parseList := func(v string) []string {
		out := []string{}
		for _, e := range strings.Split(v, ",") {
			if s := strings.ToLower(strings.TrimSpace(e)); s != "" {
				out = append(out, s)
			}
		}
		return out
	}
	emails := parseList(getenv("ALLOWED_EMAILS", ""))
	// Bootstrap admins default to the ALLOWED_EMAILS set for continuity if unset.
	admins := parseList(getenv("BOOTSTRAP_ADMINS", getenv("ALLOWED_EMAILS", "")))
	return &Config{
		BootstrapAdmins:           admins,
		ListenAddr:                getenv("LISTEN_ADDR", "127.0.0.1:8093"),
		DatabasePath:              getenv("DATABASE_PATH", "/var/lib/fifteenball/data.db"),
		BaseURL:                   strings.TrimRight(getenv("BASE_URL", "https://codeonline.io/15ball"), "/"),
		MagicLinkTTL:              time.Duration(atoi("MAGIC_LINK_TTL_MINUTES", 15)) * time.Minute,
		SessionTTL:                time.Duration(atoi("SESSION_TTL_DAYS", 30)) * 24 * time.Hour,
		AllowedEmails:             emails,
		EmailTransport:            getenv("EMAIL_TRANSPORT", "smtp"),
		SMTPHost:                  getenv("SMTP_HOST", ""),
		SMTPPort:                  atoi("SMTP_PORT", 587),
		SMTPUsername:              getenv("SMTP_USERNAME", ""),
		SMTPPassword:              getenv("SMTP_PASSWORD", ""),
		EmailFrom:                 getenv("SMTP_FROM", getenv("EMAIL_FROM", "")),
		PostmarkToken:             getenv("POSTMARK_TOKEN", ""),
		ChallongeClientID:         getenv("CHALLONGE_CLIENT_ID", ""),
		ChallongeClientSecret:     getenv("CHALLONGE_CLIENT_SECRET", ""),
		ChallongeTokenURL:         getenv("CHALLONGE_TOKEN_URL", "https://api.challonge.com/oauth/token"),
		ChallongeAPIBase:          strings.TrimRight(getenv("CHALLONGE_API_BASE", "https://api.challonge.com/v2"), "/"),
		ChallongeScope:            getenv("CHALLONGE_SCOPE", "me application:manage tournaments:read tournaments:write matches:read matches:write participants:read participants:write"),
		ChallongeSubdomain:        getenv("CHALLONGE_SUBDOMAIN", ""),
		TwilioAccountSID:          getenv("TWILIO_ACCOUNT_SID", ""),
		TwilioAuthToken:           getenv("TWILIO_AUTH_TOKEN", ""),
		TwilioAPIKeySID:           getenv("TWILIO_API_KEY_SID", ""),
		TwilioAPIKeySecret:        getenv("TWILIO_API_KEY_SECRET", ""),
		TwilioFromNumber:          getenv("TWILIO_FROM_NUMBER", ""),
		TwilioMessagingServiceSID: getenv("TWILIO_MESSAGING_SERVICE_SID", ""),
		TwilioAPIBase:             strings.TrimRight(getenv("TWILIO_API_BASE", "https://api.twilio.com"), "/"),
		EnvFilePath:               getenv("FIFTEENBALL_ENV_FILE", "/etc/fifteenball/fifteenball.env"),
		OpenMatchEditing:          truthy(getenv("OPEN_MATCH_EDITING", "")),
	}
}

// ParseEnvFile reads a shell-style KEY=VALUE env file (as sourced by the OpenRC
// service) into a map. Blank lines and #-comments are skipped; a leading
// `export ` is stripped; surrounding single/double quotes are removed. Used to
// pick up secrets (e.g. Twilio) added to the file after boot, without a restart.
func ParseEnvFile(path string) (map[string]string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	out := map[string]string{}
	for _, line := range strings.Split(string(b), "\n") {
		s := strings.TrimSpace(line)
		if s == "" || strings.HasPrefix(s, "#") {
			continue
		}
		s = strings.TrimPrefix(s, "export ")
		eq := strings.IndexByte(s, '=')
		if eq <= 0 {
			continue
		}
		key := strings.TrimSpace(s[:eq])
		val := strings.TrimSpace(s[eq+1:])
		if len(val) >= 2 {
			if (val[0] == '"' && val[len(val)-1] == '"') || (val[0] == '\'' && val[len(val)-1] == '\'') {
				val = val[1 : len(val)-1]
			}
		}
		out[key] = val
	}
	return out, nil
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

// IsBootstrapAdmin reports whether an email should receive system_admin on
// sign-in (DECISIONS/019 §D3).
func (c *Config) IsBootstrapAdmin(email string) bool {
	e := strings.ToLower(strings.TrimSpace(email))
	for _, a := range c.BootstrapAdmins {
		if a == e {
			return true
		}
	}
	return false
}
