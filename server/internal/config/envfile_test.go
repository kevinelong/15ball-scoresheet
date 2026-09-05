package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestParseEnvFile(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "f.env")
	content := `# a comment
LISTEN_ADDR=127.0.0.1:8093

export TWILIO_ACCOUNT_SID=ACxxxx
TWILIO_AUTH_TOKEN="quoted-token"
TWILIO_FROM_NUMBER='+15551234567'
BLANKY=
NOEQUALSIGN
`
	if err := os.WriteFile(p, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	m, err := ParseEnvFile(p)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	cases := map[string]string{
		"LISTEN_ADDR":        "127.0.0.1:8093",
		"TWILIO_ACCOUNT_SID": "ACxxxx",      // export stripped
		"TWILIO_AUTH_TOKEN":  "quoted-token", // double quotes stripped
		"TWILIO_FROM_NUMBER": "+15551234567", // single quotes stripped
		"BLANKY":             "",
	}
	for k, want := range cases {
		if got, ok := m[k]; !ok || got != want {
			t.Errorf("%s = %q (ok=%v), want %q", k, got, ok, want)
		}
	}
	if _, ok := m["NOEQUALSIGN"]; ok {
		t.Errorf("line without '=' should be skipped")
	}
	if _, ok := m["# a comment"]; ok {
		t.Errorf("comment should be skipped")
	}
}

func TestParseEnvFileMissing(t *testing.T) {
	if _, err := ParseEnvFile(filepath.Join(t.TempDir(), "nope.env")); err == nil {
		t.Fatalf("expected error for missing file")
	}
}
