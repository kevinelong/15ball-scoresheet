/* live.js — Columbia Cue Club Live Console.
 * A self-contained mobile-first SPA over the /api/v1 backend (via api-client.js):
 * magic-link sign-in, cloud tournaments, entrants (with SMS opt-in), start a
 * double-elimination bracket, and score matches live (SSE). Additive — does not
 * touch app.js/bracket.js/tables.js.
 */
(function () {
  'use strict';
  var api = FB.createClient();
  var DIRECTOR = ['tournament_director', 'club_admin', 'system_admin'];

  var state = { view: 'boot', me: null, public: false, tournaments: [], t: null, roster: [], names: {}, matches: [], es: null, err: '' };

  // Canonical disciplines (id -> display name); mirrors the backend validGames set.
  var GAMES = [
    ['15ball_rotation', '15-Ball Rotation'],
    ['8ball', '8-Ball'],
    ['9ball', '9-Ball'],
    ['10ball', '10-Ball'],
    ['straight_14_1', 'Straight Pool (14.1)'],
    ['bank_pool', 'Bank Pool'],
    ['one_pocket', 'One Pocket']
  ];
  var GAME_LABELS = {};
  GAMES.forEach(function (g) { GAME_LABELS[g[0]] = g[1]; });
  function gameLabel(id) { return id ? (GAME_LABELS[id] || id) : ''; }
  function venueClub(t) { var p = []; if (t.club) p.push(t.club); if (t.venue) p.push(t.venue); return p.join(' · '); }
  // create → register → check in (shared by single and bulk add)
  async function addEntrantChecked(body) {
    var r = await api.createEntrant(state.t.id, body);
    var eid = r.entrant.id;
    await api.patchEntrant(state.t.id, eid, { state: 'registered' });
    await api.checkInEntrant(state.t.id, eid);
  }
  function gameOptions(sel) {
    return GAMES.map(function (g) {
      return '<option value="' + esc(g[0]) + '"' + (g[0] === sel ? ' selected' : '') + '>' + esc(g[1]) + '</option>';
    }).join('');
  }

  var appEl = document.getElementById('app');
  var whoEl = document.getElementById('who');
  var toastEl = document.getElementById('toast');

  // ---- helpers ----
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function isDirector() { return !!(state.me && state.me.roles && state.me.roles.some(function (r) { return DIRECTOR.indexOf(r) >= 0; })); }
  function canScore() { return state.public || isDirector(); } // open link OR signed-in director
  var toastT;
  function toast(msg) { toastEl.textContent = msg; toastEl.hidden = false; clearTimeout(toastT); toastT = setTimeout(function () { toastEl.hidden = true; }, 2600); }
  function val(id) { var e = document.getElementById(id); return e ? e.value.trim() : ''; }
  function checked(id) { var e = document.getElementById(id); return !!(e && e.checked); }
  async function guard(fn) { try { await fn(); } catch (e) { toast(e && e.message ? e.message : 'error'); } }

  // ---- boot / auth ----
  async function boot() {
    try {
      state.me = await api.me();
      whoEl.textContent = state.me.email + (state.me.roles && state.me.roles.length ? ' · ' + state.me.roles.join(', ') : '');
      await openHome();
    } catch (e) {
      whoEl.textContent = '';
      renderAuth(e && e.status === 401 ? '' : (e.message || ''));
    }
  }

  function renderAuth(err) {
    state.view = 'auth';
    appEl.innerHTML =
      '<div class="card"><h2>Sign in</h2>' +
      '<p class="note">Enter your email and we\'ll send a one-time sign-in link. After you tap it, come back here and press Continue.</p>' +
      (err ? '<div class="err">' + esc(err) + '</div>' : '') +
      '<label>Email</label><input id="email" type="email" inputmode="email" autocomplete="email" placeholder="you@club.test" />' +
      '<div class="spacer"></div>' +
      '<div class="row"><button class="pri" data-action="request-link">Send sign-in link</button>' +
      '<button class="ghost" data-action="continue">Continue</button></div></div>';
  }

  // ---- home / tournaments ----
  async function openHome() {
    state.t = null; closeSSE();
    var resp = await api.listTournaments();
    state.tournaments = resp.items || [];
    state.view = 'home';
    var html = '<div class="card"><h2>Tournaments</h2>';
    if (isDirector()) {
      html += '<input id="tname" placeholder="New tournament name" />' +
        '<div class="spacer"></div>' +
        '<div class="row"><select id="tgame">' + gameOptions('15ball_rotation') + '</select></div>' +
        '<div class="row"><input id="tvenue" placeholder="Venue (optional)" /><input id="tclub" placeholder="Club (optional)" /></div>' +
        '<div class="spacer"></div><button class="pri" data-action="create-tournament">Create</button><div class="spacer"></div>';
    }
    if (!state.tournaments.length) {
      html += '<p class="muted">No tournaments yet.</p>';
    } else {
      html += '<ul class="list">' + state.tournaments.map(function (t) {
        return '<li><span class="vs"><b>' + esc(t.name) + '</b>' +
          (venueClub(t) ? '<div class="note">' + esc(venueClub(t)) + '</div>' : '') + '</span>' +
          '<span class="pill">' + esc(gameLabel(t.game)) + '</span>' +
          '<span class="pill">' + esc(t.state) + '</span>' +
          '<button data-action="open-t" data-id="' + esc(t.id) + '">Open</button></li>';
      }).join('') + '</ul>';
    }
    html += '</div>';
    appEl.innerHTML = html;
  }

  // ---- tournament detail ----
  async function openTournament(idOrSlug) {
    closeSSE();
    var got = await api.getTournament(idOrSlug);
    state.t = got.tournament;
    var cid = state.t.id; // canonical id for all subsequent calls (idOrSlug may be a slug)
    var all = (await api.listEntrants(cid, { archived: true })).items || [];
    state.names = {}; all.forEach(function (e) { state.names[e.id] = e.displayName; });
    state.roster = all.filter(function (e) { return !e.archivedAt; });
    state.matches = (state.t.state === 'in_progress' || state.t.state === 'completed') ? ((await api.listMatches(cid)).items || []) : [];
    state.view = 'tournament';
    renderTournament();
    paintQR();
    if (state.t.state === 'in_progress') openSSE(cid);
  }

  // Shareable scoring link uses the memorable slug (backend resolves slug or id).
  function scoringLink() {
    return location.origin + location.pathname + '?t=' + encodeURIComponent(state.t.slug || state.t.id);
  }
  // Paint the QR into #qrbox after innerHTML is set (director view only).
  function paintQR() {
    var box = document.getElementById('qrbox');
    if (!box || typeof QRCode === 'undefined') return;
    box.innerHTML = '';
    try { new QRCode(box, { text: scoringLink(), width: 148, height: 148, correctLevel: QRCode.CorrectLevel.M }); } catch (e) {}
  }

  function renderTournament() {
    var t = state.t, dir = isDirector();
    var h = '<div class="card"><div class="row"><h2 style="flex:1">' + esc(t.name) + '</h2>' +
      '<span class="pill">' + esc(gameLabel(t.game)) + '</span>' +
      '<span class="pill">' + esc(t.state) + '</span></div>' +
      (venueClub(t) ? '<div class="note">' + esc(venueClub(t)) + '</div>' : '') +
      (state.public ? '' : '<button class="ghost" data-action="home">‹ All tournaments</button>') + '</div>';
    if (state.public) h += '<div class="card note">Open scoring — anyone with this link can record match results.</div>';

    if (state.public && t.state !== 'in_progress' && t.state !== 'completed') {
      appEl.innerHTML = h + '<div class="card"><p class="muted">This tournament hasn\'t started yet.</p></div>';
      return;
    }
    if (t.state === 'draft' || t.state === 'registration_open' || t.state === 'registration_closed') {
      h += renderEntrants(dir);
      if (dir) h += renderStageControls(t.state);
    } else if (t.state === 'in_progress') {
      h += renderMatches(dir);
    } else if (t.state === 'completed') {
      h += '<div class="card"><h2>Final bracket</h2>' + matchesMarkup(false) + '</div>';
    }
    appEl.innerHTML = h;
  }

  function renderStageControls(stateName) {
    var h = '<div class="card"><h3>Run control</h3>';
    if (stateName === 'draft') h += '<button class="pri" data-action="open-reg">Open registration</button>';
    if (stateName === 'registration_open') h += '<button class="pri" data-action="close-reg">Close registration</button>';
    if (stateName === 'registration_closed') h += '<button class="pri" data-action="start">Start tournament (double-elim)</button>';
    var checked = state.roster.filter(function (e) { return e.state === 'checked_in'; }).length;
    h += '<p class="note">' + checked + ' checked in · need ≥ 2 to start.</p></div>';
    return h;
  }

  function renderEntrants(dir) {
    var h = '<div class="card"><h2>Entrants</h2>';
    if (dir) {
      h += '<label>Name</label><input id="en" placeholder="Player name" />' +
        '<div class="row"><div><label>Mobile (optional)</label><input id="ephone" type="tel" inputmode="tel" placeholder="+1503…" /></div></div>' +
        '<label><input id="eopt" type="checkbox" />Send match-ready SMS (player consented)</label>' +
        '<div class="spacer"></div><button class="pri" data-action="add-entrant">Add &amp; check in</button>' +
        '<div class="spacer"></div><label>Or paste a list — one player per line</label>' +
        '<textarea id="ebulk" rows="4" placeholder="Jane Doe, 512, 503-369-9277, jane@x.com&#10;John Smith (487)&#10;Kim Lee"></textarea>' +
        '<div class="note">Detects email, phone (7/10/11 digits), a 3-digit Fargo (seeds the bracket), and other numbers as an id. Blank lines skipped.</div>' +
        '<label><input id="ebulkopt" type="checkbox" />These players consented to match-ready SMS</label>' +
        '<div class="spacer"></div><button class="pri" data-action="add-bulk">Add all &amp; check in</button><div class="spacer"></div>';
    }
    if (!state.roster.length) h += '<p class="muted">No entrants yet.</p>';
    else h += '<ul class="list">' + state.roster.map(function (e) {
      return '<li><span class="vs"><b>' + esc(e.displayName) + '</b>' +
        (e.fargo != null ? ' <span class="note">Fargo ' + esc(e.fargo) + '</span>' : '') +
        (e.phone ? ' <span class="note">' + esc(e.phone) + (e.notifyOptIn ? ' ✓sms' : '') + '</span>' : '') +
        '</span><span class="pill">' + esc(e.state) + '</span></li>';
    }).join('') + '</ul>';
    return h + '</div>';
  }

  // ---- matches ----
  function bracketName(b) { return b === 'W' ? 'Winners' : b === 'L' ? 'Losers' : b === 'GF' ? 'Grand Final' : 'Bracket'; }
  function nm(id) { return id ? (state.names[id] || '…') : '—'; }

  function matchesMarkup(interactive) {
    if (!state.matches.length) return '<p class="muted">No matches.</p>';
    var groups = { W: [], L: [], GF: [], single: [] };
    state.matches.forEach(function (m) { (groups[m.bracket] || groups.single).push(m); });
    var order = ['W', 'L', 'GF', 'single'];
    var out = '';
    order.forEach(function (b) {
      var list = groups[b]; if (!list.length) return;
      if (b !== 'single') out += '<h3>' + bracketName(b) + '</h3>';
      list.forEach(function (m) { out += matchRow(m, interactive); });
    });
    return out;
  }

  function matchRow(m, interactive) {
    var a = m.entrantAId, b = m.entrantBId;
    var lbl = m.matchLabel || ('R' + m.bracketRound + '·' + (m.slot + 1));
    var ready = a && b && (m.state === 'scheduled' || m.state === 'assigned' || m.state === 'reopened');
    var line = '<div class="match"><span class="lbl">' + esc(lbl) + '</span><span class="vs">';
    if (m.state === 'completed') {
      line += '<b>' + esc(nm(a)) + '</b> vs <b>' + esc(nm(b)) + '</b> <span class="pill state">done</span>';
      line += '</span></div>';
      return line;
    }
    line += '<b>' + esc(nm(a)) + '</b> <span class="muted">vs</span> <b>' + esc(nm(b)) + '</b></span>';
    if (interactive && ready) {
      line += '<button class="win" data-action="win" data-m="' + esc(m.id) + '" data-w="' + esc(a) + '" data-l="' + esc(b) + '">' + esc(shortName(a)) + '</button>';
      line += '<button class="win" data-action="win" data-m="' + esc(m.id) + '" data-w="' + esc(b) + '" data-l="' + esc(a) + '">' + esc(shortName(b)) + '</button>';
    } else {
      line += '<span class="pill state">' + esc(m.state) + '</span>';
    }
    return line + '</div>';
  }
  function shortName(id) { var s = nm(id); return s.length > 10 ? s.slice(0, 9) + '…' : s; }

  function renderMatches(dir) {
    var h = '';
    if (dir) {
      h += '<div class="card"><h3>Scan to score</h3>' +
        '<div class="qrwrap"><div id="qrbox" class="qr"></div>' +
        '<div class="lnk"><div>Players scan this, or open:</div><div><b>' + esc(scoringLink()) + '</b></div>' +
        '<div class="spacer"></div><button data-action="copy-link" class="ghost">Copy link</button></div></div></div>';
    }
    h += '<div class="card"><div class="row"><h2 style="flex:1">Matches</h2>';
    if (dir) h += '<button data-action="complete" class="ghost" style="flex:0 0 auto">Complete</button>';
    h += '</div>';
    h += '<p class="note">Tap a player to record them as the winner.' + (canScore() ? '' : ' (Sign in to score.)') + '</p>';
    h += matchesMarkup(canScore());
    return h + '</div>';
  }

  // ---- SSE live refresh ----
  function openSSE(id) {
    closeSSE();
    try {
      state.es = api.events(id);
      var reload = debounce(function () { if (state.t && state.t.id === id) guard(function () { return openTournament(id); }); }, 400);
      state.es.onmessage = reload;
      state.es.addEventListener('snapshot_required', reload);
    } catch (e) { /* SSE optional */ }
  }
  function closeSSE() { if (state.es) { try { state.es.close(); } catch (e) {} state.es = null; } }
  function debounce(fn, ms) { var t; return function () { clearTimeout(t); t = setTimeout(fn, ms); }; }

  // ---- actions ----
  document.addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-action]'); if (!b) return;
    var act = b.getAttribute('data-action');
    var id = b.getAttribute('data-id');
    if (act === 'request-link') return guard(async function () {
      var email = val('email'); if (!email) return toast('Enter your email');
      await api.requestLink(email); toast('Link sent — tap it, then press Continue');
    });
    if (act === 'continue') return guard(boot);
    if (act === 'home') return guard(openHome);
    if (act === 'open-t') return guard(function () { return openTournament(id); });
    if (act === 'create-tournament') return guard(async function () {
      var name = val('tname'); if (!name) return toast('Enter a name');
      var r = await api.createTournament({ name: name, game: val('tgame') || '15ball_rotation', venue: val('tvenue'), club: val('tclub') }); await openTournament(r.tournament.id);
    });
    if (act === 'add-entrant') return guard(async function () {
      var name = val('en'); if (!name) return toast('Enter a name');
      var body = { displayName: name };
      var ph = val('ephone'); if (ph) { body.phone = ph; body.notifyOptIn = checked('eopt'); }
      await addEntrantChecked(body);
      await openTournament(state.t.id);
    });
    if (act === 'add-bulk') return guard(async function () {
      var list = Roster.parse(val('ebulk'));
      if (!list.length) return toast('Nothing to add');
      var consent = checked('ebulkopt');
      var added = 0, dupes = 0;
      for (var i = 0; i < list.length; i++) {
        var p = list[i];
        var body = { displayName: p.name };
        if (p.phone) { body.phone = p.phone; body.notifyOptIn = consent; }
        if (p.email) body.email = p.email;
        if (p.fargo != null) body.fargo = p.fargo;
        if (p.externalId) body.externalId = p.externalId;
        try { await addEntrantChecked(body); added++; }
        catch (e) { if (e.code === 'duplicate_display_name') dupes++; else throw e; }
      }
      toast('Added ' + added + (dupes ? ' · ' + dupes + ' duplicate' + (dupes > 1 ? 's' : '') + ' skipped' : ''));
      await openTournament(state.t.id);
    });
    if (act === 'open-reg') return guard(async function () {
      var divs = (await api.listDivisions(state.t.id)).items || [];
      if (!divs.length) await api.createDivision(state.t.id, { name: 'Open' }); // double_elimination default
      await api.patchTournament(state.t.id, { state: 'registration_open' });
      await openTournament(state.t.id);
    });
    if (act === 'close-reg') return guard(async function () {
      await api.patchTournament(state.t.id, { state: 'registration_closed' }); await openTournament(state.t.id);
    });
    if (act === 'start') return guard(async function () {
      await api.patchTournament(state.t.id, { state: 'in_progress' }); await openTournament(state.t.id);
    });
    if (act === 'complete') return guard(async function () {
      await api.patchTournament(state.t.id, { state: 'completed' }); await openTournament(state.t.id);
    });
    if (act === 'copy-link') return guard(async function () {
      var link = scoringLink();
      try { await navigator.clipboard.writeText(link); toast('Scoring link copied'); }
      catch (e) { toast(link); }
    });
    if (act === 'win') return guard(async function () {
      var mid = b.getAttribute('data-m'), w = b.getAttribute('data-w'), l = b.getAttribute('data-l');
      // assign → start → submit result. Assign/start are best-effort so an already-
      // assigned/in-progress match still scores. Scorekeeper is set only when signed in
      // (open scoring links have no user; the backend allows an empty scorekeeper).
      var opts = state.me ? { scorekeeperUserId: state.me.userId } : {};
      var ignore409 = function (e) { if (e.status !== 409) throw e; };
      try { await api.assignMatch(state.t.id, mid, opts); } catch (e) { ignore409(e); }
      try { await api.startMatch(state.t.id, mid); } catch (e) { ignore409(e); }
      await api.submitResult(state.t.id, mid, { winnerEntrantId: w, loserEntrantId: l });
      toast('Recorded');
      await openTournament(state.t.id);
    });
  });

  // A ?t=<id> link opens a public scoring board (no sign-in); otherwise normal boot.
  function init() {
    var pt = new URLSearchParams(location.search).get('t');
    if (pt) { state.public = true; whoEl.textContent = 'Open scoring'; return guard(function () { return openTournament(pt); }); }
    boot();
  }
  init();
})();
