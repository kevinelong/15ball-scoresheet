// Package challonge is a Challonge Connect (OAuth2 client-credentials) client for
// the shared club application. Verified request recipe (2026-08-17):
//   - token: POST {TokenURL} grant_type=client_credentials + client_id/secret +
//     scope including "application:manage"; access_token TTL ~7d.
//   - every API call: Authorization: Bearer <t>, Authorization-Type: v2,
//     Content-Type: application/vnd.api+json, Accept: application/json.
//   - app-scoped resources live under {APIBase}/application/... in JSON:API shape
//     {data, included, meta, links}.
//
// Reconciliation #13 (auth layer swapped from a static v1 key to a cached token).
package challonge

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

type Client struct {
	clientID, clientSecret string
	tokenURL, apiBase      string
	scope                  string
	hc                     *http.Client

	mu          sync.Mutex
	cachedToken string
	tokenExp    time.Time
}

type Config struct {
	ClientID, ClientSecret string
	TokenURL, APIBase      string
	Scope                  string
}

func New(c Config) *Client {
	return &Client{
		clientID: c.ClientID, clientSecret: c.ClientSecret,
		tokenURL: c.TokenURL, apiBase: strings.TrimRight(c.APIBase, "/"),
		scope: c.Scope,
		hc:    &http.Client{Timeout: 20 * time.Second},
	}
}

// Configured reports whether credentials are present (export stays disabled if not).
func (c *Client) Configured() bool { return c.clientID != "" && c.clientSecret != "" }

type tokenResp struct {
	AccessToken string `json:"access_token"`
	TokenType   string `json:"token_type"`
	ExpiresIn   int64  `json:"expires_in"`
	Scope       string `json:"scope"`
}

// token returns a valid bearer token, refreshing via client_credentials when the
// cached one is missing or within a 5-minute expiry margin.
func (c *Client) token(ctx context.Context) (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.cachedToken != "" && time.Until(c.tokenExp) > 5*time.Minute {
		return c.cachedToken, nil
	}
	form := url.Values{}
	form.Set("grant_type", "client_credentials")
	form.Set("client_id", c.clientID)
	form.Set("client_secret", c.clientSecret)
	form.Set("scope", c.scope)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.tokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	resp, err := c.hc.Do(req)
	if err != nil {
		return "", fmt.Errorf("challonge token: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("challonge token: status %d", resp.StatusCode)
	}
	var tr tokenResp
	if err := json.Unmarshal(body, &tr); err != nil {
		return "", fmt.Errorf("challonge token decode: %w", err)
	}
	if tr.AccessToken == "" {
		return "", errors.New("challonge token: empty access_token")
	}
	c.cachedToken = tr.AccessToken
	ttl := tr.ExpiresIn
	if ttl <= 0 {
		ttl = 3600
	}
	c.tokenExp = time.Now().Add(time.Duration(ttl) * time.Second)
	return c.cachedToken, nil
}

// Do issues an authenticated JSON:API request to an app-scoped path (e.g.
// "/application/tournaments.json"). body may be nil. It returns the raw response
// bytes and status; callers decode the JSON:API envelope.
func (c *Client) Do(ctx context.Context, method, path string, body interface{}) ([]byte, int, error) {
	tok, err := c.token(ctx)
	if err != nil {
		return nil, 0, err
	}
	var rdr io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, 0, err
		}
		rdr = bytes.NewReader(b)
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	req, err := http.NewRequestWithContext(ctx, method, c.apiBase+path, rdr)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Authorization", "Bearer "+tok)
	req.Header.Set("Authorization-Type", "v2")
	req.Header.Set("Content-Type", "application/vnd.api+json")
	req.Header.Set("Accept", "application/json")
	resp, err := c.hc.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	out, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	return out, resp.StatusCode, nil
}

// Ping verifies connectivity + credentials by listing the application's
// tournaments (a cheap authenticated GET). Returns the reported count.
func (c *Client) Ping(ctx context.Context) (int, error) {
	out, code, err := c.Do(ctx, http.MethodGet, "/application/tournaments.json", nil)
	if err != nil {
		return 0, err
	}
	if code != http.StatusOK {
		return 0, fmt.Errorf("challonge ping: status %d: %s", code, truncate(out, 200))
	}
	var env struct {
		Meta struct {
			Count int `json:"count"`
		} `json:"meta"`
	}
	_ = json.Unmarshal(out, &env)
	return env.Meta.Count, nil
}

func truncate(b []byte, n int) string {
	if len(b) > n {
		return string(b[:n])
	}
	return string(b)
}
