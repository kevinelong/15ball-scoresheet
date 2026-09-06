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

  var state = { view: 'boot', me: null, public: false, tournaments: [], t: null, roster: [], names: {}, matches: [], es: null, err: '', preview: null, editEntrant: null, pendingAdd: null, dupes: null, venues: [], newVenue: false, selVenue: '', newName: '', newClub: '', recent: null, dupePairs: null };

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
  // Venue picker for the create-tournament form: a <select id="tvenue"> of the
  // organizer's saved venues plus a "＋ New venue" option that reveals name/address
  // inputs. selId keeps the chosen venue selected across re-renders.
  function venuePickerMarkup(selId) {
    var opts = '<option value="">No venue</option>' +
      (state.venues || []).map(function (v) {
        return '<option value="' + esc(v.id) + '"' + (v.id === selId ? ' selected' : '') + '>' + esc(v.name) + '</option>';
      }).join('') +
      '<option value="__new__"' + (state.newVenue ? ' selected' : '') + '>＋ New venue</option>';
    var h = '<div class="row"><select id="tvenue">' + opts + '</select></div>';
    if (state.newVenue) {
      h += '<div class="row"><input id="tvenuename" placeholder="Venue name" /></div>' +
        '<div class="row"><input id="tvenueaddr" placeholder="Address (auto-located, optional)" /></div>' +
        '<div class="spacer"></div><div class="row"><button class="ghost" data-action="add-venue">Add venue</button></div>';
    }
    return h;
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

  // ---- dedup confidence tiers (shared by single-add, bulk, and merge) ----
  // STRONG (default = LINK): exact phone/email match, or a very-high fuzzy name score.
  // POSSIBLE (default = NEW, offer link, mark "review"): a fuzzy name-only match.
  function tierOf(item) {
    if (!item) return 'possible';
    if (item.matchReason === 'phone' || item.matchReason === 'email') return 'strong';
    if ((item.score || 0) >= 0.90) return 'strong';
    return 'possible';
  }
  // Short reason chip label for a candidate.
  function reasonChip(item) {
    if (!item) return '';
    if (item.matchReason === 'phone') return 'same phone';
    if (item.matchReason === 'email') return 'same email';
    return 'similar name';
  }
  // Mask a phone to just the last 4 digits, e.g. "•••‑0123".
  function maskPhone(p) {
    var d = String(p || '').replace(/\D/g, '');
    if (!d) return '';
    return '•••‑' + d.slice(-4);
  }
  // Mask an email: first char + "•••@" + domain, e.g. "j•••@x.com".
  function maskEmail(e) {
    e = String(e || '');
    var at = e.indexOf('@');
    if (at < 1) return e ? (e.charAt(0) + '•••') : '';
    return e.charAt(0) + '•••@' + e.slice(at + 1);
  }
  // Compact context string for a candidate item.
  function ctxLine(item) {
    var n = item.pastEntries || 0;
    var s = n + ' event' + (n === 1 ? '' : 's');
    if (item.lastEvent) s += ' · last: ' + item.lastEvent;
    if (item.fargo != null && item.fargo !== '') s += ' · Fargo ' + item.fargo;
    if (item.phone) s += ' · ' + maskPhone(item.phone);
    else if (item.email) s += ' · ' + maskEmail(item.email);
    return s;
  }
  // Sort candidates strong-first, then by score desc.
  function sortCandidates(list) {
    return list.slice().sort(function (a, b) {
      var ta = tierOf(a) === 'strong' ? 0 : 1, tb = tierOf(b) === 'strong' ? 0 : 1;
      if (ta !== tb) return ta - tb;
      return (b.score || 0) - (a.score || 0);
    });
  }

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
    if (isDirector()) {
      try { state.venues = (await api.listVenues()).items || []; }
      catch (e) { state.venues = []; } // venue list is best-effort — plain create still works
    }
    state.newVenue = false;      // reset the "＋ New venue" reveal each time home opens
    state.selVenue = '';         // reset the chosen venue
    state.newName = '';          // draft tournament name preserved across venue re-renders
    state.newClub = '';
    renderHome();
  }

  // renderHome (re)paints the home card from current state without refetching, so
  // toggling the venue picker keeps the list + typed values.
  function renderHome() {
    // capture any in-progress typing before we replace the DOM
    if (document.getElementById('tname')) state.newName = val('tname');
    if (document.getElementById('tclub')) state.newClub = val('tclub');
    state.view = 'home';
    var html = '<div class="card"><h2>Tournaments</h2>';
    if (isDirector()) {
      html += '<input id="tname" placeholder="New tournament name" value="' + esc(state.newName || '') + '" />' +
        '<div class="spacer"></div>' +
        '<div class="row"><select id="tgame">' + gameOptions('15ball_rotation') + '</select></div>' +
        venuePickerMarkup(state.selVenue) +
        '<div class="row"><input id="tclub" placeholder="Club (optional)" value="' + esc(state.newClub || '') + '" /></div>' +
        '<div class="spacer"></div><button class="pri" data-action="create-tournament">Create</button><div class="spacer"></div>' +
        '<div class="row"><button class="ghost" data-action="dupes-review">Review duplicate players</button></div><div class="spacer"></div>';
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

  // The selected venue id, or '' — treats the "＋ New venue" sentinel as none.
  function venueSelectValue() {
    var v = val('tvenue');
    return (v && v !== '__new__') ? v : '';
  }

  // ---- organizer-wide duplicate-player review (proactive) ----
  async function openDuplicates() {
    state.t = null; closeSSE();
    state.view = 'duplicates';
    state.dupePairs = null;
    renderDuplicates(); // paint a loading shell first
    try {
      var resp = await api.duplicatePlayers();
      state.dupePairs = (resp && resp.pairs) || [];
    } catch (e) {
      state.dupePairs = [];
      toast(e && e.message ? e.message : 'error');
    }
    renderDuplicates();
  }

  // One side of a duplicate pair, rendered as a labeled compare column feeder.
  function dupeSide(item) {
    var n = (item && item.pastEntries) || 0;
    return {
      name: (item && item.displayName) || '',
      phone: maskPhone(item && item.phone),
      email: maskEmail(item && item.email),
      fargo: (item && item.fargo != null && item.fargo !== '') ? String(item.fargo) : '',
      events: n + ' event' + (n === 1 ? '' : 's'),
      last: (item && item.lastEvent) || ''
    };
  }

  // Reason chip label from a pair's reason ("phone"|"email"|"name").
  function pairReasonChip(reason) {
    if (reason === 'phone') return 'same phone';
    if (reason === 'email') return 'same email';
    return 'similar name';
  }

  function dupePairCard(pr) {
    var A = pr.a || {}, B = pr.b || {};
    var sa = dupeSide(A), sb = dupeSide(B);
    var strong = (pr.reason === 'phone' || pr.reason === 'email');
    var head = '<div class="cmprow cmphead"><span class="cmplbl"></span>' +
      '<span class="cmpv">' + esc(sa.name || '—') + '</span>' +
      '<span class="cmpv">' + esc(sb.name || '—') + '</span></div>';
    return '<li><div class="vs" style="flex:1">' +
      '<span class="pill' + (strong ? '' : ' warn') + '">' + esc(pairReasonChip(pr.reason)) + '</span>' +
      '<div class="cmp">' + head +
      cmpRow('Phone', sa.phone, sb.phone) +
      cmpRow('Email', sa.email, sb.email) +
      cmpRow('Fargo', sa.fargo, sb.fargo) +
      cmpRow('Events', sa.events, sb.events) +
      cmpRow('Last event', sa.last, sb.last) +
      '</div>' +
      '<div class="spacer"></div>' +
      '<div class="row">' +
      '<button class="pri" data-action="dupe-mergeinto" data-into="' + esc(A.playerId) + '" data-src="' + esc(B.playerId) + '">Keep ' + esc(sa.name) + '</button>' +
      '<button class="pri" data-action="dupe-mergeinto" data-into="' + esc(B.playerId) + '" data-src="' + esc(A.playerId) + '">Keep ' + esc(sb.name) + '</button>' +
      '</div>' +
      '<div class="row"><button class="ghost" data-action="dupe-dismiss" data-a="' + esc(A.playerId) + '" data-b="' + esc(B.playerId) + '">Not duplicates</button></div>' +
      '</div></li>';
  }

  function renderDuplicates() {
    var html = '<div class="card">' +
      '<div class="row"><button class="ghost" data-action="home">‹ All tournaments</button></div>' +
      '<h2>Review duplicate players</h2>';
    if (state.dupePairs == null) {
      html += '<p class="muted">Scanning…</p>';
    } else if (!state.dupePairs.length) {
      html += '<p class="muted">No likely duplicates 🎉</p>';
    } else {
      html += '<p class="note">These players look like the same person. Keep one (merging the other into it) or mark them as different people.</p>';
      html += '<ul class="list dupelist">' + state.dupePairs.map(dupePairCard).join('') + '</ul>';
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
    // Recent players at this venue (director + tournament linked to a venue).
    state.recent = null;
    if (isDirector() && state.t.venueId) {
      try { state.recent = (await api.recentPlayers(cid)).items || []; }
      catch (e) { state.recent = null; } // best-effort — section just hides on error
    }
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
      h += '<div class="card"><h2>Final bracket</h2>' + renderBracket(false) + '</div>';
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

  // Scan the parsed list for in-paste duplicates (display-only warning). Returns per-row
  // flags {name,phone,email} and total counts. Case-insensitive name, E.164 phone, lc email.
  function findDupes(list) {
    var nameSeen = {}, phoneSeen = {}, emailSeen = {};
    list.forEach(function (p) {
      var nk = (p.name || '').trim().toLowerCase();
      if (nk) nameSeen[nk] = (nameSeen[nk] || 0) + 1;
      var pk = p.phone ? Roster.e164(p.phone) : '';
      if (pk) phoneSeen[pk] = (phoneSeen[pk] || 0) + 1;
      var ek = (p.email || '').trim().toLowerCase();
      if (ek) emailSeen[ek] = (emailSeen[ek] || 0) + 1;
    });
    var flags = list.map(function (p) {
      var nk = (p.name || '').trim().toLowerCase();
      var pk = p.phone ? Roster.e164(p.phone) : '';
      var ek = (p.email || '').trim().toLowerCase();
      return {
        name: !!(nk && nameSeen[nk] > 1),
        phone: !!(pk && phoneSeen[pk] > 1),
        email: !!(ek && emailSeen[ek] > 1)
      };
    });
    function distinctDupes(seen) { var c = 0; for (var k in seen) if (seen[k] > 1) c++; return c; }
    return { flags: flags, names: distinctDupes(nameSeen), phones: distinctDupes(phoneSeen), emails: distinctDupes(emailSeen) };
  }

  // The per-row match control for the bulk preview: a <select> whose value is the
  // chosen playerId ('' = New person). Options list the candidates strong-first.
  function matchControl(pv, i) {
    var cands = (pv.matches && pv.matches[i]) || [];
    if (!cands.length) return '<span class="note">New</span>';
    var chosen = (pv.choice && pv.choice[i]) || '';
    var opts = cands.map(function (c) {
      var n = c.pastEntries || 0;
      var label = 'Link → ' + c.displayName + ' (' + n + ' ev)';
      return '<option value="' + esc(c.playerId) + '"' + (c.playerId === chosen ? ' selected' : '') + '>' + esc(label) + '</option>';
    }).join('');
    opts += '<option value=""' + (chosen ? '' : ' selected') + '>New person</option>';
    return '<select class="bulkchoose" data-row="' + i + '">' + opts + '</select>';
  }
  // Preview table for parsed bulk rows (Feature B), with in-paste duplicate flags and
  // per-row cross-event dedup controls.
  function previewMarkup(pv) {
    var dup = findDupes(pv.list);
    var linked = 0, review = 0, newc = 0;
    var rows = pv.list.map(function (p, i) {
      var f = dup.flags[i];
      var warn = [];
      if (f.name) warn.push('duplicate name');
      if (f.phone) warn.push('duplicate phone');
      if (f.email) warn.push('duplicate email');
      var chosen = (pv.choice && pv.choice[i]) || '';
      var cands = (pv.matches && pv.matches[i]) || [];
      var isReview = !chosen && cands.length && tierOf(cands[0]) === 'possible';
      if (chosen) linked++; else if (isReview) review++; else newc++;
      return '<div class="prow' + (warn.length ? ' dupe' : '') + (isReview ? ' review' : '') + '">' +
        '<b>' + esc(p.name) + (warn.length ? ' <span class="pill warn">' + esc(warn.join(' · ')) + '</span>' : '') + '</b>' +
        '<span class="note">' + (p.fargo != null ? 'Fargo ' + esc(p.fargo) : '') + '</span>' +
        '<span class="note">' + (p.phone ? esc(Roster.e164(p.phone)) : '') + '</span>' +
        '<span class="note">' + (p.email ? esc(p.email) : '') + '</span>' +
        '<span class="mcell">' + matchControl(pv, i) + '</span>' +
        '</div>';
    }).join('');
    var n = pv.list.length;
    var skipped = pv.rawLines - n; if (skipped < 0) skipped = 0;
    var dupParts = [];
    if (dup.names) dupParts.push(dup.names + ' duplicate name' + (dup.names > 1 ? 's' : ''));
    if (dup.phones) dupParts.push(dup.phones + ' duplicate phone' + (dup.phones > 1 ? 's' : ''));
    if (dup.emails) dupParts.push(dup.emails + ' duplicate email' + (dup.emails > 1 ? 's' : ''));
    var dupLine = dupParts.length ? '<p class="note warn">⚠ ' + esc(dupParts.join(' · ')) + ' in this list — duplicates by name are skipped on add.</p>' : '';
    var summary = '<p class="note"><b>' + linked + ' linked · ' + newc + ' new · ' + review + ' to review</b></p>';
    return summary +
      '<div class="preview">' +
      '<div class="prow phead"><b>Name</b><span>Fargo</span><span>Phone</span><span>Email</span><span>Match</span></div>' +
      rows + '</div>' +
      dupLine +
      '<p class="note">' + n + ' player' + (n === 1 ? '' : 's') + ' ready · ' + skipped + ' line' + (skipped === 1 ? '' : 's') + ' skipped</p>' +
      '<div class="spacer"></div>' +
      '<div class="row"><button class="pri" data-action="bulk-confirm">Confirm — add ' + n + ' &amp; check in</button>' +
      '<button class="ghost" data-action="bulk-cancel">Back</button></div>';
  }

  // Feature A: "Is this the same person?" confirm panel shown before a single add.
  // Candidates are shown strong-first, each with a context line + a reason chip. When
  // the top candidate is STRONG, "Same person" is the primary choice; otherwise
  // "New person" stays primary and the panel is labelled a possible match.
  function pendingAddMarkup(pa) {
    var cands = sortCandidates(pa.candidates);
    var topStrong = cands.length && tierOf(cands[0]) === 'strong';
    var rows = cands.map(function (c) {
      var strong = tierOf(c) === 'strong';
      return '<li><span class="vs"><b>' + esc(c.displayName) + '</b> ' +
        '<span class="pill' + (strong ? '' : ' warn') + '">' + esc(reasonChip(c)) + '</span>' +
        '<div class="note">' + esc(ctxLine(c)) + '</div></span>' +
        '<button class="' + (strong ? 'pri' : 'ghost') + '" data-action="add-link" data-pid="' + esc(c.playerId) + '">Same person</button></li>';
    }).join('');
    return '<div class="confirm"><h3>' + (topStrong ? 'Likely the same person' : 'Possible match') + '</h3>' +
      '<p class="note">Adding <b>' + esc(pa.body.displayName) + '</b>. We found ' + cands.length +
      ' player' + (cands.length === 1 ? '' : 's') + ' who may be the same person.</p>' +
      '<ul class="list">' + rows + '</ul>' +
      '<div class="spacer"></div>' +
      '<div class="row"><button class="' + (topStrong ? 'ghost' : 'pri') + '" data-action="add-new">New person</button>' +
      '<button class="ghost" data-action="add-cancel">Cancel</button></div></div>';
  }

  // Feature C: side-by-side compare of one field between the current entrant and a
  // candidate duplicate. Highlights when the two values differ.
  function cmpRow(label, thisVal, otherVal) {
    var a = thisVal == null ? '' : String(thisVal);
    var o = otherVal == null ? '' : String(otherVal);
    var diff = a !== o;
    return '<div class="cmprow' + (diff ? ' cmpdiff' : '') + '">' +
      '<span class="cmplbl">' + esc(label) + '</span>' +
      '<span class="cmpv">' + (a ? esc(a) : '—') + '</span>' +
      '<span class="cmpv">' + (o ? esc(o) : '—') + '</span></div>';
  }
  // Feature B/C: duplicate-player candidates for the entrant being edited, each shown
  // as a compact side-by-side compare against the current entrant.
  function dupesMarkup(d) {
    if (!d.candidates.length) return '<div class="note warn">No duplicates found.</div>';
    var self = d.entrant || {};
    var rows = sortCandidates(d.candidates).map(function (c) {
      var n = c.pastEntries || 0;
      var moveNote = '≈' + n + ' past entr' + (n === 1 ? 'y' : 'ies') + ' will move onto this player.';
      return '<li><div class="vs" style="flex:1">' +
        '<b>' + esc(c.displayName) + '</b> <span class="pill' + (tierOf(c) === 'strong' ? '' : ' warn') + '">' + esc(reasonChip(c)) + '</span>' +
        '<div class="cmp">' +
        '<div class="cmprow cmphead"><span class="cmplbl"></span><span class="cmpv">This entrant</span><span class="cmpv">Duplicate</span></div>' +
        cmpRow('Name', self.displayName, c.displayName) +
        cmpRow('Phone', maskPhone(self.phone), maskPhone(c.phone)) +
        cmpRow('Email', maskEmail(self.email), maskEmail(c.email)) +
        cmpRow('Fargo', self.fargo, c.fargo) +
        cmpRow('Past events', self.pastEntries, c.pastEntries) +
        '</div>' +
        '<div class="note">' + esc(moveNote) + '</div>' +
        '<div class="spacer"></div>' +
        '<button class="pri" data-action="entrant-merge" data-src="' + esc(c.playerId) +
        '" data-into="' + esc(d.intoId) + '">Merge into this player</button>' +
        '</div></li>';
    }).join('');
    return '<div class="confirm"><h4>Possible duplicates</h4>' +
      '<p class="note">Merging keeps this entrant\'s player and absorbs the duplicate.</p>' +
      '<ul class="list">' + rows + '</ul></div>';
  }

  // Inline edit form for one roster entrant (Feature B).
  function editEntrantMarkup(e) {
    return '<li class="editrow"><div class="vs" style="flex:1">' +
      '<label>Name</label><input id="ed-name" value="' + esc(e.displayName) + '" />' +
      '<div class="row"><div style="flex:1"><label>Fargo</label><input id="ed-fargo" type="number" inputmode="numeric" value="' + (e.fargo != null ? esc(e.fargo) : '') + '" /></div>' +
      '<div style="flex:1"><label>Seed</label><input id="ed-seed" type="number" inputmode="numeric" min="1" placeholder="auto" value="' + (e.seed != null ? esc(e.seed) : '') + '" /></div></div>' +
      '<div class="row"><div style="flex:1"><label>Mobile</label><input id="ed-phone" type="tel" inputmode="tel" value="' + esc(e.phone || '') + '" /></div></div>' +
      '<label>Email</label><input id="ed-email" type="email" inputmode="email" value="' + esc(e.email || '') + '" />' +
      '<label><input id="ed-opt" type="checkbox"' + (e.notifyOptIn ? ' checked' : '') + ' />Send match-ready SMS (player consented)</label>' +
      '<div class="spacer"></div>' +
      '<div class="row"><button class="pri" data-action="entrant-save" data-id="' + esc(e.id) + '">Save</button>' +
      '<button class="ghost" data-action="entrant-cancel">Cancel</button>' +
      '<button class="ghost" data-action="entrant-dupes" data-id="' + esc(e.id) + '">Find duplicates</button></div>' +
      (state.dupes && state.dupes.entrantId === e.id ? dupesMarkup(state.dupes) : '') +
      '</div></li>';
  }

  // "Recent players at this venue": players who played this organizer's other
  // tournaments at the same venue and aren't in this one yet. Hidden when empty.
  function recentPlayersMarkup() {
    var list = state.recent;
    if (!list || !list.length) return '';
    var rows = list.map(function (p) {
      var meta = [];
      if (p.fargo != null) meta.push('Fargo ' + esc(p.fargo));
      if (p.phone) meta.push(esc(Roster.e164(p.phone)));
      return '<li><label><input type="checkbox" class="recentchk" data-pid="' + esc(p.playerId) + '" /> ' +
        '<b>' + esc(p.displayName) + '</b>' +
        (meta.length ? ' <span class="note">' + meta.join(' · ') + '</span>' : '') +
        '</label></li>';
    }).join('');
    return '<div class="spacer"></div><label>Recent players at this venue</label>' +
      '<div class="note">Played your other events here. Check any to add + check in.</div>' +
      '<ul class="list">' + rows + '</ul>' +
      '<div class="row"><button class="ghost" data-action="recent-all">Select all</button>' +
      '<button class="pri" data-action="recent-add">Add selected</button></div><div class="spacer"></div>';
  }

  function renderEntrants(dir) {
    var h = '<div class="card"><h2>Entrants</h2>';
    if (dir && state.pendingAdd) {
      h += pendingAddMarkup(state.pendingAdd);
      return h + '</div>';
    }
    if (dir && state.preview) {
      h += previewMarkup(state.preview);
      return h + '</div>';
    }
    if (dir) {
      h += '<label>Name</label><input id="en" placeholder="Player name" />' +
        '<div class="row"><div><label>Mobile (optional)</label><input id="ephone" type="tel" inputmode="tel" placeholder="+1503…" /></div></div>' +
        '<label><input id="eopt" type="checkbox" />Send match-ready SMS (player consented)</label>' +
        '<div class="spacer"></div><button class="pri" data-action="add-entrant">Add &amp; check in</button>' +
        '<div class="spacer"></div><label>Or paste a list — one player per line</label>' +
        '<textarea id="ebulk" rows="4" placeholder="Jane Doe, 512, 503-369-9277, jane@x.com&#10;John Smith (487)&#10;Kim Lee"></textarea>' +
        '<div class="note">Commas, tabs (paste from a spreadsheet), or semicolons all work. Detects email, phone (7/10/11 digits), a 3-digit Fargo (seeds the bracket), and other numbers as an id. Blank lines, bullets/numbering, and a header row are skipped.</div>' +
        '<label><input id="ebulklf" type="checkbox" />Names are &ldquo;Last, First&rdquo;</label>' +
        '<label><input id="ebulkopt" type="checkbox" />These players consented to match-ready SMS</label>' +
        '<div class="spacer"></div><button class="pri" data-action="bulk-preview">Preview</button><div class="spacer"></div>';
      h += recentPlayersMarkup();
    }
    if (!state.roster.length) h += '<p class="muted">No entrants yet.</p>';
    else h += '<ul class="list">' + state.roster.map(function (e) {
      if (dir && state.editEntrant === e.id) return editEntrantMarkup(e);
      return '<li><span class="vs"><b>' + esc(e.displayName) + '</b>' +
        (e.seed != null ? ' <span class="pill seed">#' + esc(e.seed) + '</span>' : '') +
        (e.fargo != null ? ' <span class="note">Fargo ' + esc(e.fargo) + '</span>' : '') +
        (e.phone ? ' <span class="note">' + esc(e.phone) + (e.notifyOptIn ? ' ✓sms' : '') + '</span>' : '') +
        '</span><span class="pill">' + esc(e.state) + '</span>' +
        (dir ? '<button data-action="entrant-edit" data-id="' + esc(e.id) + '">Edit</button>' : '') +
        '</li>';
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

  // ---- connected-tree bracket ----
  // Seed label for an entrant id (roster 'seed' if set, else '—').
  var seedById = null;
  function seedOf(id) {
    if (!seedById) { seedById = {}; state.roster.forEach(function (e) { if (e.seed != null) seedById[e.id] = e.seed; }); }
    return (id && seedById[id] != null) ? String(seedById[id]) : '—';
  }
  function isBye(id) { return id && state.names[id] === '— BYE —'; }
  // Parse the round number out of a match label (W2M1 -> 2, L3M1 -> 3); falls back to bracketRound.
  function roundOf(m) {
    var lbl = m.matchLabel || '';
    var mo = lbl.match(/^[WL](\d+)M/);
    return mo ? parseInt(mo[1], 10) : (m.bracketRound || 1);
  }
  // Short origin label: prefix of a match label before "M" (W2M1 -> "W2", L4M1 -> "L4");
  // Grand-Final labels (GF, GF1, GF2) collapse to "GF".
  function shortLabel(m) {
    var lbl = m.matchLabel || '';
    if (m.bracket === 'GF' || /^GF/.test(lbl)) return 'GF';
    var mo = lbl.match(/^([WL]\d+)M/);
    if (mo) return mo[1];
    // fallback for unlabeled: bracket + round
    return (m.bracket || '') + (m.bracketRound || '');
  }
  // Reverse feeder map: for each source match S with a cross-region drop/feed into
  // (targetMatchId, slot), record targetMatchId -> {0|1: S}. Only cross-region edges
  // (W->L, W->GF, L->GF) are kept — same-bracket advancement is omitted (matches mockup).
  function buildOriginMap() {
    var byId = {};
    state.matches.forEach(function (m) { byId[m.id] = m; });
    var map = {}; // targetMatchId -> { slot: sourceMatch }
    function add(srcId, targetId, slot) {
      if (targetId == null || slot == null) return;
      var src = byId[srcId], tgt = byId[targetId];
      if (!src || !tgt) return;
      if (src.bracket === tgt.bracket) return; // same-region advancement: no chip
      (map[targetId] = map[targetId] || {})[slot] = src;
    }
    state.matches.forEach(function (S) {
      add(S.id, S.feedsWinnerMatch, S.feedsWinnerSlot);
      add(S.id, S.feedsLoserMatch, S.feedsLoserSlot);
    });
    return map;
  }
  // Origins for one match card from the reverse-feeder map: {a, b} short chips.
  function originsFor(map, m) {
    var e = map[m.id]; if (!e) return {};
    var o = {};
    if (e[0]) o.a = '‹ ' + shortLabel(e[0]);
    if (e[1]) o.b = '‹ ' + shortLabel(e[1]);
    return o;
  }

  // One entrant slot inside a bracket card. When tappable, renders a <button> that
  // reuses the existing "win" action (assign→start→submitResult) — do not change it.
  function bracketSlot(m, id, otherId, opts) {
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
    var inner = seed + '<span class="name">' + nameHtml + '</span>' + score;
    if (opts.tappable) {
      return '<button type="button" class="' + cls.join(' ') + '" data-action="win" data-m="' + esc(m.id) +
        '" data-w="' + esc(id) + '" data-l="' + esc(otherId) + '">' + inner + '</button>';
    }
    return '<div class="' + cls.join(' ') + '">' + inner + '</div>';
  }

  // Render a single match card. connectors = {pairTop, lead} to draw tree lines;
  // origins = {a, b} optional "‹ from" tags.
  function bracketCard(m, interactive, connectors, origins) {
    connectors = connectors || {}; origins = origins || {};
    var a = m.entrantAId, b = m.entrantBId;
    var win = m.winnerEntrantId || null;
    var aWin = !!(win && a && win === a), bWin = !!(win && b && win === b);
    var live = (m.state === 'in_progress' || m.state === 'reopened');
    var ready = a && b && !isBye(a) && !isBye(b) &&
      (m.state === 'scheduled' || m.state === 'assigned' || m.state === 'reopened');
    var tappable = interactive && ready;

    var cls = ['match'];
    if (bWin) cls.push('bottomwin');
    if (live) cls.push('is-live');
    if (connectors.pairTop) cls.push('pair-top');
    if (connectors.lead) cls.push('lead');

    var h = '<div class="' + cls.join(' ') + '">';
    h += '<span class="mlabel">' + esc(m.matchLabel || ('R' + m.bracketRound + '·' + (m.slot + 1))) + '</span>';
    if (live) h += '<span class="live-pill">LIVE</span>';
    h += bracketSlot(m, a, b, { win: aWin, lose: !!win && !aWin, tappable: tappable, origin: origins.a });
    h += bracketSlot(m, b, a, { win: bWin, lose: !!win && !bWin, tappable: tappable, origin: origins.b });
    return h + '</div>';
  }

  // Build a round column from a list of matches (already the same round).
  function bracketColumn(head, matches, interactive, opts) {
    opts = opts || {};
    matches = matches.slice().sort(function (x, y) { return x.slot - y.slot; });
    var cells = matches.map(function (m, i) {
      var connectors = {};
      if (opts.tree) {
        // clean binary tree: upper match of each feeding pair gets pair-top; all
        // non-first columns get a lead stub.
        if (i % 2 === 0) connectors.pairTop = true;
        if (!opts.first) connectors.lead = true;
      } else if (opts.leadOnly && !opts.first) {
        connectors.lead = true;
      }
      var origins = opts.origins ? opts.origins(m) : {};
      return bracketCard(m, interactive, connectors, origins);
    }).join('');
    return '<div class="round"><div class="round-head">' + esc(head) + '</div>' + cells + '</div>';
  }

  // Group a bracket's matches into round columns keyed by round number.
  function roundsOf(list) {
    var byRound = {};
    list.forEach(function (m) { var r = roundOf(m); (byRound[r] = byRound[r] || []).push(m); });
    return Object.keys(byRound).map(Number).sort(function (x, y) { return x - y; })
      .map(function (r) { return { round: r, matches: byRound[r] }; });
  }

  // The connected-tree double-elim bracket. Falls back to the flat list for
  // single-elim / 2-player (all matches have bracket === null).
  function renderBracket(interactive) {
    if (!state.matches.length) return '<p class="muted">No matches.</p>';
    var groups = { W: [], L: [], GF: [] }, anyBracketed = false;
    state.matches.forEach(function (m) {
      if (m.bracket && groups[m.bracket]) { groups[m.bracket].push(m); anyBracketed = true; }
    });
    if (!anyBracketed) return matchesMarkup(interactive); // single-elim / flat fallback
    seedById = null; // recompute per render (roster may have changed)

    var originMap = buildOriginMap();
    var originsOf = function (m) { return originsFor(originMap, m); };
    var canvas = '';

    // ----- Winners -----
    if (groups.W.length) {
      var wr = roundsOf(groups.W), wLast = wr.length;
      var wCols = wr.map(function (rc, i) {
        var head = (i === wLast - 1) ? 'Winners final' : 'Winners R' + rc.round;
        return bracketColumn(head, rc.matches, interactive, { tree: true, first: i === 0 });
      }).join('');
      canvas += '<section class="region win"><div class="region-title"><span class="dot"></span>Winners bracket</div>' +
        '<div class="rounds">' + wCols + '</div></section>';
    }

    // ----- Losers ----- (spatial layout + origin tags rather than exact cross lines)
    if (groups.L.length) {
      var lr = roundsOf(groups.L), lLast = lr.length;
      var lCols = lr.map(function (rc, i) {
        var head = (i === lLast - 1) ? 'Losers final' : 'Losers R' + rc.round;
        return bracketColumn(head, rc.matches, interactive, { leadOnly: true, first: i === 0, origins: originsOf });
      }).join('');
      canvas += '<section class="region los"><div class="region-title"><span class="dot"></span>Losers bracket</div>' +
        '<div class="rounds">' + lCols + '</div></section>';
    }

    // ----- Grand Final + Champion -----
    if (groups.GF.length) {
      var gf = groups.GF.slice().sort(function (x, y) {
        return (x.matchLabel || '').localeCompare(y.matchLabel || '');
      });
      var cards = gf.map(function (m, i) {
        return bracketCard(m, interactive, {}, originsOf(m));
      }).join('');
      var cond = '<div class="cond">GF2 played only if the losers champ wins GF1 (bracket reset).</div>';
      // Champion: from the last GF match if it is completed; else TBD.
      var finalGF = gf[gf.length - 1];
      var champId = (finalGF && finalGF.winnerEntrantId) || null;
      var tourneyDone = state.t && state.t.state === 'completed';
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
    h += renderBracket(canScore());
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
    if (act === 'dupes-review') return guard(openDuplicates);
    if (act === 'dupe-mergeinto') return guard(async function () {
      var into = b.getAttribute('data-into'), src = b.getAttribute('data-src');
      if (!into || !src) return;
      await api.mergePlayers(src, into); // src absorbed into the kept player
      toast('Merged');
      await openDuplicates();
    });
    if (act === 'dupe-dismiss') return guard(async function () {
      var a = b.getAttribute('data-a'), bb = b.getAttribute('data-b');
      if (!a || !bb) return;
      await api.dismissDuplicate(a, bb);
      toast('Marked as different people');
      await openDuplicates();
    });
    if (act === 'open-t') return guard(function () { return openTournament(id); });
    if (act === 'add-venue') return guard(async function () {
      var vname = val('tvenuename'); if (!vname) return toast('Enter a venue name');
      var r = await api.createVenue({ name: vname, address: val('tvenueaddr') }); // geocode is server-side
      var v = r.venue;
      state.venues = (state.venues || []).concat([v]);
      state.newVenue = false;
      state.selVenue = v.id; // pre-select the just-added venue
      renderHome();
    });
    if (act === 'create-tournament') return guard(async function () {
      var name = val('tname'); if (!name) return toast('Enter a name');
      var vid = venueSelectValue();
      var venueName = '';
      if (vid) {
        var v = (state.venues || []).filter(function (x) { return x.id === vid; })[0];
        if (v) venueName = v.name;
      }
      // Pass venueId (the link) AND venue (the name label) so the existing
      // Club · Venue display keeps working.
      var r = await api.createTournament({ name: name, game: val('tgame') || '15ball_rotation', venue: venueName, club: val('tclub'), venueId: vid || undefined });
      await openTournament(r.tournament.id);
    });
    if (act === 'add-entrant') return guard(async function () {
      var name = val('en'); if (!name) return toast('Enter a name');
      var body = { displayName: name };
      var ph = val('ephone'); if (ph) { body.phone = Roster.e164(ph); body.notifyOptIn = checked('eopt'); }
      var cands = [];
      try {
        var r = await api.playerSuggestions(state.t.id, { name: name, phone: body.phone || '', email: '' });
        cands = (r && r.items) || [];
      } catch (e) { /* suggestion lookup is best-effort — fall through to a plain add */ }
      if (cands.length) {
        state.pendingAdd = { body: body, candidates: cands };
        renderTournament();
        return;
      }
      await addEntrantChecked(body);
      await openTournament(state.t.id);
    });
    // Feature A confirm: link this add to an existing player.
    if (act === 'add-link') return guard(async function () {
      var pa = state.pendingAdd; if (!pa) return;
      var pid = b.getAttribute('data-pid');
      var body = Object.assign({}, pa.body, { playerId: pid });
      state.pendingAdd = null;
      await addEntrantChecked(body);
      await openTournament(state.t.id);
    });
    // Feature A confirm: add as a brand-new player (no link).
    if (act === 'add-new') return guard(async function () {
      var pa = state.pendingAdd; if (!pa) return;
      var body = pa.body;
      state.pendingAdd = null;
      await addEntrantChecked(body);
      await openTournament(state.t.id);
    });
    if (act === 'add-cancel') return guard(async function () {
      state.pendingAdd = null;
      renderTournament();
    });
    if (act === 'recent-all') return guard(async function () {
      var boxes = document.querySelectorAll('.recentchk');
      var anyUnchecked = false;
      boxes.forEach(function (c) { if (!c.checked) anyUnchecked = true; });
      boxes.forEach(function (c) { c.checked = anyUnchecked; }); // toggle: all on, else all off
    });
    if (act === 'recent-add') return guard(async function () {
      var picks = [];
      document.querySelectorAll('.recentchk').forEach(function (c) {
        if (c.checked) picks.push(c.getAttribute('data-pid'));
      });
      if (!picks.length) return toast('Select at least one player');
      var byId = {}; (state.recent || []).forEach(function (p) { byId[p.playerId] = p; });
      var added = 0;
      for (var i = 0; i < picks.length; i++) {
        var p = byId[picks[i]]; if (!p) continue;
        var body = { displayName: p.displayName, playerId: p.playerId }; // LINK to the existing player
        if (p.phone) body.phone = Roster.e164(p.phone);
        if (p.email) body.email = p.email;
        if (p.fargo != null) body.fargo = p.fargo;
        try { await addEntrantChecked(body); added++; }
        catch (e) { if (e.code !== 'duplicate_display_name') throw e; }
      }
      toast('Added ' + added);
      await openTournament(state.t.id);
    });
    if (act === 'bulk-preview') return guard(async function () {
      var raw = val('ebulk');
      var list = Roster.parse(raw, { lastFirst: checked('ebulklf') });
      if (!list.length) return toast('Nothing to add');
      var rawLines = raw.split(/\r?\n/).filter(function (ln) { return ln.trim(); }).length;
      // Best-effort per-row dedup lookup against existing players.
      var matches = {}, choice = {};
      try {
        var queries = list.map(function (p, i) {
          return { key: String(i), name: p.name, phone: p.phone ? Roster.e164(p.phone) : '', email: p.email || '' };
        });
        var r = await api.playerSuggestionsBatch(state.t.id, queries);
        var results = (r && r.results) || {};
        list.forEach(function (p, i) {
          var cands = sortCandidates(results[String(i)] || []);
          matches[i] = cands;
          // Default the per-row decision: link to a strong top candidate, else new.
          if (cands.length && tierOf(cands[0]) === 'strong') choice[i] = cands[0].playerId;
          else choice[i] = null;
        });
      } catch (e) { /* batch is best-effort — proceed with no matches */ }
      state.preview = { list: list, consent: checked('ebulkopt'), rawLines: rawLines, matches: matches, choice: choice };
      renderTournament();
    });
    if (act === 'bulk-cancel') return guard(async function () {
      state.preview = null;
      renderTournament();
    });
    if (act === 'bulk-confirm') return guard(async function () {
      var pv = state.preview; if (!pv) return;
      var consent = pv.consent;
      var choice = pv.choice || {};
      var added = 0, linked = 0, dupes = 0;
      for (var i = 0; i < pv.list.length; i++) {
        var p = pv.list[i];
        var body = { displayName: p.name };
        if (p.phone) { body.phone = Roster.e164(p.phone); body.notifyOptIn = consent; }
        if (p.email) body.email = p.email;
        if (p.fargo != null) body.fargo = p.fargo;
        if (p.externalId) body.externalId = p.externalId;
        var pid = choice[i]; // playerId to LINK to, or null/undefined for a new player
        if (pid) body.playerId = pid;
        try { await addEntrantChecked(body); added++; if (pid) linked++; }
        catch (e) { if (e.code === 'duplicate_display_name') dupes++; else throw e; }
      }
      toast('Added ' + added + (linked ? ' · ' + linked + ' linked' : '') +
        (dupes ? ' · ' + dupes + ' duplicate' + (dupes > 1 ? 's' : '') + ' skipped' : ''));
      state.preview = null;
      await openTournament(state.t.id);
    });
    if (act === 'entrant-edit') return guard(async function () {
      state.editEntrant = id;
      state.dupes = null;
      renderTournament();
    });
    if (act === 'entrant-cancel') return guard(async function () {
      state.editEntrant = null;
      state.dupes = null;
      renderTournament();
    });
    // Feature B: find duplicate players for the entrant being edited.
    if (act === 'entrant-dupes') return guard(async function () {
      var ent = state.roster.filter(function (e) { return e.id === id; })[0];
      if (!ent) return;
      if (!ent.playerId) { state.dupes = { entrantId: id, intoId: '', entrant: ent, candidates: [] }; renderTournament(); return; }
      var r = await api.playerSuggestions(state.t.id, { name: ent.displayName, phone: ent.phone || '', email: ent.email || '' });
      var cands = ((r && r.items) || []).filter(function (c) { return c.playerId !== ent.playerId; });
      state.dupes = { entrantId: id, intoId: ent.playerId, entrant: ent, candidates: cands };
      renderTournament();
    });
    // Feature B: absorb the duplicate player INTO this entrant's player.
    if (act === 'entrant-merge') return guard(async function () {
      var src = b.getAttribute('data-src'), into = b.getAttribute('data-into');
      if (!src || !into) return;
      await api.mergePlayers(src, into);
      toast('Merged');
      state.dupes = null;
      state.editEntrant = null;
      await openTournament(state.t.id);
    });
    if (act === 'entrant-save') return guard(async function () {
      var name = val('ed-name'); if (!name) return toast('Enter a name');
      var phone = val('ed-phone');
      var fargoStr = val('ed-fargo');
      var seedStr = val('ed-seed');
      var body = {
        displayName: name,
        phone: phone ? Roster.e164(phone) : '',
        notifyOptIn: checked('ed-opt'),
        email: val('ed-email'),
        fargo: fargoStr ? parseInt(fargoStr, 10) : null
      };
      if (seedStr) body.seed = parseInt(seedStr, 10);
      try {
        await api.patchEntrant(state.t.id, id, body);
      } catch (e) {
        if (e.code === 'duplicate_display_name') return toast('That name is already taken');
        throw e;
      }
      state.editEntrant = null;
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

  // Venue picker: toggling to "＋ New venue" reveals the name/address inputs;
  // any saved venue selection just remembers the choice.
  document.addEventListener('change', function (ev) {
    var sel = ev.target;
    if (!sel) return;
    // Bulk preview per-row match choice: record it and repaint (updates the summary).
    if (sel.classList && sel.classList.contains('bulkchoose') && state.preview) {
      var row = parseInt(sel.getAttribute('data-row'), 10);
      state.preview.choice = state.preview.choice || {};
      state.preview.choice[row] = sel.value || null; // '' → New person
      renderTournament();
      return;
    }
    if (sel.id !== 'tvenue') return;
    if (sel.value === '__new__') {
      state.newVenue = true; state.selVenue = '';
    } else {
      state.newVenue = false; state.selVenue = sel.value;
    }
    renderHome();
  });

  // A ?t=<id> link opens a public scoring board (no sign-in); otherwise normal boot.
  function init() {
    var pt = new URLSearchParams(location.search).get('t');
    if (pt) { state.public = true; whoEl.textContent = 'Open scoring'; return guard(function () { return openTournament(pt); }); }
    boot();
  }
  init();
})();
