package syncer

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"

	"github.com/kevinelong/15ball-scoresheet/server/internal/challonge"
)

// provErr carries retry classification through the worker.
type provErr struct {
	msg       string
	retryable bool
}

func (e *provErr) Error() string   { return e.msg }
func (e *provErr) Retryable() bool { return e.retryable }

// ---- Challonge (real) provider --------------------------------------------
// NOTE: the v2 JSON:API write paths/attributes below are best-effort and should
// be validated against the live sandbox before enabling real sync in production.
// The outbox mechanics + mapping are provider-agnostic and fully tested via the
// fake provider (07-challonge-sync-contract: tests use fakes only).

type ChallongeProvider struct{ C *challonge.Client }

func classify(code int, out []byte) error {
	switch {
	case code == 429 || code >= 500:
		return &provErr{fmt.Sprintf("challonge transient %d", code), true}
	case code >= 400:
		return &provErr{fmt.Sprintf("challonge %d: %s", code, truncate(out, 200)), false}
	}
	return nil
}

func truncate(b []byte, n int) string {
	if len(b) > n {
		return string(b[:n])
	}
	return string(b)
}

func (p *ChallongeProvider) EnsureTournament(ctx context.Context, name, urlKey string) (string, string, error) {
	body := map[string]interface{}{"data": map[string]interface{}{
		"type": "tournaments",
		"attributes": map[string]interface{}{
			"name": name, "url": urlKey, "tournament_type": "single elimination",
		}}}
	out, code, err := p.C.Do(ctx, "POST", "/application/tournaments.json", body)
	if err != nil {
		return "", "", &provErr{err.Error(), true}
	}
	if e := classify(code, out); e != nil {
		return "", "", e
	}
	var r struct {
		Data struct {
			ID         json.Number `json:"id"`
			Attributes struct {
				FullURL string `json:"full_challonge_url"`
			} `json:"attributes"`
		} `json:"data"`
	}
	_ = json.Unmarshal(out, &r)
	return r.Data.ID.String(), r.Data.Attributes.FullURL, nil
}

func (p *ChallongeProvider) AddParticipant(ctx context.Context, providerTournamentID, name string) (string, error) {
	body := map[string]interface{}{"data": map[string]interface{}{
		"type":       "participants",
		"attributes": map[string]interface{}{"name": name},
	}}
	path := "/application/tournaments/" + providerTournamentID + "/participants.json"
	out, code, err := p.C.Do(ctx, "POST", path, body)
	if err != nil {
		return "", &provErr{err.Error(), true}
	}
	if e := classify(code, out); e != nil {
		return "", e
	}
	var r struct {
		Data struct {
			ID json.Number `json:"id"`
		} `json:"data"`
	}
	_ = json.Unmarshal(out, &r)
	return r.Data.ID.String(), nil
}

// ---- Fake provider (tests) -------------------------------------------------

type FakeProvider struct {
	mu           sync.Mutex
	seq          int
	FailUntil    int    // fail this many calls (transient) before succeeding
	FailFatal    bool   // if true, fail non-retryably
	Tournaments  map[string]string
	Participants []string
}

func NewFake() *FakeProvider { return &FakeProvider{Tournaments: map[string]string{}} }

func (f *FakeProvider) maybeFail() error {
	if f.FailUntil > 0 {
		f.FailUntil--
		return &provErr{"fake transient", true}
	}
	if f.FailFatal {
		return &provErr{"fake fatal", false}
	}
	return nil
}

func (f *FakeProvider) EnsureTournament(_ context.Context, name, urlKey string) (string, string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.maybeFail(); err != nil {
		return "", "", err
	}
	f.seq++
	id := fmt.Sprintf("prov_t_%d", f.seq)
	f.Tournaments[id] = name
	return id, "https://fake.challonge/" + urlKey, nil
}

func (f *FakeProvider) AddParticipant(_ context.Context, providerTournamentID, name string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.maybeFail(); err != nil {
		return "", err
	}
	f.seq++
	id := fmt.Sprintf("prov_p_%d", f.seq)
	f.Participants = append(f.Participants, name)
	return id, nil
}
