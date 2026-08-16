// Package mail sends transactional email. SMTP is the required transport;
// a Postmark client can be added later as another Mailer without changing
// callers (reconciliation #4).
package mail

import (
	"context"
	"crypto/tls"
	"fmt"
	"net"
	"net/smtp"
	"strings"
	"time"
)

// Mailer is the sole email seam. Reconciliation mandates this exact shape.
type Mailer interface {
	SendMagicLink(ctx context.Context, toEmail, link string) error
}

// SMTPMailer sends via STARTTLS (or implicit TLS on port 465).
type SMTPMailer struct {
	Host     string
	Port     int
	Username string
	Password string
	From     string
}

func (m *SMTPMailer) SendMagicLink(ctx context.Context, toEmail, link string) error {
	subject := "Your Columbia Cue Club sign-in link"
	body := "Click to finish signing in to Columbia Cue Club tournaments:\n\n" +
		link + "\n\nThis link expires shortly and can be used once. " +
		"If you didn't request it, you can ignore this email.\n"
	msg := buildMessage(m.From, toEmail, subject, body)
	return m.send(ctx, toEmail, msg)
}

func buildMessage(from, to, subject, body string) []byte {
	var b strings.Builder
	fmt.Fprintf(&b, "From: %s\r\n", from)
	fmt.Fprintf(&b, "To: %s\r\n", to)
	fmt.Fprintf(&b, "Subject: %s\r\n", subject)
	b.WriteString("MIME-Version: 1.0\r\n")
	b.WriteString("Content-Type: text/plain; charset=UTF-8\r\n")
	b.WriteString("\r\n")
	b.WriteString(body)
	return []byte(b.String())
}

func (m *SMTPMailer) send(ctx context.Context, to string, msg []byte) error {
	addr := net.JoinHostPort(m.Host, fmt.Sprintf("%d", m.Port))
	d := net.Dialer{Timeout: 15 * time.Second}
	conn, err := d.DialContext(ctx, "tcp", addr)
	if err != nil {
		return fmt.Errorf("smtp dial: %w", err)
	}
	defer conn.Close()

	// Port 465 is implicit TLS; everything else negotiates STARTTLS.
	if m.Port == 465 {
		conn = tls.Client(conn, &tls.Config{ServerName: m.Host})
	}
	c, err := smtp.NewClient(conn, m.Host)
	if err != nil {
		return fmt.Errorf("smtp client: %w", err)
	}
	defer c.Close()

	if m.Port != 465 {
		if ok, _ := c.Extension("STARTTLS"); ok {
			if err := c.StartTLS(&tls.Config{ServerName: m.Host}); err != nil {
				return fmt.Errorf("starttls: %w", err)
			}
		}
	}
	if m.Username != "" {
		auth := smtp.PlainAuth("", m.Username, m.Password, m.Host)
		if err := c.Auth(auth); err != nil {
			return fmt.Errorf("smtp auth: %w", err)
		}
	}
	if err := c.Mail(m.From); err != nil {
		return fmt.Errorf("smtp mail from: %w", err)
	}
	if err := c.Rcpt(to); err != nil {
		return fmt.Errorf("smtp rcpt: %w", err)
	}
	w, err := c.Data()
	if err != nil {
		return fmt.Errorf("smtp data: %w", err)
	}
	if _, err := w.Write(msg); err != nil {
		return fmt.Errorf("smtp write: %w", err)
	}
	if err := w.Close(); err != nil {
		return fmt.Errorf("smtp close data: %w", err)
	}
	return c.Quit()
}

// LogMailer is a dev fallback that never sends; it lets request-link work when
// SMTP isn't configured. It must not be used in production (config warns).
type LogMailer struct{ Sink func(to, link string) }

func (l *LogMailer) SendMagicLink(_ context.Context, to, link string) error {
	if l.Sink != nil {
		l.Sink(to, link)
	}
	return nil
}
