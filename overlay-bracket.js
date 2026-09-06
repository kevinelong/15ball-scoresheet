/* overlay-bracket.js — Columbia Cue Club standalone OBS bracket overlay.
 * A self-contained, READ-ONLY Browser Source that renders the FULL connected-tree
 * double-elimination bracket for ?t=<slugOrId>, live-updating over SSE with a poll
 * fallback. Separate from overlay-live.html (the current-match lower-third). It
 * deliberately duplicates the compact bracket-rendering logic from live.js in
 * read-only form so it stays a fully independent overlay surface — no tap-to-score,
 * no buttons, no shared refactor. Page background is transparent; cards keep panel bg.
 */
(function () {
  'use strict';
  var api = FB.createClient();
  var appEl = document.getElementById('app');

  var state = { cid: null, names: {}, seeds: {}, matches: [], tState: '', es: null };

  // ---- helpers ----
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function nm(id) { return id ? (state.names[id] || '…') : '—'; }
  function seedOf(id) { return (id && state.seeds[id] != null) ? String(state.seeds[id]) : '—'; }
  function isBye(id) { return id && state.names[id] === '— BYE —'; }
  function debounce(fn, ms) { var t; return function () { clearTimeout(t); t = setTimeout(fn, ms); }; }
  function standby(msg) { appEl.innerHTML = '<div class="standby">' + esc(msg) + '</div>'; }

  function bracketName(b) { return b === 'W' ? 'Winners' : b === 'L' ? 'Losers' : b === 'GF' ? 'Grand Final' : 'Bracket'; }

  // Parse the round number out of a match label (W2M1 -> 2, L3M1 -> 3); falls back to bracketRound.
  function roundOf(m) {
    var lbl = m.matchLabel || '';
    var mo = lbl.match(/^[WL](\d+)M/);
    return mo ? parseInt(mo[1], 10) : (m.bracketRound || 1);
  }
  // Short origin label: prefix before "M" (W2M1 -> "W2"); GF labels collapse to "GF".
  function shortLabel(m) {
    var lbl = m.matchLabel || '';
    if (m.bracket === 'GF' || /^GF/.test(lbl)) return 'GF';
    var mo = lbl.match(/^([WL]\d+)M/);
    if (mo) return mo[1];
    return (m.bracket || '') + (m.bracketRound || '');
  }
  // Reverse feeder map: only cross-region edges (W->L, W->GF, L->GF).
  function buildOriginMap() {
    var byId = {};
    state.matches.forEach(function (m) { byId[m.id] = m; });
    var map = {};
    function add(srcId, targetId, slot) {
      if (targetId == null || slot == null) return;
      var src = byId[srcId], tgt = byId[targetId];
      if (!src || !tgt) return;
      if (src.bracket === tgt.bracket) return;
      (map[targetId] = map[targetId] || {})[slot] = src;
    }
    state.matches.forEach(function (S) {
      add(S.id, S.feedsWinnerMatch, S.feedsWinnerSlot);
      add(S.id, S.feedsLoserMatch, S.feedsLoserSlot);
    });
    return map;
  }
  function originsFor(map, m) {
    var e = map[m.id]; if (!e) return {};
    var o = {};
    if (e[0]) o.a = '‹ ' + shortLabel(e[0]);
    if (e[1]) o.b = '‹ ' + shortLabel(e[1]);
    return o;
  }

  // ---- read-only bracket markup ----
  function bracketSlot(id, opts) {
    opts = opts || {};
    var cls = ['slot'];
    var nameHtml;
    if (!id) { cls.push('tbd'); nameHtml = 'TBD'; }
    else if (isBye(id)) { cls.push('bye'); nameHtml = esc(state.names[id]); }
    else nameHtml = esc(nm(id));
    if (opts.win) cls.push('win');
    else if (opts.lose) cls.push('lose');
    if (opts.origin) nameHtml += ' <span class="origin">' + esc(opts.origin) + '</span>';
    var seed = '<span class="seed">' + esc(id ? seedOf(id) : '—') + '</span>';
    var score = '<span class="score">' + (opts.win ? '✓' : '') + '</span>';
    return '<div class="' + cls.join(' ') + '">' + seed + '<span class="name">' + nameHtml + '</span>' + score + '</div>';
  }

  function bracketCard(m, connectors, origins) {
    connectors = connectors || {}; origins = origins || {};
    var a = m.entrantAId, b = m.entrantBId;
    var win = m.winnerEntrantId || null;
    var aWin = !!(win && a && win === a), bWin = !!(win && b && win === b);
    var live = (m.state === 'in_progress' || m.state === 'reopened');

    var cls = ['match'];
    if (bWin) cls.push('bottomwin');
    if (live) cls.push('is-live');
    if (connectors.pairTop) cls.push('pair-top');
    if (connectors.lead) cls.push('lead');

    var h = '<div class="' + cls.join(' ') + '">';
    h += '<span class="mlabel">' + esc(m.matchLabel || ('R' + m.bracketRound + '·' + (m.slot + 1))) + '</span>';
    if (live) h += '<span class="live-pill">LIVE</span>';
    h += bracketSlot(a, { win: aWin, lose: !!win && !aWin, origin: origins.a });
    h += bracketSlot(b, { win: bWin, lose: !!win && !bWin, origin: origins.b });
    return h + '</div>';
  }

  function bracketColumn(head, matches, opts) {
    opts = opts || {};
    matches = matches.slice().sort(function (x, y) { return x.slot - y.slot; });
    var cells = matches.map(function (m, i) {
      var connectors = {};
      if (opts.tree) {
        if (i % 2 === 0) connectors.pairTop = true;
        if (!opts.first) connectors.lead = true;
      } else if (opts.leadOnly && !opts.first) {
        connectors.lead = true;
      }
      var origins = opts.origins ? opts.origins(m) : {};
      return bracketCard(m, connectors, origins);
    }).join('');
    return '<div class="round"><div class="round-head">' + esc(head) + '</div>' + cells + '</div>';
  }

  function roundsOf(list) {
    var byRound = {};
    list.forEach(function (m) { var r = roundOf(m); (byRound[r] = byRound[r] || []).push(m); });
    return Object.keys(byRound).map(Number).sort(function (x, y) { return x - y; })
      .map(function (r) { return { round: r, matches: byRound[r] }; });
  }

  // Flat fallback for single-elim / 2-player (no bracket namespaces).
  function matchesMarkup() {
    if (!state.matches.length) return '';
    var groups = { W: [], L: [], GF: [], single: [] };
    state.matches.forEach(function (m) { (groups[m.bracket] || groups.single).push(m); });
    var order = ['W', 'L', 'GF', 'single'], out = '';
    order.forEach(function (b) {
      var list = groups[b]; if (!list.length) return;
      out += '<section class="region"><div class="region-title"><span class="dot"></span>' + esc(bracketName(b)) + '</div>' +
        '<div class="rounds">' + bracketColumn('', list, {}) + '</div></section>';
    });
    return '<div class="bracket"><div class="scroller"><div class="canvas">' + out + '</div></div></div>';
  }

  function renderBracket() {
    if (!state.matches.length) return '';
    var groups = { W: [], L: [], GF: [] }, anyBracketed = false;
    state.matches.forEach(function (m) {
      if (m.bracket && groups[m.bracket]) { groups[m.bracket].push(m); anyBracketed = true; }
    });
    if (!anyBracketed) return matchesMarkup();

    var originMap = buildOriginMap();
    var originsOf = function (m) { return originsFor(originMap, m); };
    var canvas = '';

    if (groups.W.length) {
      var wr = roundsOf(groups.W), wLast = wr.length;
      var wCols = wr.map(function (rc, i) {
        var head = (i === wLast - 1) ? 'Winners final' : 'Winners R' + rc.round;
        return bracketColumn(head, rc.matches, { tree: true, first: i === 0 });
      }).join('');
      canvas += '<section class="region win"><div class="region-title"><span class="dot"></span>Winners bracket</div>' +
        '<div class="rounds">' + wCols + '</div></section>';
    }

    if (groups.L.length) {
      var lr = roundsOf(groups.L), lLast = lr.length;
      var lCols = lr.map(function (rc, i) {
        var head = (i === lLast - 1) ? 'Losers final' : 'Losers R' + rc.round;
        return bracketColumn(head, rc.matches, { leadOnly: true, first: i === 0, origins: originsOf });
      }).join('');
      canvas += '<section class="region los"><div class="region-title"><span class="dot"></span>Losers bracket</div>' +
        '<div class="rounds">' + lCols + '</div></section>';
    }

    if (groups.GF.length) {
      var gf = groups.GF.slice().sort(function (x, y) {
        return (x.matchLabel || '').localeCompare(y.matchLabel || '');
      });
      var cards = gf.map(function (m) { return bracketCard(m, {}, originsOf(m)); }).join('');
      var cond = '<div class="cond">GF2 played only if the losers champ wins GF1 (bracket reset).</div>';
      var finalGF = gf[gf.length - 1];
      var champId = (finalGF && finalGF.winnerEntrantId) || null;
      var tourneyDone = state.tState === 'completed';
      var champName = (champId && (tourneyDone || (finalGF && finalGF.state === 'completed'))) ? esc(nm(champId)) : 'TBD';
      canvas += '<section class="region gf"><div class="region-title"><span class="dot"></span>Grand final</div>' +
        '<div class="rounds">' +
        '<div class="round"><div class="round-head">Grand final</div>' + cards + cond + '</div>' +
        '<div class="round"><div class="round-head">Champion</div>' +
        '<div class="champ"><div class="trophy">🏆</div><div class="cap">Champion</div>' +
        '<div class="who2">' + champName + '</div></div></div>' +
        '</div></section>';
    }

    return '<div class="bracket"><div class="scroller"><div class="canvas">' + canvas + '</div></div></div>';
  }

  function render() {
    var html = renderBracket();
    if (!html) { standby('Standing by…'); return; }
    appEl.innerHTML = html;
  }

  // ---- data ----
  async function refresh() {
    try {
      var ents = (await api.listEntrants(state.cid, { archived: true })).items || [];
      state.names = {}; state.seeds = {};
      ents.forEach(function (e) {
        state.names[e.id] = e.displayName;
        if (e.seed != null) state.seeds[e.id] = e.seed;
      });
      state.matches = (await api.listMatches(state.cid)).items || [];
      render();
    } catch (e) {
      // keep the last good frame rather than white-screening; only show standby if empty
      if (!state.matches.length) standby('Standing by…');
    }
  }

  function openSSE() {
    if (state.es) { try { state.es.close(); } catch (e) {} state.es = null; }
    try {
      state.es = api.events(state.cid);
      var reload = debounce(refresh, 400);
      state.es.onmessage = reload;
      state.es.addEventListener('snapshot_required', reload);
    } catch (e) { /* SSE optional — poll fallback still runs */ }
  }

  async function boot() {
    var t = new URLSearchParams(location.search).get('t');
    if (!t) { standby('Add ?t=<tournament> to the URL'); return; }
    standby('Standing by…');
    try {
      var got = await api.getTournament(t);
      state.cid = got.tournament.id;
      state.tState = got.tournament.state || '';
    } catch (e) {
      standby('Tournament not found');
      return;
    }
    await refresh();
    openSSE();
    // 5s polling fallback in case SSE drops or is unavailable.
    setInterval(function () { refresh(); }, 5000);
  }

  try { boot(); } catch (e) { standby('Standing by…'); }
})();
