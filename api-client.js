/*
 * api-client.js — drop-in client for the 15-Ball Rotation backend (/api/v1).
 *
 * Handoff artifact for the frontend agent (see server/IMPLEMENTATION/
 * 12-frontend-integration-guide.md). Additive: this file defines a client and
 * does NOT touch existing app.js/bracket.js/tables.js.
 *
 * Model: same-origin (served under /15ball/), so no CORS. Auth is a cookie
 * session (fifteenball_session) set via the magic-link flow; every request sends
 * credentials. Mutations carry the X-CO CSRF header. Unsafe-but-repeatable calls
 * (submit result, reopen, challonge sync) carry an Idempotency-Key.
 *
 * Usage (browser):
 *   const api = FB.createClient();               // base defaults to /15ball/api
 *   await api.requestLink('you@club.test');      // magic link emailed
 *   const me = await api.me();                   // { userId, email, roles, pending }
 *   const { items } = await api.listTournaments();
 *
 * Errors: throws FBApiError with .status and .code (server envelope
 * {error:{code,message}}). Network failures throw with code 'network'.
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod; // node/tests
  root.FB = mod; // browser global
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULT_BASE = '/15ball/api';

  class FBApiError extends Error {
    constructor(message, status, code, body) {
      super(message);
      this.name = 'FBApiError';
      this.status = status;
      this.code = code;
      this.body = body;
    }
  }

  function newIdemKey() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'idem-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  }

  function qs(params) {
    if (!params) return '';
    const p = new URLSearchParams();
    Object.keys(params).forEach((k) => {
      if (params[k] !== undefined && params[k] !== null && params[k] !== '') p.set(k, params[k]);
    });
    const s = p.toString();
    return s ? '?' + s : '';
  }

  function createClient(opts) {
    opts = opts || {};
    const base = (opts.base || DEFAULT_BASE).replace(/\/$/, '');

    // Core request. method GET is safe; anything else gets the X-CO CSRF header.
    async function request(method, path, options) {
      options = options || {};
      const headers = { Accept: 'application/json' };
      let body;
      if (options.body !== undefined) {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(options.body);
      }
      if (method !== 'GET') headers['X-CO'] = '1'; // CSRF (harmless on unprotected routes)
      if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;

      let resp;
      try {
        resp = await fetch(base + path + qs(options.params), {
          method,
          headers,
          body,
          credentials: 'include', // send the session cookie
        });
      } catch (e) {
        throw new FBApiError('network error: ' + e.message, 0, 'network', null);
      }

      const text = await resp.text();
      let data = null;
      if (text) { try { data = JSON.parse(text); } catch (_) { /* non-JSON */ } }

      if (!resp.ok) {
        const err = (data && data.error) || {};
        throw new FBApiError(err.message || resp.statusText || 'request failed', resp.status, err.code || String(resp.status), data);
      }
      return data;
    }

    const get = (p, params) => request('GET', p, { params });
    const post = (p, body, extra) => request('POST', p, Object.assign({ body }, extra));
    const patch = (p, body) => request('PATCH', p, { body });
    const del = (p) => request('DELETE', p, {});

    const T = (id) => '/v1/tournaments/' + encodeURIComponent(id);

    return {
      base,
      newIdemKey,
      request,

      // ---- auth / session ----
      // The magic-link GET landing + confirm-link POST are handled by the
      // backend's own scanner-safe pages; the SPA only needs request-link/me/signout.
      requestLink: (email) => post('/auth/request-link', { email }),
      me: () => get('/me'),
      signout: () => post('/auth/signout'),

      // ---- admin: user roles (system_admin/club_admin) ----
      grantRole: (userId, role) => post('/v1/users/' + encodeURIComponent(userId) + '/roles', { role }),
      revokeRole: (userId, role) => del('/v1/users/' + encodeURIComponent(userId) + '/roles/' + encodeURIComponent(role)),

      // ---- tournaments ----
      listTournaments: (params) => get('/v1/tournaments', params), // {archived, state, cursor}
      getTournament: (id) => get(T(id)),
      createTournament: (body) => post('/v1/tournaments', body),   // {name, game?, visibility?}
      patchTournament: (id, body) => patch(T(id), body),           // {name?, state?, visibility?}
      archiveTournament: (id, reason) => post(T(id) + '/archive', { reason }),

      // ---- divisions ----
      listDivisions: (id) => get(T(id) + '/divisions'),
      createDivision: (id, body) => post(T(id) + '/divisions', body), // {name, format?}

      // ---- entrants ----
      listEntrants: (id, params) => get(T(id) + '/entrants', params),
      createEntrant: (id, body) => post(T(id) + '/entrants', body),   // {displayName, phone?, notifyOptIn?, divisionId?}
      patchEntrant: (id, eid, body) => patch(T(id) + '/entrants/' + encodeURIComponent(eid), body),
      checkInEntrant: (id, eid) => post(T(id) + '/entrants/' + encodeURIComponent(eid) + '/check-in'),
      archiveEntrant: (id, eid, reason) => post(T(id) + '/entrants/' + encodeURIComponent(eid) + '/archive', { reason }),

      // ---- matches ----
      listMatches: (id, params) => get(T(id) + '/matches', params),
      assignMatch: (id, mid, body) => post(T(id) + '/matches/' + encodeURIComponent(mid) + '/assign', body), // {scorekeeperUserId, tableRef?}
      startMatch: (id, mid) => post(T(id) + '/matches/' + encodeURIComponent(mid) + '/start'),
      matchHistory: (id, mid) => get(T(id) + '/matches/' + encodeURIComponent(mid) + '/history'),

      // ---- scoring (idempotent) ----
      submitResult: (id, mid, body, key) =>
        post(T(id) + '/matches/' + encodeURIComponent(mid) + '/result', body, { idempotencyKey: key || newIdemKey() }),
      reopenMatch: (id, mid, reason, key) =>
        post(T(id) + '/matches/' + encodeURIComponent(mid) + '/reopen', { reason }, { idempotencyKey: key || newIdemKey() }),

      // ---- reporting ----
      snapshot: (id) => get(T(id) + '/snapshot'),
      listAudit: (id, params) => get(T(id) + '/audit', params),
      publicTournament: (id) => get('/v1/public/tournaments/' + encodeURIComponent(id)),
      publicOverlay: (id) => get('/v1/public/tournaments/' + encodeURIComponent(id) + '/overlay'),

      // ---- Challonge sync (director+) ----
      startSync: (id, key) => post(T(id) + '/challonge/sync', {}, { idempotencyKey: key || newIdemKey() }),
      syncStatus: (id) => get(T(id) + '/challonge/sync'),
      reconcile: (id) => post(T(id) + '/challonge/reconcile'),

      // ---- live updates (SSE, browser only) ----
      // Returns an EventSource; caller adds listeners and calls .close(). The
      // browser resends Last-Event-ID on reconnect automatically. The same
      // endpoint serves the OBS overlay: for a PUBLIC tournament it streams
      // without a session (auth is decided inside the handler by visibility).
      events: (id) => {
        if (typeof EventSource === 'undefined') throw new FBApiError('EventSource unavailable', 0, 'no_sse', null);
        return new EventSource(base + T(id) + '/events', { withCredentials: true });
      },
    };
  }

  return { createClient, FBApiError, newIdemKey, DEFAULT_BASE };
});
