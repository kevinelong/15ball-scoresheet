// Command fifteenball-server is the Columbia Cue Club tournament backend. Foundation
// slice: config, migrated SQLite store, chi router, GET /api/health, and a
// bounded graceful shutdown. Feature routes (auth, tournaments, challonge) are
// added in subsequent slices per server/SPEC-DESIGN-RECONCILED.md.
package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/kevinelong/15ball-scoresheet/server/internal/api"
	"github.com/kevinelong/15ball-scoresheet/server/internal/auth"
	"github.com/kevinelong/15ball-scoresheet/server/internal/challonge"
	"github.com/kevinelong/15ball-scoresheet/server/internal/config"
	"github.com/kevinelong/15ball-scoresheet/server/internal/mail"
	"github.com/kevinelong/15ball-scoresheet/server/internal/store"
)

func main() {
	cfg := config.Load()

	st, err := store.Open(cfg.DatabasePath)
	if err != nil {
		log.Fatalf("store: %v", err)
	}
	defer st.Close()

	// Mailer: SMTP is required in production; fall back to a no-op logger if
	// unconfigured so the service still runs (request-link then just no-ops).
	var mailer mail.Mailer
	if cfg.SMTPHost != "" {
		mailer = &mail.SMTPMailer{Host: cfg.SMTPHost, Port: cfg.SMTPPort, Username: cfg.SMTPUsername, Password: cfg.SMTPPassword, From: cfg.EmailFrom}
	} else {
		log.Printf("WARNING: SMTP not configured (SMTP_HOST empty) — magic links will not be sent")
		mailer = &mail.LogMailer{Sink: func(to, link string) { log.Printf("magic link for %s (SMTP disabled)", to) }}
	}
	a := auth.New(st.DB, cfg, mailer)

	// Challonge Connect client (OAuth2 client-credentials). If configured, verify
	// connectivity in the background at startup and log the outcome (no secrets).
	ch := challonge.New(challonge.Config{
		ClientID: cfg.ChallongeClientID, ClientSecret: cfg.ChallongeClientSecret,
		TokenURL: cfg.ChallongeTokenURL, APIBase: cfg.ChallongeAPIBase, Scope: cfg.ChallongeScope,
	})
	if ch.Configured() {
		go func() {
			pctx, pcancel := context.WithTimeout(context.Background(), 25*time.Second)
			defer pcancel()
			if n, err := ch.Ping(pctx); err != nil {
				log.Printf("challonge: connectivity check FAILED: %v", err)
			} else {
				log.Printf("challonge: connected (app tournaments: %d)", n)
			}
		}()
	} else {
		log.Printf("challonge: not configured (CHALLONGE_CLIENT_ID empty) — export disabled")
	}
	_ = ch // export routes wired in the export sub-slice (pending membership-role authz)

	r := chi.NewRouter()
	r.Use(middleware.RealIP)
	r.Use(middleware.RequestID) // request_id threaded into audit rows
	r.Use(middleware.Recoverer)

	// Health is registered before any authenticated routing (reconciliation #14).
	r.Get("/api/health", healthHandler(st))

	// Auth: public request-link + scanner-safe GET landing; confirm-link needs
	// X-CO (the landing page sends it); me/signout need a session.
	r.Post("/api/auth/request-link", a.RequestLink)
	r.Get("/api/auth/verify", a.Verify)
	r.With(a.RequireCSRF).Post("/api/auth/confirm-link", a.ConfirmLink)
	r.With(a.RequireSession).Get("/api/me", a.Me)
	r.With(a.RequireCSRF, a.RequireSession).Post("/api/auth/signout", a.Signout)

	// Admin: user role management (system_admin/club_admin only), CSRF + audited.
	r.With(a.RequireCSRF, a.RequireSession, a.RequireRoles(auth.AdminOnly...)).
		Post("/api/v1/users/{id}/roles", a.GrantRoleHandler)
	r.With(a.RequireCSRF, a.RequireSession, a.RequireRoles(auth.AdminOnly...)).
		Delete("/api/v1/users/{id}/roles/{role}", a.RevokeRoleHandler)

	// Domain API (/api/v1). Reads require a session; mutations require CSRF + director+.
	dapi := api.New(st.DB, a)
	sess := r.With(a.RequireSession)
	dir := r.With(a.RequireCSRF, a.RequireSession, a.RequireRoles(auth.DirectorOrAbove...))
	// tournaments + divisions (Slice B)
	sess.Get("/api/v1/tournaments", dapi.ListTournaments)
	dir.Post("/api/v1/tournaments", dapi.CreateTournament)
	sess.Get("/api/v1/tournaments/{id}", dapi.GetTournament)
	dir.Patch("/api/v1/tournaments/{id}", dapi.PatchTournament)
	dir.Post("/api/v1/tournaments/{id}/archive", dapi.ArchiveTournament)
	sess.Get("/api/v1/tournaments/{id}/divisions", dapi.ListDivisions)
	dir.Post("/api/v1/tournaments/{id}/divisions", dapi.CreateDivision)
	// entrants + check-in (Slice C)
	sess.Get("/api/v1/tournaments/{id}/entrants", dapi.ListEntrants)
	dir.Post("/api/v1/tournaments/{id}/entrants", dapi.CreateEntrant)
	dir.Patch("/api/v1/tournaments/{id}/entrants/{entrantId}", dapi.PatchEntrant)
	dir.Post("/api/v1/tournaments/{id}/entrants/{entrantId}/check-in", dapi.CheckInEntrant)
	dir.Post("/api/v1/tournaments/{id}/entrants/{entrantId}/archive", dapi.ArchiveEntrant)

	srv := &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           r,
		ReadHeaderTimeout: 10 * time.Second,
	}

	// Cancelable root context + bounded shutdown (reconciliation #15).
	root, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	go func() {
		log.Printf("fifteenball-server listening on %s (db=%s)", cfg.ListenAddr, cfg.DatabasePath)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("listen: %v", err)
		}
	}()

	<-root.Done()
	log.Printf("shutting down…")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Printf("graceful shutdown failed: %v", err)
		_ = srv.Close()
	}
	log.Printf("stopped")
	_ = os.Stdout.Sync()
}

// healthHandler pings the DB with a 1s deadline; 200 healthy / 503 degraded,
// always no-store JSON (reconciliation #14).
func healthHandler(st *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), time.Second)
		defer cancel()
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		var one int
		if err := st.DB.QueryRowContext(ctx, "SELECT 1").Scan(&one); err != nil || one != 1 {
			w.WriteHeader(http.StatusServiceUnavailable)
			_ = json.NewEncoder(w).Encode(map[string]string{"status": "degraded"})
			return
		}
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
	}
}
