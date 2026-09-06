/* overlay-live.js — live OBS broadcast overlay for the 15-Ball tournament system.
 *
 * Additive: reads tournament/matches/entrants over api-client.js (global FB) and
 * renders a lower-third card of the "current" match. Designed to composite over
 * video in an OBS Browser Source (transparent page background).
 *
 * URL: overlay-live.html?t=<slug-or-id>
 *
 * Live: subscribes to SSE (api.events) and re-renders on any event (debounced);
 * also polls every 5s as a fallback. All network is wrapped so the page never
 * white-screens: unknown tournament shows a small "not found" line.
 */
(function () {
  'use strict';

  var api = FB.createClient();
  var cardEl = document.getElementById('card');

  var state = {
    t: null,          // canonical tournament object
    cid: null,        // canonical id
    names: {},        // entrantId -> displayName (excludes BYE)
    matches: [],      // latest match list
    es: null,         // EventSource
    pollTimer: null,  // fallback poll interval
    busy: false       // reentrancy guard for refresh()
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var BYE_NAME = '— BYE —';
  function isBye(id) {
    if (!id) return true;
    var n = state.names[id];
    return n === undefined || n === BYE_NAME; // archived BYE not in the map
  }
  function nm(id) { return id ? (state.names[id] || '…') : '—'; }

  function bracketTag(b) {
    if (b === 'W') return 'Winners';
    if (b === 'L') return 'Losers';
    if (b === 'GF') return 'Grand Final';
    return '';
  }

  // Choose the match to feature. Prefer an active match (in_progress|reopened),
  // most-recently-updated; else the earliest ready scheduled/assigned match with
  // both real (non-BYE) entrants.
  function pickMatch(matches) {
    var active = matches.filter(function (m) {
      return m.state === 'in_progress' || m.state === 'reopened';
    });
    if (active.length) {
      active.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
      return active[0];
    }
    var ready = matches.filter(function (m) {
      return (m.state === 'scheduled' || m.state === 'assigned') &&
        m.entrantAId && m.entrantBId && !isBye(m.entrantAId) && !isBye(m.entrantBId);
    });
    if (ready.length) {
      ready.sort(function (a, b) {
        var ac = a.createdAt || 0, bc = b.createdAt || 0;
        if (ac !== bc) return ac - bc;         // earliest created first
        return (a.updatedAt || 0) - (b.updatedAt || 0);
      });
      return ready[0];
    }
    return null;
  }

  function renderStandby(msg, sub) {
    var h = '<div class="standby">' + esc(msg) + '</div>';
    if (sub) h += '<div class="subtle">' + esc(sub) + '</div>';
    cardEl.innerHTML = h;
  }

  function render() {
    var t = state.t;
    if (!t) { renderStandby('Standing by'); return; }

    var m = pickMatch(state.matches || []);
    var head =
      '<div class="tourney">' +
      '<span class="name">' + esc(t.name || 'Tournament') + '</span>' +
      (t.game ? '<span class="game">' + esc(gameLabel(t.game)) + '</span>' : '') +
      '</div>';

    if (!m) {
      cardEl.innerHTML = head + '<div class="standby" style="font-size:clamp(1rem,1.9vw,1.7rem)">Standing by</div>';
      return;
    }

    var tags = '<div class="tags">';
    if (m.matchLabel) tags += '<span class="tag">' + esc(m.matchLabel) + '</span>';
    var bt = bracketTag(m.bracket);
    if (bt) tags += '<span class="tag bracket-' + esc(m.bracket) + '">' + esc(bt) + '</span>';
    if (m.tableRef) tags += '<span class="tag table">Table ' + esc(m.tableRef) + '</span>';
    tags += '</div>';

    var players =
      '<div class="players">' +
      '<span class="player">' + esc(nm(m.entrantAId)) + '</span>' +
      '<span class="vs">vs</span>' +
      '<span class="player">' + esc(nm(m.entrantBId)) + '</span>' +
      '</div>';

    cardEl.innerHTML = head + tags + players;
  }

  // Minimal game id -> label map (mirrors backend valid games).
  var GAME_LABELS = {
    '15ball_rotation': '15-Ball Rotation',
    '8ball': '8-Ball',
    '9ball': '9-Ball',
    '10ball': '10-Ball',
    'straight_14_1': 'Straight Pool (14.1)',
    'bank_pool': 'Bank Pool',
    'one_pocket': 'One Pocket'
  };
  function gameLabel(id) { return id ? (GAME_LABELS[id] || id) : ''; }

  // Fetch tournament + entrants + matches and re-render. Resilient: on failure it
  // leaves the last good render up (or shows not-found on the initial load).
  async function refresh(idOrSlug, initial) {
    if (state.busy) return;
    state.busy = true;
    try {
      var got = await api.getTournament(idOrSlug);
      state.t = got.tournament;
      state.cid = state.t.id;

      var ents = [];
      try { ents = (await api.listEntrants(state.cid, { archived: true })).items || []; } catch (e) { ents = []; }
      var names = {};
      ents.forEach(function (e) {
        if (e.archivedAt) return;              // excludes the auto-BYE entrant
        if (e.displayName === BYE_NAME) return;
        names[e.id] = e.displayName;
      });
      state.names = names;

      try { state.matches = (await api.listMatches(state.cid)).items || []; } catch (e) { state.matches = []; }

      render();
    } catch (e) {
      if (initial || !state.t) {
        if (e && (e.status === 404 || e.code === 'not_found')) {
          renderStandby('Tournament not found', 'check the ?t= value');
        } else {
          renderStandby('Standing by', 'reconnecting…');
        }
      }
      // non-initial errors: keep the last good render on screen
    } finally {
      state.busy = false;
    }
  }

  function debounce(fn, ms) {
    var timer;
    return function () { clearTimeout(timer); timer = setTimeout(fn, ms); };
  }

  function subscribeSSE(idOrSlug) {
    // SSE needs the canonical id; fall back gracefully if unavailable.
    var sseId = state.cid || idOrSlug;
    try {
      state.es = api.events(sseId);
      var reload = debounce(function () { refresh(idOrSlug, false); }, 300);
      state.es.onmessage = reload;
      state.es.addEventListener('snapshot_required', reload);
      state.es.addEventListener('hello', function () {});
      state.es.onerror = function () {
        // Let the browser auto-reconnect; the 5s poll covers gaps meanwhile.
      };
    } catch (e) {
      state.es = null; // SSE unavailable — polling still keeps it fresh
    }
  }

  function startPolling(idOrSlug) {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = setInterval(function () { refresh(idOrSlug, false); }, 5000);
  }

  async function init() {
    var t = new URLSearchParams(location.search).get('t');
    if (!t) {
      cardEl.innerHTML = '<div class="hint">add ?t=&lt;tournament&gt; to the URL</div>';
      return;
    }
    await refresh(t, true);   // establishes canonical id when successful
    subscribeSSE(t);
    startPolling(t);
  }

  init();
})();
