// Command kball-server is the Columbia Cue Club tournament backend. Foundation
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
	"github.com/kevinelong/kball-scoresheet/server/internal/config"
	"github.com/kevinelong/kball-scoresheet/server/internal/store"
)

func main() {
	cfg := config.Load()

	st, err := store.Open(cfg.DatabasePath)
	if err != nil {
		log.Fatalf("store: %v", err)
	}
	defer st.Close()

	r := chi.NewRouter()
	r.Use(middleware.RealIP)
	r.Use(middleware.Recoverer)

	// Health is registered before any authenticated routing (reconciliation #14).
	r.Get("/api/health", healthHandler(st))

	srv := &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           r,
		ReadHeaderTimeout: 10 * time.Second,
	}

	// Cancelable root context + bounded shutdown (reconciliation #15).
	root, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	go func() {
		log.Printf("kball-server listening on %s (db=%s)", cfg.ListenAddr, cfg.DatabasePath)
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
