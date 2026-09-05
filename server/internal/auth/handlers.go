package auth

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
)

type ctxKey string

const userIDKey ctxKey = "fifteenball_user_id"

const sessionCookieName = "fifteenball_session"

func (a *Auth) sessionCookie(value string, maxAge int) *http.Cookie {
	return &http.Cookie{
		Name: sessionCookieName, Value: value, Path: "/15ball/", MaxAge: maxAge,
		Secure: true, HttpOnly: true, SameSite: http.SameSiteLaxMode,
	}
}

func writeJSON(w http.ResponseWriter, code int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

// ipHash returns a privacy-preserving key for the client IP. The upstream is
// loopback-only nginx, which sets X-Real-IP; chi's RealIP puts it in RemoteAddr.
func ipHash(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	sum := sha256.Sum256([]byte(host))
	return hex.EncodeToString(sum[:])
}

func uaHash(r *http.Request) string {
	sum := sha256.Sum256([]byte(r.UserAgent()))
	return hex.EncodeToString(sum[:])
}

// ---- middleware ------------------------------------------------------------

// RequireCSRF rejects unsafe requests lacking the exact X-CO: 1 header (#5).
func (a *Auth) RequireCSRF(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-CO") != "1" {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "csrf_failed"})
			return
		}
		next.ServeHTTP(w, r)
	})
}

// RequireSession loads a valid session into the context or returns 401.
func (a *Auth) RequireSession(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := r.Cookie(sessionCookieName)
		if err != nil || c.Value == "" {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthenticated"})
			return
		}
		userID, err := a.LookupSession(r.Context(), c.Value)
		if err != nil {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthenticated"})
			return
		}
		ctx := context.WithValue(r.Context(), userIDKey, userID)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// UserID extracts the authenticated user id set by RequireSession.
func UserID(ctx context.Context) string {
	if v, ok := ctx.Value(userIDKey).(string); ok {
		return v
	}
	return ""
}

// ---- handlers --------------------------------------------------------------

// RequestLink: POST /api/auth/request-link {email} -> always 202 (enumeration-
// and rate-limit-safe). Public (no session, no CSRF header required).
func (a *Auth) RequestLink(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Email string `json:"email"`
	}
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body)
	func() {
		defer func() {
			if rec := recover(); rec != nil {
				log.Printf("request-link recovered: %v", rec)
			}
		}()
		a.SendLinkIfAllowed(r.Context(), body.Email, ipHash(r))
	}()
	writeJSON(w, http.StatusAccepted, map[string]string{"status": "sent_if_allowed"})
}

const landingPage = `<!doctype html><html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in — Columbia Cue Club</title>
<style>body{font-family:system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem;text-align:center}
button{font-size:1rem;padding:.7rem 1.4rem;border:0;border-radius:.5rem;background:#0a7;color:#fff;cursor:pointer}
.err{color:#b00;margin-top:1rem}</style></head><body>
<h1>Columbia Cue Club</h1>
<p>Click to finish signing in on this device.</p>
<button id="go">Continue to 15-Ball</button>
<p id="err" class="err" hidden>That link is invalid or expired. Request a new one.</p>
<script>
document.getElementById('go').addEventListener('click', async function(){
  this.disabled = true;
  try {
    const res = await fetch(%s + '/api/auth/confirm-link', {
      method:'POST', credentials:'include',
      headers:{'Content-Type':'application/json','X-CO':'1'},
      body: JSON.stringify({s: %s, t: %s})
    });
    if (res.ok) { window.location = '/15ball/'; return; }
  } catch(e){}
  this.disabled = false;
  document.getElementById('err').hidden = false;
});
</script></body></html>`

// Verify: GET /api/auth/verify?s=&t= -> no-store landing page ONLY; never mutates
// (scanner-safe, #8). s/t are attacker-controlled but json.Marshal escapes
// <>& (Go default), so embedding them as JSON literals inside <script> is safe.
func (a *Auth) Verify(w http.ResponseWriter, r *http.Request) {
	sj, _ := json.Marshal(r.URL.Query().Get("s"))
	tj, _ := json.Marshal(r.URL.Query().Get("t"))
	baseJS, _ := json.Marshal(a.Cfg.BaseURL)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	fmt.Fprintf(w, landingPage, baseJS, sj, tj)
}

// ConfirmLink: POST /api/auth/confirm-link {s,t} -> consumes link, sets session
// cookie. Requires X-CO:1 (wired via RequireCSRF in main).
func (a *Auth) ConfirmLink(w http.ResponseWriter, r *http.Request) {
	var body struct {
		S string `json:"s"`
		T string `json:"t"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_link"})
		return
	}
	userID, err := a.ConsumeMagicLink(r.Context(), body.S, body.T)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid_link"})
		return
	}
	raw, err := a.CreateSession(r.Context(), userID, uaHash(r), ipHash(r))
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "server_error"})
		return
	}
	// Backfill role for pre-existing users + record sign-in.
	_ = a.EnsureProvisioned(r.Context(), userID, "")
	a.touchLastLogin(r.Context(), userID)
	http.SetCookie(w, a.sessionCookie(raw, int(a.Cfg.SessionTTL.Seconds())))
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "redirect": "/15ball/"})
}

// Me: GET /api/me -> {userId,email,roles,pending} (RequireSession wired in main).
func (a *Auth) Me(w http.ResponseWriter, r *http.Request) {
	uid := UserID(r.Context())
	email, err := a.UserEmail(r.Context(), uid)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthenticated"})
		return
	}
	roles, _ := a.Roles(r.Context(), uid)
	if roles == nil {
		roles = []string{}
	}
	pending, _ := a.Pending(r.Context(), uid)
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"userId": uid, "email": email, "roles": roles, "pending": pending,
	})
}

// Signout: POST /api/auth/signout -> revoke + clear cookie (RequireCSRF wired).
func (a *Auth) Signout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(sessionCookieName); err == nil && c.Value != "" {
		_ = a.RevokeSession(r.Context(), c.Value)
	}
	http.SetCookie(w, a.sessionCookie("", -1))
	writeJSON(w, http.StatusOK, map[string]string{"status": "signed_out"})
}
