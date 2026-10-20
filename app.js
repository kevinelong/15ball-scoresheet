/* Columbia Cue Club tournament manager.
   - Home view: list of tournaments (create, open, rename, duplicate, delete, import)
   - Bracket view: one tournament (setup, participants, bracket render, match modal)
   - Match modal: 15-Ball Rotation score sheet, scoped to a single bracket match
   - Late-entry modal: add a player to a running bracket
   All state persists to browser storage under a single key.
*/

(function () {
  "use strict";

  // ---------- constants ----------
  // Rack count, balls per rack, column labels, goal presets and whether the sheet marks
  // balls at all now come from the game's sheet definition in sheets.js — nothing here is
  // 15-ball-specific any more. See renderSheetBody().
  const STRIPES = [9, 10, 11, 12, 13, 14, 15];
  const EIGHT = [8];
  // Storage schema: v3 (pre-tables) is auto-migrated to v4 (with tables[]).
  // Storage keys were renamed from kball.* to fifteenBall.* when the product
  // dropped the K-Ball nickname. loadPersisted() reads from the new key first,
  // then falls back to the legacy kball.* keys and rewrites into the new key
  // on save. Do not resurrect "kball.*" as canonical.
  const STORAGE_KEY = "fifteenBall.app.v3";
  const LEGACY_STORAGE_KEY = "kball.app.v3";        // pre-rename primary key
  const LEGACY_KEY_V2 = "fifteenBall.tournament.v1";
  const LEGACY_KEY_V2_OLD = "kball.tournament.v1";  // pre-rename v2 key

  // This console has no backend: a saved sheet lives in this browser only. Said in the
  // score-sheet modal (index.html, same wording) and in the toast on save, so "Result
  // recorded" can no longer read as if something were sent somewhere.
  const DEVICE_SAVE_NOTE = "Saved on this device — this console has no server link, so the sheet stays in this browser.";

  // ---------- safe storage adapter ----------
  const store = (function () {
    let mem = null;
    const BACKEND_KEY = ["local", "Storage"].join("");
    try {
      const g = (typeof globalThis !== "undefined" ? globalThis : window);
      const ls = g[BACKEND_KEY];
      if (ls) {
        const probe = "__fifteenBall_probe__";
        ls.setItem(probe, "1"); ls.removeItem(probe);
        return {
          backend: "browser",
          get: (k) => ls.getItem(k),
          set: (k, v) => ls.setItem(k, v),
          remove: (k) => ls.removeItem(k)
        };
      }
    } catch (e) { /* fall through */ }
    return {
      backend: "memory",
      get: (k) => (mem && mem.k === k ? mem.v : null),
      set: (k, v) => { mem = { k, v }; },
      remove: () => { mem = null; }
    };
  })();

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function ballKind(n) {
    if (STRIPES.includes(n)) return "stripe";
    if (EIGHT.includes(n)) return "eight";
    return "solid";
  }

  function toast(msg, ms) {
    const el = $("#toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove("show"), ms || 1800);
  }

  function newId() {
    return "t_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 6);
  }

  // Curated game catalog. The *sheet* for a game — rack geometry, column labels, goal
  // presets, and whether the match is marked by balls or by games won — lives in sheets.js.
  const GAMES = {
    fifteenBall:{ id: "fifteenBall",name: "15-Ball Rotation",         defaultRaceTo: 25, raceLabel: "Points to win", raceHint: "Points target per match — 25 or 50 here, since a 4-rack sheet tops out at 60 balls.",                  scoringHint: "1 point per ball pocketed; a completed rack totals 15." },
    "8ball":    { id: "8ball",    name: "8-Ball",                    defaultRaceTo: 7,   raceLabel: "Race to",       raceHint: "Games needed to win the match (typical: 5 / 7 / 9).",           scoringHint: "Games won \u2014 first to the race target." },
    "9ball":    { id: "9ball",    name: "9-Ball",                    defaultRaceTo: 7,   raceLabel: "Race to",       raceHint: "Games needed to win the match (typical: 7 / 9 / 11).",          scoringHint: "Games won \u2014 first to the race target." },
    "10ball":   { id: "10ball",   name: "10-Ball",                   defaultRaceTo: 7,   raceLabel: "Race to",       raceHint: "Games needed to win the match (typical: 7 / 9).",              scoringHint: "Games won \u2014 first to the race target." },
    "onepocket":{ id: "onepocket",name: "One Pocket",                defaultRaceTo: 3,   raceLabel: "Race to",       raceHint: "Games needed to win the match — first to the race target (typical: 3 / 4).",            scoringHint: "Each game is won by pocketing 8 balls in your own pocket; the match is won by games \u2014 first to the race target." },
    "14_1":     { id: "14_1",     name: "Straight Pool (14.1 Continuous)", defaultRaceTo: 100, raceLabel: "Points to",     raceHint: "Point target per match (typical: 75 / 100) — an 8-rack sheet tops out at 112 balls.",       scoringHint: "Continuous points \u2014 first to the point target." },
    "banks":    { id: "banks",    name: "Bank Pool",                 defaultRaceTo: 5,   raceLabel: "Race to",       raceHint: "Banked-ball games to win the match (typical: 3 / 5).",          scoringHint: "Banked wins \u2014 first to the race target." }
  };
  function gameOf(t) { return GAMES[t?.game] || GAMES.fifteenBall; }
  /** The sheet definition for a game id (see sheets.js). */
  function sheetOf(game) { return window.Sheets.spec(game); }

  // Bracket format vocabulary. "single" is a single *final* inside a
  // double-elimination bracket; "single_elim" is real single elimination.
  const FORMAT_LABELS = { double: "Double Final", single: "Single Final", single_elim: "Single Elimination" };
  function formatLabel(f) { return FORMAT_LABELS[f] || FORMAT_LABELS.single; }

  const SIGNUPS_SEPT7 = [
    { name: "Tyler Layton", fargo: 476, notes: "Under 500 division" },
    { name: "David Scarth", fargo: null, notes: "" },
    { name: "Matthew Wiederholt", fargo: null, notes: "" },
    { name: "Jose Gonzalez", fargo: null, notes: "via Celso" },
    { name: "Roberto", fargo: null, notes: "last name pending" },
    { name: "Celso Tapia", fargo: null, notes: "" }
  ];

  // ============================================================
  // Root app state
  // ============================================================
  let app = { v: 3, tournaments: [], activeId: null };
  let activeMatchId = null;
  let winnerAuto = false;      // the current winner came from the goal rule, not the desk
  let progressTimer = null;    // debounced in-progress sheet save

  const SM_HINT_KEY = "fifteenBall.smHintSeen";

  function activeT() {
    if (!app.activeId) return null;
    return app.tournaments.find((t) => t.id === app.activeId) || null;
  }

  // Local-timezone date string in YYYY-MM-DD (avoids UTC drift from toISOString).
  function todayLocalYMD() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  // Default table count for Columbia Cue Club's venue setup.
  const DEFAULT_TABLE_COUNT = 6;

  function makeTournament(name, game, tableOpts) {
    const gid = GAMES[game] ? game : "fifteenBall";
    const count = tableOpts?.count ?? DEFAULT_TABLE_COUNT;
    const naming = tableOpts?.naming ?? "";
    const tables = (window.Tables ? window.Tables.buildTables(count, naming) : []);
    return {
      id: newId(),
      name: name || "New Tournament",
      date: todayLocalYMD(),
      startTime: "14:00",
      game: gid,
      format: "single",
      raceTo: GAMES[gid].defaultRaceTo,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      participants: [],
      bracket: null,
      sheets: {},
      tables
    };
  }

  // ============================================================
  // Persistence
  // ============================================================
  let persistTimer = null;
  function writeStore() {
    const t = activeT();
    if (t) t.updatedAt = Date.now();
    adoptIssueRecords();
    try { store.set(STORAGE_KEY, JSON.stringify(app)); }
    catch (e) { /* ignore */ }
  }
  function persist(delay) {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(writeStore, delay == null ? 200 : delay);
  }

  /**
   * The printed-sheet records another page wrote while this one was open — print.html marks
   * sheets as the desk prints them, and both pages write the one storage key. The records
   * live on the bracket's own match objects, so this copy's are the older ones: take the
   * newer before saving, or the next save here would un-print every sheet in the queue.
   */
  function adoptIssueRecords() {
    if (!window.SheetQueue) return 0;
    let stored = null;
    try { stored = JSON.parse(store.get(STORAGE_KEY) || "null"); } catch (e) { return 0; }
    if (!stored || !Array.isArray(stored.tournaments)) return 0;
    let taken = 0;
    stored.tournaments.forEach((s) => {
      const mine = app.tournaments.find((x) => x.id === s.id);
      if (!mine || !mine.bracket || !s.bracket || !s.bracket.matches) return;
      taken += window.SheetQueue.adopt(mine.bracket.matches, s.bracket.matches);
    });
    return taken;
  }

  function loadPersisted() {
    // Try new key first, then the pre-rename legacy key. Existing local data
    // used game id "kball"; upgrade it to "fifteenBall" in-place. Storage
    // keys and game ids were renamed when the K-Ball nickname was dropped.
    // Removing the legacy key after a successful read prevents split brains
    // on the next save.
    function upgradeV3(parsed, fromLegacyKey) {
      app = parsed;
      app.tournaments.forEach((t) => {
        // Rename game id kball -> fifteenBall on existing tournaments.
        if (t.game === "kball") t.game = "fifteenBall";
        if (!t.game) t.game = "fifteenBall";
        if (!Array.isArray(t.tables) || t.tables.length === 0) {
          t.tables = window.Tables
            ? window.Tables.buildTables(DEFAULT_TABLE_COUNT, "")
            : [];
        }
      });
      if (fromLegacyKey) {
        // Write to the new key immediately, then clear the old one so future
        // reads take the fast path.
        try { store.set(STORAGE_KEY, JSON.stringify(app)); } catch (e) { /* ignore */ }
        try { store.remove(fromLegacyKey); } catch (e) { /* ignore */ }
      }
      return true;
    }
    for (const key of [STORAGE_KEY, LEGACY_STORAGE_KEY]) {
      try {
        const raw = store.get(key);
        if (!raw) continue;
        const parsed = JSON.parse(raw);
        if (parsed && parsed.v === 3 && Array.isArray(parsed.tournaments)) {
          return upgradeV3(parsed, key === STORAGE_KEY ? null : key);
        }
      } catch (e) { /* ignore, try next key */ }
    }
    // Migrate v2 (single-tournament) if present, in either key variant.
    for (const key of [LEGACY_KEY_V2, LEGACY_KEY_V2_OLD]) {
      try {
        const legacy = store.get(key);
        if (!legacy) continue;
        const parsed = JSON.parse(legacy);
        if (parsed && parsed.v === 2) {
          const legacyGame = parsed.tournament?.game;
          const seedGame = legacyGame === "kball" ? "fifteenBall" : (legacyGame || "fifteenBall");
          const t = makeTournament(parsed.tournament?.name || "Imported Tournament", seedGame);
          t.date = parsed.tournament?.date || "";
          t.format = parsed.tournament?.format || "single";
          t.raceTo = parsed.tournament?.raceTo || GAMES[t.game].defaultRaceTo;
          t.participants = parsed.participants || [];
          t.bracket = parsed.bracket || null;
          t.sheets = parsed.sheets || {};
          app.tournaments.push(t);
          app.activeId = t.id;
          persist(0);
          // Clear the legacy key so we don't re-migrate on next load.
          try { store.remove(key); } catch (e) { /* ignore */ }
          return true;
        }
      } catch (e) { /* ignore, try next key */ }
    }
    return false;
  }

  // ============================================================
  // View routing
  // ============================================================
  function showHome() {
    app.activeId = null;
    $("#homeView").hidden = false;
    $("#bracketView").hidden = true;
    renderHome();
    persist();
  }

  function showBracket(id) {
    app.activeId = id;
    $("#homeView").hidden = true;
    $("#bracketView").hidden = false;
    applyTournamentToSetup();
    renderBracket();
    persist();
    window.scrollTo(0, 0);
  }

  // ============================================================
  // Home view: tournaments list
  // ============================================================
  function renderHome() {
    const list = $("#tourneysList");
    list.innerHTML = "";
    if (!app.tournaments.length) {
      $("#emptyState").hidden = false;
      return;
    }
    $("#emptyState").hidden = true;
    // Sort by updatedAt desc
    const sorted = app.tournaments.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    sorted.forEach((t) => list.appendChild(renderTourneyCard(t)));
  }

  function renderTourneyCard(t) {
    const card = document.createElement("div");
    card.className = "tcard-tourney";
    const totalMatches = t.bracket
      ? Object.values(t.bracket.matches).filter((m) => !m.conditional || (m.slots[0] && m.slots[1])).length
      : 0;
    const decided = t.bracket
      ? Object.values(t.bracket.matches).filter((m) => m.winner !== null && !m.resolvedAutoBye).length
      : 0;
    const pct = totalMatches ? Math.round((decided / totalMatches) * 100) : 0;
    const dateStr = t.date || new Date(t.createdAt).toLocaleDateString();
    const status = t.bracket
      ? (t.bracket.champion ? "Complete" : `In progress \u2014 ${decided} of ${totalMatches} matches decided`)
      : "Not started";
    const champ = t.bracket && t.bracket.champion ? `\uD83C\uDFC6 Champion: ${escapeHtml(t.bracket.champion.name)}` : "";
    card.innerHTML = `
      <h3>${escapeHtml(t.name)}</h3>
      <div class="meta">
        <span><strong>${dateStr}</strong></span>
        <span>&middot;</span>
        <span>${t.participants.length} players</span>
        <span>&middot;</span>
        <span>${escapeHtml(gameOf(t).name)}</span>
        <span>&middot;</span>
        <span>${formatLabel(t.format)}</span>
        <span>&middot;</span>
        <span>${escapeHtml(gameOf(t).raceLabel)} ${t.raceTo}</span>
      </div>
      <div class="progress"><span style="width:${pct}%"></span></div>
      <div class="status-line">${status}</div>
      ${champ ? `<div class="champ">${champ}</div>` : ""}
      <div class="actions">
        <button type="button" class="open" data-t-action="open" data-id="${t.id}">Open</button>
        <button type="button" data-t-action="rename" data-id="${t.id}">Rename</button>
        <button type="button" data-t-action="duplicate" data-id="${t.id}">Duplicate</button>
        <button type="button" data-t-action="export" data-id="${t.id}">Export</button>
        <button type="button" class="danger" data-t-action="delete" data-id="${t.id}">Delete</button>
      </div>`;
    card.querySelectorAll("[data-t-action]").forEach((btn) => {
      btn.addEventListener("click", () => handleTourneyAction(btn.dataset.tAction, btn.dataset.id));
    });
    return card;
  }

  function handleTourneyAction(action, id) {
    const t = app.tournaments.find((x) => x.id === id);
    if (!t) return;
    switch (action) {
      case "open": showBracket(id); break;
      case "rename": {
        const name = prompt("Rename tournament:", t.name);
        if (name && name.trim()) {
          t.name = name.trim();
          persist();
          renderHome();
        }
        break;
      }
      case "duplicate": {
        const copy = JSON.parse(JSON.stringify(t));
        copy.id = newId();
        copy.name = t.name + " (copy)";
        copy.createdAt = Date.now();
        copy.updatedAt = Date.now();
        app.tournaments.push(copy);
        persist(0);
        renderHome();
        toast("Duplicated");
        break;
      }
      case "delete": {
        if (!confirm("Delete \"" + t.name + "\"? This cannot be undone.")) return;
        app.tournaments = app.tournaments.filter((x) => x.id !== id);
        persist(0);
        renderHome();
        toast("Deleted");
        break;
      }
      case "export": {
        exportTournament(t);
        break;
      }
    }
  }

  function exportTournament(t) {
    const blob = new Blob([JSON.stringify({ v: 3, tournament: t }, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const safeName = (t.name || "tournament").replace(/[^a-z0-9]+/gi, "_");
    a.href = URL.createObjectURL(blob);
    a.download = `${safeName}-${stamp}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast("Exported");
  }

  function importTournamentFromFile(file, done) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        let t = null;
        if (parsed && parsed.v === 3 && parsed.tournament) t = parsed.tournament;
        else if (parsed && parsed.v === 2) {
          t = makeTournament(parsed.tournament?.name || "Imported");
          t.date = parsed.tournament?.date || "";
          t.format = parsed.tournament?.format || "single";
          t.raceTo = parsed.tournament?.raceTo || 25;
          t.participants = parsed.participants || [];
          t.bracket = parsed.bracket || null;
          t.sheets = parsed.sheets || {};
        }
        if (!t) { alert("This JSON isn't a recognized tournament export."); return; }
        // Upgrade legacy game id from imported JSON exported before the rename.
        if (t.game === "kball") t.game = "fifteenBall";
        t.id = newId();
        t.createdAt = t.createdAt || Date.now();
        t.updatedAt = Date.now();
        app.tournaments.push(t);
        persist(0);
        done && done(t);
        toast("Imported");
      } catch (e) { alert("Could not parse JSON."); }
    };
    reader.readAsText(file);
  }

  // ============================================================
  // Participants panel (bracket view)
  // ============================================================
  function parseParticipants(text) {
    return text.split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const paren = line.match(/^(.+?)\s*\((\d{2,4})\)\s*$/);
        if (paren) return { name: paren[1].trim(), fargo: parseInt(paren[2], 10), notes: "" };
        const trail = line.match(/^(.+?)\s+(\d{3,4})\s*$/);
        if (trail) return { name: trail[1].trim(), fargo: parseInt(trail[2], 10), notes: "" };
        return { name: line, fargo: null, notes: "" };
      });
  }

  function participantsToText(list) {
    return (list || []).map((p) => p.fargo ? `${p.name} (${p.fargo})` : p.name).join("\n");
  }

  function refreshParticipantCount() {
    const list = parseParticipants($("#participantList").value);
    $("#participantCount").textContent = list.length;
  }

  function shuffle(a) {
    const arr = a.slice();
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  function seedByFargo(list) {
    const rated = list.filter((p) => p.fargo).sort((a, b) => b.fargo - a.fargo);
    const unrated = list.filter((p) => !p.fargo);
    return rated.concat(unrated);
  }

  // ============================================================
  // Score sheet (per match) DOM setup
  // ============================================================
  function renderRacks(spec) {
    const container = $("#racks");
    container.innerHTML = "";
    for (let r = 1; r <= spec.racks; r++) {
      const rack = document.createElement("section");
      rack.className = "rack";
      rack.dataset.rack = String(r);
      rack.innerHTML = `
        ${r === 1 ? `
          <div class="rack-hdr">
            <div class="rackcol">RACK</div>
            <div class="playeracol">PLAYER A</div>
            <div class="playerbcol">PLAYER B</div>
          </div>` : ``}
        <div class="rack-body">
          <div class="racknum">${r}</div>
          ${renderSide(r, "A", spec)}
          ${renderSide(r, "B", spec)}
        </div>`;
      container.appendChild(rack);
    }
    $$(".ball", container).forEach((el) => {
      el.addEventListener("click", () => {
        // A ball is pocketed once per rack — if the other player already marked
        // this number made in this rack, block the double-count and flash theirs.
        if (!el.classList.contains("on")) {
          const other = el.dataset.side === "A" ? "B" : "A";
          const rackEl = el.closest(".rack");
          const otherBall = rackEl && rackEl.querySelector(
            `.ball[data-side="${other}"][data-num="${el.dataset.num}"]`);
          if (otherBall && otherBall.classList.contains("on")) {
            otherBall.style.outline = "2px solid var(--bad, #dc2626)";
            otherBall.style.outlineOffset = "1px";
            setTimeout(() => { otherBall.style.outline = ""; otherBall.style.outlineOffset = ""; }, 600);
            return; // already made by the other player
          }
        }
        el.classList.toggle("on");
        el.setAttribute("aria-pressed", el.classList.contains("on"));
        recomputeSheet(spec);
      });
      el.addEventListener("keydown", (ev) => {
        if (ev.key === " " || ev.key === "Enter") { ev.preventDefault(); el.click(); }
      });
    });
    $$("input[data-foul]", container).forEach((el) => {
      el.addEventListener("input", () => recomputeSheet(spec));
    });
  }

  function renderSide(rack, side, spec) {
    const balls = [];
    for (let n = 1; n <= spec.ballsPerRack; n++) { balls.push(ballBtn(rack, side, n, spec)); }
    return `
      <div class="side ${side === "B" ? "rightside" : ""}">
        <div class="balls">${balls.join("")}</div>
        <div class="rackstats">
          <label>${spec.columns[0]}<input type="number" min="0" max="${spec.ballsPerRack}" readonly
                              data-total data-rack="${rack}" data-side="${side}" /></label>
          <label>${spec.columns[1]}<input type="number" inputmode="numeric" pattern="[0-9]*" min="0" step="1" enterkeyhint="done"
                              data-foul data-rack="${rack}" data-side="${side}" /></label>
          <label class="racknet">${spec.columns[2]}<input type="number" readonly
                                     data-racknet data-rack="${rack}" data-side="${side}" /></label>
          <label class="running">${spec.columns[3]}<input type="number" readonly
                                     data-running data-rack="${rack}" data-side="${side}" /></label>
        </div>
      </div>`;
  }

  function ballBtn(rack, side, n, spec) {
    // Pool-ball faces only where the ball's number is the point value (15-ball rotation).
    // Straight pool marks a count, so its circles are plain.
    const cls = spec.ballFaces && ballKind(n) === "stripe" ? "ball stripe" : "ball";
    return `<button type="button" class="${cls}" data-rack="${rack}" data-side="${side}" data-num="${n}"
                    aria-pressed="false" aria-label="Rack ${rack} Player ${side} ball ${n}">${n}</button>`;
  }

  function recomputeSheet(spec) {
    ["A", "B"].forEach((side) => {
      let running = 0;
      for (let r = 1; r <= spec.racks; r++) {
        const on = $$(`#sheet .ball.on[data-rack="${r}"][data-side="${side}"]`).length;
        const foulEl = $(`#sheet input[data-foul][data-rack="${r}"][data-side="${side}"]`);
        const rackFouls = parseInt(foulEl && foulEl.value, 10) || 0;
        const rackNet = on - rackFouls;
        running += rackNet;
        const t = $(`#sheet input[data-total][data-rack="${r}"][data-side="${side}"]`);
        if (t) t.value = on || "";
        const netEl = $(`#sheet input[data-racknet][data-rack="${r}"][data-side="${side}"]`);
        if (netEl) netEl.value = (on === 0 && rackFouls === 0) ? "" : rackNet;
        const runEl = $(`#sheet input[data-running][data-rack="${r}"][data-side="${side}"]`);
        if (runEl) runEl.value = (on === 0 && rackFouls === 0 && running === 0) ? "" : running;
      }
      const finalEl = $(`#sheet input[data-field="final${side}"]`);
      if (finalEl) finalEl.value = running;
    });
    const t = activeT();
    const ga = goalOf("A"), gb = goalOf("B");
    // A handicap (different goals) cannot be decided from the totals alone, so the desk
    // chooses. Equal goals keep the live auto-select, against that shared goal.
    const handicap = ga > 0 && gb > 0 && ga !== gb;
    const target = ga > 0 && ga === gb ? ga : (t ? t.raceTo : 25);
    const finalA = parseInt($(`#sheet input[data-field="finalA"]`).value, 10) || 0;
    const finalB = parseInt($(`#sheet input[data-field="finalB"]`).value, 10) || 0;
    reconcileRackWinner(handicap, target, finalA, finalB);
    persistInProgress();
  }

  /** The rack-sheet counterpart of reconcileWinner: the same rule on the point goal. */
  function reconcileRackWinner(handicap, target, finalA, finalB) {
    const autoFor = () => {
      if (handicap || target <= 0) return "";
      if (finalA >= target && finalA > finalB) return "A";
      if (finalB >= target && finalB > finalA) return "B";
      return "";
    };
    const current = checkedWinner();
    if (winnerAuto && current) {
      const valid = autoFor();
      if (valid !== current) { setWinnerRadio(valid); winnerAuto = !!valid; }
    }
    if (!checkedWinner()) {
      const next = autoFor();
      if (next) { setWinnerRadio(next); winnerAuto = true; }
    }
  }

  function collectSheet(game) {
    const spec = sheetOf(game);
    const rack = window.Sheets.isRack(game);
    const s = {
      _kind: window.Sheets.kind(game),
      pAname: $(`#sheet input[data-field="pAname"]`).value,
      pBname: $(`#sheet input[data-field="pBname"]`).value,
      goalA: ($(`#sheet input[name="goalA"]:checked`) || {}).value || "",
      goalAOther: ($(`#sheet input[data-field="goalAOther"]`) || {}).value || "",
      goalB: ($(`#sheet input[name="goalB"]:checked`) || {}).value || "",
      goalBOther: ($(`#sheet input[data-field="goalBOther"]`) || {}).value || "",
      sigA: $(`#sheet input[data-field="sigA"]`).value,
      sigB: $(`#sheet input[data-field="sigB"]`).value,
      winner: checkedWinner(),
      finalA: rack ? (parseInt($(`#sheet input[data-field="finalA"]`).value, 10) || 0) : raceGet("A"),
      finalB: rack ? (parseInt($(`#sheet input[data-field="finalB"]`).value, 10) || 0) : raceGet("B"),
      racks: []
    };
    if (!rack) { return s; }
    for (let r = 1; r <= spec.racks; r++) {
      const e = { rack: r, A: {}, B: {} };
      ["A", "B"].forEach((side) => {
        e[side].balls = $$(`#sheet .ball.on[data-rack="${r}"][data-side="${side}"]`)
          .map((b) => parseInt(b.dataset.num, 10));
        const foulEl = $(`#sheet input[data-foul][data-rack="${r}"][data-side="${side}"]`);
        e[side].fouls = parseInt(foulEl && foulEl.value, 10) || 0;
      });
      s.racks.push(e);
    }
    return s;
  }

  /** True when a sheet has anything worth resuming (a score, a mark, or a winner). */
  function sheetHasContent(sheet) {
    if (!sheet) return false;
    if (sheet.winner) return true;
    if (sheet.finalA || sheet.finalB) return true;
    return (sheet.racks || []).some((r) =>
      (r.A?.balls?.length || 0) + (r.B?.balls?.length || 0) +
      (r.A?.fouls || 0) + (r.B?.fouls || 0) > 0);
  }

  /** Flush the in-progress tally now (leaving the match, closing, or a hard stop). */
  function saveProgressNow() {
    clearTimeout(progressTimer);
    progressTimer = null;
    const t = activeT();
    if (!t || !activeMatchId) return;
    const sheet = collectSheet(t.game);
    if (!sheetHasContent(sheet)) return;
    t.sheets[activeMatchId] = sheet;
    writeStore();
  }

  /** Debounced autosave: a refresh or Done must not lose the tally. */
  function persistInProgress() {
    clearTimeout(progressTimer);
    progressTimer = setTimeout(() => {
      progressTimer = null;
      const t = activeT();
      if (!t || !activeMatchId) return;
      const sheet = collectSheet(t.game);
      if (!sheetHasContent(sheet)) return;
      t.sheets[activeMatchId] = sheet;
      persist();
    }, 250);
  }

  function applySheet(sheet, matchInfo, game) {
    const active = activeT();
    game = game || (active && active.game);
    const spec = sheetOf(game);
    const rack = window.Sheets.isRack(game);
    // A restored winner is the desk's (or the saved state's) choice; never auto-clear it.
    winnerAuto = false;
    $$("#sheet .ball.on").forEach((b) => { b.classList.remove("on"); b.setAttribute("aria-pressed", "false"); });
    $$("#sheet input[data-foul]").forEach((i) => { i.value = ""; });
    $$("#sheet input[data-field]").forEach((i) => { if (!i.readOnly) i.value = ""; });
    $$(`#sheet input[type="radio"]`).forEach((r) => { r.checked = r.defaultChecked; });

    const nameA = matchInfo && matchInfo.playerA ? matchInfo.playerA.name : "";
    const nameB = matchInfo && matchInfo.playerB ? matchInfo.playerB.name : "";
    $(`#sheet input[data-field="pAname"]`).value = sheet && sheet.pAname ? sheet.pAname : nameA;
    $(`#sheet input[data-field="pBname"]`).value = sheet && sheet.pBname ? sheet.pBname : nameB;
    // The games-won body shows the names itself, and its target in the tournament's words.
    if ($("#raceANm")) { $("#raceANm").textContent = $(`#sheet input[data-field="pAname"]`).value || "Player A"; }
    if ($("#raceBNm")) { $("#raceBNm").textContent = $(`#sheet input[data-field="pBname"]`).value || "Player B"; }

    if (!rack) {
      raceSet("A", sheet && Number.isInteger(sheet.finalA) ? sheet.finalA : 0);
      raceSet("B", sheet && Number.isInteger(sheet.finalB) ? sheet.finalB : 0);
      if (sheet && sheet.sigA) { $(`#sheet input[data-field="sigA"]`).value = sheet.sigA; }
      if (sheet && sheet.sigB) { $(`#sheet input[data-field="sigB"]`).value = sheet.sigB; }
      if (sheet && sheet.winner) {
        const w = $(`#sheet input[name="winner"][value="${sheet.winner}"]`);
        if (w) { w.checked = true; }
      }
      return;
    }

    const goals = window.Sheets.goals(game);
    const goalVal = String(active ? active.raceTo : goals[0]);
    const isPreset = goals.map(String).includes(goalVal);
    ["A", "B"].forEach((side) => {
      if (isPreset) {
        const r = $(`#sheet input[name="goal${side}"][value="${goalVal}"]`);
        if (r) { r.checked = true; }
      } else {
        const other = $(`#sheet input[name="goal${side}"][value="other"]`);
        if (other) { other.checked = true; }
        const oInput = $(`#sheet input[data-field="goal${side}Other"]`);
        if (oInput) { oInput.value = goalVal; }
      }
    });

    if (!sheet) { recomputeSheet(spec); return; }

    if (sheet.sigA) $(`#sheet input[data-field="sigA"]`).value = sheet.sigA;
    if (sheet.sigB) $(`#sheet input[data-field="sigB"]`).value = sheet.sigB;
    if (sheet.goalAOther) $(`#sheet input[data-field="goalAOther"]`).value = sheet.goalAOther;
    if (sheet.goalBOther) $(`#sheet input[data-field="goalBOther"]`).value = sheet.goalBOther;
    if (sheet.goalA) {
      const g = $(`#sheet input[name="goalA"][value="${sheet.goalA}"]`);
      if (g) g.checked = true;
    }
    if (sheet.goalB) {
      const g = $(`#sheet input[name="goalB"][value="${sheet.goalB}"]`);
      if (g) g.checked = true;
    }
    if (sheet.winner) {
      const w = $(`#sheet input[name="winner"][value="${sheet.winner}"]`);
      if (w) w.checked = true;
    }
    (sheet.racks || []).forEach((entry) => {
      ["A", "B"].forEach((side) => {
        (entry[side]?.balls || []).forEach((n) => {
          const el = $(`#sheet .ball[data-rack="${entry.rack}"][data-side="${side}"][data-num="${n}"]`);
          if (el) { el.classList.add("on"); el.setAttribute("aria-pressed", "true"); }
        });
        const foulEl = $(`#sheet input[data-foul][data-rack="${entry.rack}"][data-side="${side}"]`);
        if (foulEl) foulEl.value = entry[side]?.fouls || "";
      });
    });
    recomputeSheet(spec);
  }

  // ============================================================
  // Bracket rendering
  // ============================================================
  function applyTournamentToSetup() {
    const t = activeT();
    if (!t) return;
    const g = gameOf(t);
    $("#tournamentTitle").textContent = t.name;
    const dt = [t.date, t.startTime].filter(Boolean).join(" ").trim();
    $("#tournamentTagline").textContent = `${g.name} \u00b7 ${formatLabel(t.format)} \u00b7 ${g.raceLabel} ${t.raceTo}${dt ? " \u00b7 " + dt : ""}`;
    $("#tName").value = t.name || "";
    $("#tDate").value = t.date || "";
    $("#tTime").value = t.startTime || "";
    $("#tGame").value = t.game || "fifteenBall";
    $("#tTableCount").value = Array.isArray(t.tables) ? t.tables.length : DEFAULT_TABLE_COUNT;
    $("#tTableNaming").placeholder = window.Tables ? window.Tables.namingPlaceholder(t.tables?.length || DEFAULT_TABLE_COUNT) : "1-6";
    // Show the *current* naming as a hint only when the user has customized it.
    // Blank input keeps the placeholder visible.
    const currentNames = Array.isArray(t.tables) ? t.tables.map(x => x.name) : [];
    const defaultNames = window.Tables ? window.Tables._defaultNames(1, currentNames.length) : [];
    const isDefaultNaming = JSON.stringify(currentNames) === JSON.stringify(defaultNames);
    $("#tTableNaming").value = isDefaultNaming ? "" : currentNames.join(", ");
    $("#tFormat").value = t.format || "single";
    $("#tRaceTo").value = t.raceTo || g.defaultRaceTo;
    // Sync game-driven UI text
    $("#tGameHint").textContent = g.scoringHint;
    $("#tRaceLabel").textContent = g.raceLabel;
    $("#tRaceHint").textContent = g.raceHint;
    $("#sheetGameTitle").textContent = g.name;
    $("#participantList").value = participantsToText(t.participants);
    refreshParticipantCount();
  }

  function renderBracket() {
    const t = activeT();
    const wrap = $("#bracketWrap");
    if (!t || !t.bracket) { wrap.hidden = true; return; }
    wrap.hidden = false;

    const container = $("#bracket");
    container.innerHTML = "";

    const groups = { W: {}, L: {}, GF: {} };
    Object.values(t.bracket.matches).forEach((m) => {
      groups[m.bracket] = groups[m.bracket] || {};
      groups[m.bracket][m.round] = groups[m.bracket][m.round] || [];
      groups[m.bracket][m.round].push(m);
    });
    Object.keys(groups).forEach((br) => {
      Object.keys(groups[br]).forEach((r) => {
        groups[br][r].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
      });
    });

    container.appendChild(renderSection(t.format === "single_elim" ? "Bracket" : "Winners Bracket", groups.W, "W", t.bracket));
    if (t.bracket.lRounds > 0) container.appendChild(renderSection("Losers Bracket", groups.L, "L", t.bracket));
    // Single elimination has no grand final: do not render an empty section.
    if (Object.keys(groups.GF).length) {
      const gfSection = renderSection("Grand Finals", groups.GF, "GF", t.bracket);
      gfSection.classList.add("gf-region");
      container.appendChild(gfSection);
    }

    const played = Object.values(t.bracket.matches).filter((m) => m.winner !== null && !m.resolvedAutoBye).length;
    const total = Object.values(t.bracket.matches).filter((m) => !m.conditional || (m.slots[0] && m.slots[1])).length;
    const g = gameOf(t);
    $("#statusText").textContent = `${g.name} \u00b7 ${t.participants.length} players \u00b7 ${played} of ${total} matches decided \u00b7 ${formatLabel(t.format)} \u00b7 ${g.raceLabel} ${t.raceTo}`;

    // The batch the desk prints first (decision 018): Round 1 while it still has a sheet to
    // print. The count is what is left, so the button says how much of it that is.
    const r1Open = window.SheetQueue
      ? window.SheetQueue.roundOne(t).filter((e) => e.state !== "printed").length
      : 0;
    const r1Btn = $("#printRound1Btn");
    if (r1Btn) {
      r1Btn.hidden = r1Open === 0;
      r1Btn.textContent = `\uD83D\uDDA8 Print all Round 1 sheets (${r1Open})`;
    }

    const banner = $("#champBanner");
    if (t.bracket.champion) {
      banner.hidden = false;
      banner.textContent = `\uD83C\uDFC6  Champion: ${t.bracket.champion.name}`;
    } else {
      banner.hidden = true;
    }
  }

  function renderSection(title, roundsMap, bracket, bracketState) {
    const section = document.createElement("div");
    section.className = "bracket-section";
    const h = document.createElement("h4");
    h.className = "bracket-section-title";
    h.textContent = title;
    section.appendChild(h);

    const rounds = document.createElement("div");
    rounds.className = "bracket-rounds";
    const roundKeys = Object.keys(roundsMap || {}).map(Number).sort((a, b) => a - b);
    roundKeys.forEach((rk) => {
      const col = document.createElement("div");
      col.className = "bracket-round";
      const rh = document.createElement("div");
      rh.className = "bracket-round-title";
      rh.textContent = roundTitle(bracket, rk, bracketState);
      col.appendChild(rh);
      roundsMap[rk].forEach((match) => col.appendChild(renderMatchCard(match)));
      if (bracket === "GF" && rk === bracketState.wRounds + 2) {
        const note = document.createElement("div");
        note.className = "gf2-note";
        note.textContent = "Only played if the L-champ wins GF1";
        col.appendChild(note);
      }
      rounds.appendChild(col);
    });
    section.appendChild(rounds);
    return section;
  }

  function roundTitle(bracket, round, bracketState) {
    if (bracket === "GF") return round === bracketState.wRounds + 1 ? "GF1" : "GF2 (Reset)";
    const totalW = bracketState.wRounds;
    if (bracket === "W") {
      if (round === totalW) return "W-Final";
      if (round === totalW - 1 && totalW >= 2) return "W-Semis";
      return "W Round " + round;
    }
    const totalL = bracketState.lRounds;
    if (round === totalL) return "L-Final";
    if (round === totalL - 1 && totalL >= 2) return "L-Semis";
    return "L Round " + round;
  }

  function renderMatchCard(match) {
    const card = document.createElement("div");
    card.className = "match-card";
    card.dataset.matchId = match.id;

    const playable = match.slots[0] && match.slots[1]
      && !match.slots[0].isBye && !match.slots[1].isBye;
    const decided = match.winner !== null;

    if (!playable) card.classList.add("pending");
    else if (decided) card.classList.add("decided");
    else card.classList.add("playable");

    const idBadge = document.createElement("span");
    idBadge.className = "match-id";
    idBadge.textContent = match.id;
    card.appendChild(idBadge);

    [0, 1].forEach((slotIdx) => {
      const s = match.slots[slotIdx];
      const row = document.createElement("div");
      row.className = "slot";
      if (!s) {
        row.classList.add("empty");
        row.innerHTML = `<span class="nm">&mdash; awaiting &mdash;</span>`;
      } else if (s.isBye) {
        row.classList.add("bye");
        row.innerHTML = `<span class="nm">BYE</span>`;
      } else {
        // The bracket records who won and who lost, and nothing else: no score on the card.
        // The score sheet is a separate artifact (the modal, and sheet-payload.js downstream).
        if (decided) row.classList.add(match.winner === slotIdx ? "winner" : "loser");
        const seed = s.seed ? `<span class="sd">#${s.seed}</span>` : "";
        row.innerHTML = `<span>${seed}<span class="nm">${escapeHtml(s.name)}</span></span>`;
      }
      card.appendChild(row);
    });

    if (playable) {
      card.addEventListener("click", () => openMatch(match.id));
    }
    appendSheetControl(card, match);
    return card;
  }

  /**
   * The printed-sheet control on a match card (decision 018): "Sheet" when the match has
   * both players and no paper yet, an amber "Reprint (vN)" naming the version the reprint
   * will carry when the bracket has changed under the sheet that was printed. A sheet that
   * is still current gets no control — it is in the queue page's "Recently printed" — and
   * neither has a match whose players are not both known.
   */
  function appendSheetControl(card, match) {
    const t = activeT();
    if (!window.SheetQueue || !t) return;
    const state = window.SheetQueue.state(match, t);
    if (state !== "ready" && state !== "stale") return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = state === "stale" ? "sheetbtn stale" : "sheetbtn";
    btn.dataset.match = match.id;
    const version = state === "stale" ? window.SheetQueue.issue(match).version + 1 : 1;
    btn.textContent = state === "stale"
      ? `\uD83D\uDDA8 Reprint (v${version})`
      : "\uD83D\uDDA8 Sheet";
    btn.title = state === "stale"
      ? "The players or the target changed after this sheet was printed, so print it again"
      : "Print this match's pre-filled paper sheet";
    btn.addEventListener("click", (ev) => {
      // The card's own click opens the score sheet, and this button sits inside the card.
      ev.stopPropagation();
      openPrintPage(t, { matchId: match.id });
    });
    card.appendChild(btn);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
  }

  // ============================================================
  // Match modal
  // ============================================================
  function openMatch(matchId) {
    const t = activeT();
    if (!t) return;
    const match = t.bracket.matches[matchId];
    if (!match || !match.slots[0] || !match.slots[1]) return;
    activeMatchId = matchId;
    const info = { matchId, playerA: match.slots[0], playerB: match.slots[1] };
    renderSheetBody(t);
    $("#matchEyebrow").textContent = matchLabel(match);
    $("#matchTitle").textContent = `${match.slots[0].name}  vs.  ${match.slots[1].name}`;
    applySheet(t.sheets[matchId] || null, info, t.game);
    // A games-won match opens on its scoring surface; the paper sheet is one tap away.
    if (!window.Sheets.isRack(t.game)) {
      $("#matchModal").hidden = true;
      document.body.style.overflow = "";
      openScoreMode();
      return;
    }
    $("#matchModal").hidden = false;
    document.body.style.overflow = "hidden";
  }

  /**
   * Build the sheet's body for this tournament's game: a rack grid for the ball-marked
   * disciplines, a games tally for the rest. Everything a sheet needs to differ by
   * discipline comes from sheets.js — the measurement decides the controls, the spec the
   * geometry and wording — so this is the only place that branches.
   */
  function renderSheetBody(t) {
    const spec = sheetOf(t.game);
    const rack = window.Sheets.isRack(t.game);
    $("#sheetGameTitle").textContent = gameOf(t).name;
    $("#racks").hidden = !rack;
    $("#race").hidden = rack;
    $("#sheetTotals").hidden = !rack;
    // A race's sheet is a detail view: score mode owns its Save, and Back returns there.
    // A ball-marked sheet is the scoring surface itself, so it keeps Save and Cancel.
    const back = $("#sheetBackToScoreBtn");
    if (back) back.hidden = rack;
    const cancel = $("#closeMatchBtn");
    if (cancel) cancel.hidden = !rack;
    const save = $("#saveMatchBtn");
    if (save) save.hidden = !rack;
    $$("#sheet [data-final-label]").forEach((el) => { el.textContent = spec.finalLabel || ""; });
    // A goal box belongs to a ball-marked sheet; a race's target is the tournament's.
    $$("#sheet .goalbox").forEach((el) => { el.hidden = !rack; });
    if (rack) {
      renderGoals("A", t.game);
      renderGoals("B", t.game);
      renderRacks(spec);
    } else {
      renderRace(t, gameOf(t));
    }
    return spec;
  }

  /** Goal checkboxes for one side, in the discipline's own usual targets. */
  function renderGoals(side, game) {
    const box = $(`#sheet [data-goals="${side}"]`);
    if (!box) return;
    const presets = window.Sheets.goals(game);
    const radio = (value, label, checked) =>
      `<label><input type="radio" name="goal${side}" value="${value}"${checked ? " checked" : ""} />` +
      `<span>${label}</span></label>`;
    box.innerHTML = presets.map((g, i) => radio(String(g), String(g), i === 0)).join("") +
      `<label class="other"><input type="radio" name="goal${side}" value="other" /><span>OTHER</span>` +
      `<input type="number" inputmode="numeric" pattern="[0-9]*" min="1" max="999" step="1" ` +
      `data-field="goal${side}Other" aria-label="Other goal for Player ${side}" /></label>`;
  }

  /** The games-won body: a tally per side against the tournament's goal. */
  function renderRace(t, g) {
    $("#raceTarget").textContent = `Goal ${t.raceTo}`;
    raceSet("A", 0);
    raceSet("B", 0);
  }

  function raceGet(side) {
    return parseInt($(`#race${side}Score`).textContent, 10) || 0;
  }
  /** The tournament's goal, or 0 when it has none to speak of. */
  function raceTarget(t) {
    return (t && (t.raceTo || gameOf(t).defaultRaceTo)) || 0;
  }

  function checkedWinner() {
    const a = $(`#sheet input[name="winner"][value="A"]`);
    const b = $(`#sheet input[name="winner"][value="B"]`);
    if (a && a.checked === true) return "A";
    if (b && b.checked === true) return "B";
    const checked = $(`#sheet input[name="winner"]:checked`);
    return checked && (checked.value === "A" || checked.value === "B") ? checked.value : "";
  }

  function setWinnerRadio(side) {
    ["A", "B"].forEach((s) => {
      const r = $(`#sheet input[name="winner"][value="${s}"]`);
      if (r) r.checked = side === s;
    });
  }

  /** Which side the goal rule would pick right now, or "" when it picks none. */
  function autoWinnerFor(race) {
    if (race <= 0) return "";
    const a = raceGet("A"), b = raceGet("B");
    if (a >= race && a > b) return "A";
    if (b >= race && b > a) return "B";
    return "";
  }

  /**
   * Keep an auto-selected winner honest: an automatic pick is cleared (or moved to the
   * other side) when a correction means it no longer holds. A manual pick is never touched.
   */
  function reconcileWinner(race) {
    const current = checkedWinner();
    if (winnerAuto && current) {
      const valid = autoWinnerFor(race);
      if (valid !== current) { setWinnerRadio(valid); winnerAuto = !!valid; }
    }
    if (!checkedWinner()) {
      const next = autoWinnerFor(race);
      if (next) { setWinnerRadio(next); winnerAuto = true; }
    }
  }

  function raceSet(side, n) {
    const t = activeT();
    const race = raceTarget(t);
    // The goal selects the winner; it is not a ceiling. A run may finish past it (14.1 and
    // 15-ball players complete the run after reaching the goal), and a tally may also go
    // below zero, so the desk can correct an over-count.
    const v = n | 0;
    $(`#race${side}Score`).textContent = String(v);
    if (t) {
      reconcileWinner(race);
      persistInProgress();
    }
    const sm = $("#scoreMode");
    if (sm && !sm.hidden) syncScoreMode();
  }
  function raceInc(side) { raceSet(side, raceGet(side) + 1); }
  function raceDec(side) { raceSet(side, raceGet(side) - 1); }

  // ============================================================
  // Swipe to step the tally (the phone gesture, from the Android app's SwipePanel)
  // ============================================================
  // A mostly-vertical drag on the tally is one step: up +1, down -1, on the side of the panel
  // the gesture started in. It is a shortcut for the +/- buttons, which stay the accessible
  // and desktop path, and it answers touch and pen pointers only — a vertical mouse drag must
  // keep scrolling the page.
  const SWIPE_MIN_TRAVEL = 48;   // CSS px, the 48dp threshold the app uses

  // Touch and pen everywhere; score mode also takes the mouse because it never scrolls,
  // while the sheet keeps the mouse free to scroll its modal.
  function isSwipePointer(ev, allowMouse) {
    return ev.pointerType === "touch" || ev.pointerType === "pen" ||
      (allowMouse && ev.pointerType === "mouse");
  }

  /** One short buzz where the platform offers one, silently where it does not. */
  function hapticTap() {
    if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") return;
    try { navigator.vibrate(10); } catch (e) { /* no haptics, no complaint */ }
  }

  /**
   * Which player's half a gesture started in. The tally is side by side on desktop and
   * stacked at <=620px, so the x midpoint is only correct for one of them: prefer the
   * `.counter-side` card under the finger, then the cards' own geometry, then the panel
   * midpoint. This keeps the gesture attached to a player in both layouts.
   */
  function sideAt(panel, ev) {
    const target = ev.target;
    const card = target && typeof target.closest === "function"
      ? target.closest("[data-side]")
      : null;
    if (card && card.dataset && (card.dataset.side === "A" || card.dataset.side === "B")) {
      return card.dataset.side;
    }
    // Score mode attaches the gesture to one half, so the panel itself names the side.
    const own = panel.dataset && panel.dataset.side;
    if (own === "A" || own === "B") return own;
    const canQuery = typeof panel.querySelector === "function";
    const a = canQuery ? panel.querySelector('[data-side="A"]') : null;
    const b = canQuery ? panel.querySelector('[data-side="B"]') : null;
    if (a && b && typeof a.getBoundingClientRect === "function" && typeof b.getBoundingClientRect === "function") {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      const stacked = ra.bottom <= rb.top + 1 || rb.bottom <= ra.top + 1;
      if (stacked) {
        const aFirst = ra.top <= rb.top;
        const mid = (Math.max(ra.top, rb.top) + Math.min(ra.bottom, rb.bottom)) / 2;
        return (ev.clientY <= mid) === aFirst ? "A" : "B";
      }
      const aLeft = ra.left <= rb.left;
      const mid = aLeft ? (ra.right + rb.left) / 2 : (rb.right + ra.left) / 2;
      return (ev.clientX <= mid) === aLeft ? "A" : "B";
    }
    const rect = panel.getBoundingClientRect();
    return ev.clientX < rect.left + rect.width / 2 ? "A" : "B";
  }

  function wireSwipe(panel, allowMouse) {
    if (!panel) return;
    let id = null;                          // the pointer that owns the gesture in flight
    let startX = 0, startY = 0, startSide = "A";
    let taken = false;                      // this gesture has already been reported
    let swallow = false;                    // the press it started on is cancelled, not scored

    panel.addEventListener("pointerdown", (ev) => {
      if (id !== null || !isSwipePointer(ev, allowMouse)) return;
      id = ev.pointerId;
      startX = ev.clientX;
      startY = ev.clientY;
      startSide = sideAt(panel, ev);        // read the start layout once, where the finger landed
      taken = false;
      swallow = false;
    });
    panel.addEventListener("pointermove", (ev) => {
      if (ev.pointerId !== id || taken) return;
      const dy = ev.clientY - startY;
      const dx = Math.abs(ev.clientX - startX);
      // A drag past a small slop is not a tap: cancel the release click even when it is
      // too short to score, so a 20px wobble on the score or + cannot add a game.
      if (Math.abs(dy) > 8 || dx > 8) swallow = true;
      if (Math.abs(dy) < SWIPE_MIN_TRAVEL || Math.abs(dy) <= dx) return;
      taken = true;
      swallow = true;
      // The gesture is taken from whatever is under the finger: the panel keeps the moves,
      // and the click the child would have got on release is cancelled below instead of
      // scoring a second time.
      if (ev.cancelable) ev.preventDefault();
      if (panel.setPointerCapture) {
        try { panel.setPointerCapture(ev.pointerId); } catch (e) { /* already gone */ }
      }
      // The side the gesture started on (in the layout it started in), not the side of
      // wherever the finger has travelled to. The same step the buttons take: the gesture
      // is a shortcut, never the only way to score.
      if (dy < 0) raceInc(startSide); else raceDec(startSide);
      hapticTap();
    });
    const end = (ev) => {
      if (ev.pointerId !== id) return;
      id = null;
      taken = false;
    };
    panel.addEventListener("pointerup", end);
    panel.addEventListener("pointercancel", end);
    // Capture phase, so a swallowed click never reaches the child or the delegated handler.
    panel.addEventListener("click", (ev) => {
      if (!swallow) return;
      swallow = false;
      ev.stopPropagation();
      ev.preventDefault();
    }, true);
  }

  function matchLabel(match) {
    const t = activeT();
    const g = gameOf(t);
    const round = roundTitle(match.bracket, match.round, t.bracket);
    return `${t.name} \u2022 ${round} \u2022 ${match.id} \u2022 ${g.raceLabel} ${t.raceTo}`;
  }

  // ============================================================
  // Export helpers
  // ============================================================
  function openExportMenu() {
    if (!activeT()) return;
    $("#exportModal").hidden = false;
    document.body.style.overflow = "hidden";
  }
  function closeExportMenu() {
    $("#exportModal").hidden = true;
    document.body.style.overflow = "";
  }
  function downloadBlob(filename, mime, data) {
    const blob = new Blob([data], { type: mime });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1500);
  }
  function csvCell(s) {
    if (s == null) return "";
    const str = String(s);
    return /[",\n]/.test(str) ? '"' + str.replace(/"/g, '""') + '"' : str;
  }
  function exportChallongeCsv(t) {
    // Challonge participants CSV: Name, Seed, Misc
    const lines = ["Name,Seed,Misc"];
    (t.participants || []).forEach((p, i) => {
      lines.push([csvCell(p.name), csvCell(p.seed || i + 1), csvCell(p.fargo ? `Fargo ${p.fargo}` : "")].join(","));
    });
    const fn = `${t.name.replace(/[^\w\-]+/g, "_")}_challonge_participants.csv`;
    downloadBlob(fn, "text/csv;charset=utf-8", lines.join("\n"));
    toast("Downloaded Challonge CSV");
  }
  function exportMatchesCsv(t) {
    if (!t.bracket) { alert("Build the bracket first."); return; }
    const g = gameOf(t);
    const rows = [["Match", "Round", "Winner", "Loser", "WinnerScore", "LoserScore", "Game", "Bracket"]];
    Object.values(t.bracket.matches).forEach((m) => {
      if (m.winner === null || m.resolvedAutoBye) return;
      const wSlot = m.slots[m.winner];
      const lSlot = m.slots[m.winner === 0 ? 1 : 0];
      if (!wSlot || !lSlot || wSlot.isBye || lSlot.isBye) return;
      const sh = t.sheets ? t.sheets[m.id] : null;
      let wScore = "", lScore = "";
      if (sh) {
        wScore = m.winner === 0 ? (sh.finalA ?? "") : (sh.finalB ?? "");
        lScore = m.winner === 0 ? (sh.finalB ?? "") : (sh.finalA ?? "");
      }
      const roundLabel = roundTitle(m.bracket, m.round, t.bracket);
      rows.push([m.id, roundLabel, wSlot.name, lSlot.name, wScore, lScore, g.name, m.bracket]);
    });
    if (rows.length === 1) { alert("No decided matches yet."); return; }
    const csv = rows.map((r) => r.map(csvCell).join(",")).join("\n");
    const fn = `${t.name.replace(/[^\w\-]+/g, "_")}_matches.csv`;
    downloadBlob(fn, "text/csv;charset=utf-8", csv);
    toast("Downloaded matches CSV");
  }

  /** The printed-sheet queue page's URL: this tournament, one match, or the Round 1 batch. */
  function printPageUrl(t, opts) {
    if (window.SheetQueue) return window.SheetQueue.uri(t, opts || {});
    let url = `print.html?t=${encodeURIComponent(t.id)}`;
    if (opts && opts.matchId) url += `&m=${encodeURIComponent(opts.matchId)}`;
    if (opts && opts.roundOne) url += "&round=1";
    return url;
  }

  /** Open the queue page in its own tab (decision 018), so the bracket stays where it was. */
  function openPrintPage(t, opts) {
    if (!t) return;
    const url = printPageUrl(t, opts);
    if (typeof window.open === "function") { window.open(url, "_blank", "noopener"); return; }
    // A popup blocker's fallback, and the only path a headless page has.
    if (window.location) window.location.href = url;
  }

  function closeMatch() {
    saveProgressNow();
    closeScoreMode();
    $("#matchModal").hidden = true;
    document.body.style.overflow = "";
    activeMatchId = null;
  }

  /** The numeric goal a rack sheet's side declares, or 0 when it has none. */
  function goalOf(side) {
    const checked = $(`#sheet input[name="goal${side}"]:checked`);
    const value = checked && checked.value;
    if (value === "other") {
      const other = $(`#sheet input[data-field="goal${side}Other"]`);
      return parseInt(other && other.value, 10) || 0;
    }
    return parseInt(value, 10) || 0;
  }

  /**
   * The winner a saved sheet implies when the desk has not picked one. A player who has
   * reached their goal while the other has not is the result, handicap or not. Otherwise
   * the player ahead wins — unless the score is level, or a handicap (different goals)
   * makes "ahead" meaningless; there the desk still chooses.
   */
  function impliedWinner(sheet, game) {
    let ga = 0, gb = 0;
    if (window.Sheets.isRack(game)) {
      ga = goalOf("A");
      gb = goalOf("B");
    }
    const reachedA = ga > 0 && sheet.finalA >= ga;
    const reachedB = gb > 0 && sheet.finalB >= gb;
    if (reachedA && !reachedB) return "A";
    if (reachedB && !reachedA) return "B";
    if (sheet.finalA === sheet.finalB) return "";
    if (ga > 0 && gb > 0 && ga !== gb) return "";
    return sheet.finalA > sheet.finalB ? "A" : "B";
  }

  function saveMatch() {
    if (!activeMatchId) return false;
    const t = activeT();
    if (!t) return false;
    clearTimeout(progressTimer);
    progressTimer = null;
    const sheet = collectSheet(t.game);
    let inferred = false;
    if (!sheet.winner) {
      const implied = impliedWinner(sheet, t.game);
      if (implied) {
        sheet.winner = implied;
        inferred = true;
        const radio = $(`#sheet input[name="winner"][value="${implied}"]`);
        if (radio) radio.checked = true;
      } else {
        const why = sheet.finalA === sheet.finalB
          ? "The scores are tied"
          : "The players have different goals";
        if (!confirm(`${why}; no winner can be assumed. Save it as an in-progress match anyway (bracket won't advance)?`)) return false;
        t.sheets[activeMatchId] = sheet;
        writeStore();
        renderBracket();
        toast("Saved on this device (no winner set) — this console has no server link, so the sheet stays in this browser.");
        return true;
      }
    }
    t.sheets[activeMatchId] = sheet;
    const winnerSlot = sheet.winner === "A" ? 0 : 1;
    const scoreSummary = `${sheet.finalA}-${sheet.finalB}`;
    window.BracketEngine.recordWinner(t.bracket, activeMatchId, winnerSlot, { score: scoreSummary });
    writeStore();
    renderBracket();
    closeMatch();
    toast(inferred ? `${DEVICE_SAVE_NOTE} Winner taken from the score.` : DEVICE_SAVE_NOTE);
    return true;
  }

  // ============================================================
  // Score mode: the full-screen, two-half tally (the Android scoreboard's shape)
  // ============================================================
  // Each half is a vertical column — name, + arrow, score, - arrow — and the whole half is
  // a swipe target. The overlay is fixed and non-scrolling; the browser's own fullscreen
  // remains available, but the app does not commandeer it on open. It reads and writes the
  // same tally as the sheet and autosaves the in-progress sheet, so leaving loses nothing.

  function bump(el) {
    if (!el || !el.classList) return;
    el.classList.remove("bump");
    void el.offsetWidth;       // restart the animation
    el.classList.add("bump");
    clearTimeout(el._bumpT);
    el._bumpT = setTimeout(() => el.classList.remove("bump"), 180);
  }

  function syncScoreMode() {
    const a = $("#smAScore"), b = $("#smBScore");
    if (a) {
      const v = String(raceGet("A"));
      if (a.textContent !== v) bump(a);
      a.textContent = v;
      a.setAttribute("aria-label", `Player A score ${v} — add a game`);
    }
    if (b) {
      const v = String(raceGet("B"));
      if (b.textContent !== v) bump(b);
      b.textContent = v;
      b.setAttribute("aria-label", `Player B score ${v} — add a game`);
    }
    const chip = $("#smWinner");
    if (chip) {
      const side = checkedWinner();
      const name = side === "A" ? ($("#raceANm").textContent || "Player A")
        : side === "B" ? ($("#raceBNm").textContent || "Player B") : "";
      chip.textContent = side ? `Winner: ${name}` : "No winner";
      if (side) chip.classList.add("set"); else chip.classList.remove("set");
    }
  }

  function openScoreMode() {
    if (!activeMatchId || $("#race").hidden) return;
    const overlay = $("#scoreMode");
    if (!overlay) return;
    if ($("#smANm")) $("#smANm").textContent = $("#raceANm").textContent || "Player A";
    if ($("#smBNm")) $("#smBNm").textContent = $("#raceBNm").textContent || "Player B";
    if ($("#smTarget")) $("#smTarget").textContent = $("#raceTarget").textContent || "";
    syncScoreMode();
    overlay.hidden = false;
    document.body.classList.add("score-mode-open");
    if (document.documentElement) document.documentElement.classList.add("score-mode-open");
    if (store.get(SM_HINT_KEY) !== "1") {
      store.set(SM_HINT_KEY, "1");
      toast("Swipe up or down on a player's half — or tap the arrows", 5000);
    }
  }

  function closeScoreMode() {
    const overlay = $("#scoreMode");
    if (overlay) overlay.hidden = true;
    document.body.classList.remove("score-mode-open");
    if (document.documentElement) document.documentElement.classList.remove("score-mode-open");
  }

  function scoreModeStep(side, delta) {
    if (side !== "A" && side !== "B") return;
    if (delta > 0) raceInc(side); else raceDec(side);
    syncScoreMode();
  }

  /** The winner chip: no winner -> A -> B -> no winner, always a manual pick. */
  function cycleScoreWinner() {
    const current = checkedWinner();
    const next = current === "" ? "A" : current === "A" ? "B" : "";
    setWinnerRadio(next);
    winnerAuto = false;       // the desk chose it; the goal rule must not override
    syncScoreMode();
    persistInProgress();
  }

  function scoreModeSave() {
    if (!activeMatchId) return;
    if (saveMatch()) closeScoreMode();
  }

  /** Score mode -> the paper/detail sheet. */
  function scoreModeToSheet() {
    closeScoreMode();
    $("#matchModal").hidden = false;
    document.body.style.overflow = "hidden";
  }

  /** The sheet -> back to score mode (its prominent close). */
  function sheetToScoreMode() {
    $("#matchModal").hidden = true;
    document.body.style.overflow = "";
    openScoreMode();
  }

  function clearMatch() {
    if (!activeMatchId) return;
    const t = activeT();
    if (!t) return;
    if (!confirm("Clear this match sheet? Also removes the winner from the bracket.")) return;
    clearTimeout(progressTimer);
    progressTimer = null;
    winnerAuto = false;
    delete t.sheets[activeMatchId];
    const m = t.bracket.matches[activeMatchId];
    if (m && m.winner !== null) {
      m.winner = null;
      m.score = null;
      rebuildFromParticipants();
    }
    applySheet(null, { matchId: activeMatchId, playerA: m.slots[0], playerB: m.slots[1] }, t.game);
    persist();
    renderBracket();
    toast("Cleared");
  }

  // ============================================================
  // Bracket actions
  // ============================================================
  function buildBracket() {
    const t = activeT();
    if (!t) return;
    const list = parseParticipants($("#participantList").value);
    if (list.length < 2) { alert("Need at least 2 participants."); return; }
    // If a bracket already exists and has decisions, warn.
    if (t.bracket && Object.values(t.bracket.matches).some((m) => m.winner !== null && !m.resolvedAutoBye)) {
      if (!confirm("Rebuilding the bracket will discard all recorded results. Continue?")) return;
    }
    t.participants = list;
    t.name = $("#tName").value || t.name;
    t.date = $("#tDate").value || t.date;
    t.startTime = $("#tTime").value || t.startTime || "";
    // Table roster: rebuild only if count OR naming actually changed, so
    // existing table IDs (referenced by future assignments) are preserved
    // whenever possible.
    const desiredCount = Math.max(1, Math.min(64, parseInt($("#tTableCount").value, 10) || DEFAULT_TABLE_COUNT));
    const desiredNaming = $("#tTableNaming").value.trim();
    const wantNames = window.Tables ? window.Tables.parseNaming(desiredCount, desiredNaming) : [];
    const haveNames = (t.tables || []).map(x => x.name);
    if (JSON.stringify(wantNames) !== JSON.stringify(haveNames)) {
      t.tables = window.Tables.buildTables(desiredCount, desiredNaming);
    }
    const chosenGame = $("#tGame").value;
    if (GAMES[chosenGame]) t.game = chosenGame;
    t.format = $("#tFormat").value || "single";
    t.raceTo = parseInt($("#tRaceTo").value, 10) || gameOf(t).defaultRaceTo;
    const prevBracket = t.bracket;
    t.bracket = window.BracketEngine.build(list, { format: t.format });
    carrySheetIssues(prevBracket, t.bracket);
    t.sheets = {};
    applyTournamentToSetup();
    persist();
    renderBracket();
    document.getElementById("bracketWrap").scrollIntoView({ behavior: "smooth", block: "start" });
    toast("Bracket built");
  }

  /**
   * A rebuilt bracket keeps a match's id, so it keeps the printed sheet's record too: the
   * paper in the desk's hand is still that match's sheet, and a pairing that changed under it
   * becomes the reprint the queue then asks for (decision 018).
   */
  function carrySheetIssues(prev, next) {
    if (window.SheetQueue) window.SheetQueue.carry(prev, next);
  }

  function rebuildFromParticipants() {
    const t = activeT();
    if (!t || !t.participants.length) return;
    const prevSheets = Object.assign({}, t.sheets);
    const prevBracket = t.bracket;
    t.bracket = window.BracketEngine.build(t.participants, { format: t.format });
    carrySheetIssues(prevBracket, t.bracket);
    t.sheets = {};
    Object.keys(prevSheets).forEach((mid) => {
      if (t.bracket.matches[mid]) t.sheets[mid] = prevSheets[mid];
    });
    const ordered = window.BracketEngine.matchesInOrder(t.bracket);
    ordered.forEach((m) => {
      const sh = t.sheets[m.id];
      // recordWinner refuses an empty or BYE slot, and a rebuilt bracket can
      // reshape a sheet's match (a late entry turns a bye into a real game), so
      // only replay a decided sheet onto a match that is playable now.
      if (sh && sh.winner && window.BracketEngine.isMatchReady(m)) {
        const winnerSlot = sh.winner === "A" ? 0 : 1;
        window.BracketEngine.recordWinner(t.bracket, m.id, winnerSlot, { score: `${sh.finalA}-${sh.finalB}` });
      }
    });
  }

  // ============================================================
  // Late entry modal
  // ============================================================
  function openLateEntry() {
    const t = activeT();
    if (!t || !t.bracket) { alert("Build the bracket first."); return; }
    $("#lateEntryName").value = "";
    $("#lateEntryFargo").value = "";
    $$("input[name=\"lateEntrySide\"]").forEach((r) => { r.checked = r.value === "W"; });
    $("#lateEntryModal").hidden = false;
    document.body.style.overflow = "hidden";
    setTimeout(() => $("#lateEntryName").focus(), 30);
  }
  function closeLateEntry() {
    $("#lateEntryModal").hidden = true;
    document.body.style.overflow = "";
  }
  function confirmLateEntry() {
    const t = activeT();
    if (!t || !t.bracket) return;
    const name = $("#lateEntryName").value.trim();
    if (!name) { alert("Please enter a player name."); return; }
    const fargo = parseInt($("#lateEntryFargo").value, 10);
    const side = ($$("input[name=\"lateEntrySide\"]").find((r) => r.checked) || {}).value || "W";
    const participant = { name, fargo: isNaN(fargo) ? null : fargo, notes: "Late entry" };
    const res = window.BracketEngine.addLateEntry(t.bracket, participant, side);
    if (!res.placed) {
      alert("Couldn't add late entry: " + (res.reason || "no open slot") + "\n\nTry the other bracket side, or reset the bracket to include them from the start.");
      return;
    }
    // Reflect the new participants list in the setup textarea/state
    t.participants = t.bracket.participants.slice();
    applyTournamentToSetup();
    persist();
    renderBracket();
    closeLateEntry();
    toast(`Added ${name} to ${side === "W" ? "winners" : "losers"} bracket (${res.matchId})${res.note ? " \u2014 " + res.note : ""}`);
  }

  // ============================================================
  // Wiring
  // ============================================================
  function wireUp() {
    $("#participantList").addEventListener("input", refreshParticipantCount);
    // Game selector: update hints and default race-to when user changes game
    $("#tGame").addEventListener("change", () => {
      const gid = $("#tGame").value;
      const g = GAMES[gid] || GAMES.fifteenBall;
      $("#tGameHint").textContent = g.scoringHint;
      $("#tRaceLabel").textContent = g.raceLabel;
      $("#tRaceHint").textContent = g.raceHint;
      $("#tRaceTo").value = g.defaultRaceTo;
    });
    // Table count → live placeholder update on the naming field.
    $("#tTableCount").addEventListener("input", () => {
      const n = Math.max(1, Math.min(64, parseInt($("#tTableCount").value, 10) || DEFAULT_TABLE_COUNT));
      $("#tTableNaming").placeholder = window.Tables ? window.Tables.namingPlaceholder(n) : `1-${n}`;
    });
    // Games-won tally inside the sheet (delegated): the +/- step buttons, one game each.
    // There is no quick-add control and no case for one: a jump can overshoot a race, and no
    // discipline offers one (sheets.js -> quickAdd).
    document.body.addEventListener("click", (ev) => {
      const inc = ev.target.closest("[data-race-inc]");
      if (inc) { raceInc(inc.dataset.raceInc); return; }
      const dec = ev.target.closest("[data-race-dec]");
      if (dec) { raceDec(dec.dataset.raceDec); return; }
    });
    // The tally's swipe gesture (hidden with the tally for the ball-marked disciplines).
    wireSwipe($("#race"));
    // Score mode: each half is its own swipe panel; the arrow buttons take the same step.
    document.body.addEventListener("click", (ev) => {
      const inc = ev.target.closest("[data-sm-inc]");
      if (inc) { scoreModeStep(inc.dataset.smInc, 1); return; }
      const dec = ev.target.closest("[data-sm-dec]");
      if (dec) { scoreModeStep(dec.dataset.smDec, -1); return; }
    });
    $$("#scoreMode .sm-side").forEach((el) => wireSwipe(el, true));
    // A desk pick is manual: the goal rule must never clear or override it.
    $$(`#sheet input[name="winner"]`).forEach((r) => {
      r.addEventListener("change", () => {
        winnerAuto = false;
        syncScoreMode();
        persistInProgress();
      });
    });
    document.body.addEventListener("click", (ev) => {
      const el = ev.target.closest("[data-action]");
      if (!el) return;
      handleAction(el.dataset.action);
    });
    $("#importTournamentFile").addEventListener("change", (ev) => {
      const file = ev.target.files && ev.target.files[0];
      if (!file) return;
      importTournamentFromFile(file, (t) => { showBracket(t.id); });
      ev.target.value = "";
    });
    $("#importTournamentHomeFile").addEventListener("change", (ev) => {
      const file = ev.target.files && ev.target.files[0];
      if (!file) return;
      importTournamentFromFile(file, () => { renderHome(); });
      ev.target.value = "";
    });
    // The debounced autosave must survive a reload/close: localStorage writes are
    // synchronous, so flushing on the way out is safe.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") saveProgressNow();
    });
    if (typeof window !== "undefined" && window.addEventListener) {
      window.addEventListener("pagehide", saveProgressNow);
    }
    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") {
        const t = activeT();
        if (!$("#scoreMode").hidden) closeMatch();               // Done
        else if (!$("#matchModal").hidden) {
          if (t && !window.Sheets.isRack(t.game)) sheetToScoreMode();
          else closeMatch();
        }
        else if (!$("#exportModal").hidden) closeExportMenu();
        else if (!$("#lateEntryModal").hidden) closeLateEntry();
      }
    });
  }

  function handleAction(action) {
    switch (action) {
      // ---- home view
      case "new-tournament": {
        const name = prompt("Name your new tournament:", "New Tournament");
        if (!name) return;
        const t = makeTournament(name.trim());
        app.tournaments.push(t);
        persist(0);
        showBracket(t.id);
        break;
      }
      case "import-tournament-home": $("#importTournamentHomeFile").click(); break;

      // ---- nav
      case "go-home":
        if (!$("#matchModal").hidden) closeMatch();
        if (!$("#lateEntryModal").hidden) closeLateEntry();
        showHome();
        break;
      case "rename-tournament": {
        const t = activeT(); if (!t) return;
        const name = prompt("Rename tournament:", t.name);
        if (name && name.trim()) {
          t.name = name.trim();
          applyTournamentToSetup();
          persist(0);
          toast("Renamed");
        }
        break;
      }

      // ---- bracket setup
      case "build-bracket": buildBracket(); break;
      case "shuffle-participants": {
        const list = shuffle(parseParticipants($("#participantList").value));
        $("#participantList").value = participantsToText(list);
        refreshParticipantCount();
        break;
      }
      case "sort-by-fargo": {
        const list = seedByFargo(parseParticipants($("#participantList").value));
        $("#participantList").value = participantsToText(list);
        refreshParticipantCount();
        break;
      }
      case "clear-participants":
        if (confirm("Clear the participant list?")) {
          $("#participantList").value = "";
          refreshParticipantCount();
        }
        break;
      case "load-signups":
        $("#participantList").value = participantsToText(SIGNUPS_SEPT7);
        refreshParticipantCount();
        toast("Loaded Sept 7 signups");
        break;
      case "save-tournament": persist(0); toast("Saved"); break;
      case "export-tournament": { const t = activeT(); if (t) exportTournament(t); break; }
      case "import-tournament": $("#importTournamentFile").click(); break;

      // ---- export menu
      case "open-export-menu": openExportMenu(); break;
      case "close-export": closeExportMenu(); break;
      case "export-json": { const t = activeT(); if (t) { exportTournament(t); closeExportMenu(); } break; }
      case "export-challonge-csv": { const t = activeT(); if (t) { exportChallongeCsv(t); closeExportMenu(); } break; }
      case "export-matches-csv": { const t = activeT(); if (t) { exportMatchesCsv(t); closeExportMenu(); } break; }
      case "push-challonge": alert("Push-to-Challonge requires the Cue Club backend. See RESEARCH.md and the /server directory for the Go service that provides this."); break;

      // ---- bracket
      case "add-late-entry": openLateEntry(); break;
      case "close-late-entry": closeLateEntry(); break;
      case "confirm-late-entry": confirmLateEntry(); break;
      case "print-bracket": window.print(); break;
      case "print-round1": openPrintPage(activeT(), { roundOne: true }); break;
      case "reset-bracket": {
        const t = activeT(); if (!t) return;
        if (!confirm("Reset the bracket? Rebuilds from the current participant list and clears all scores.")) return;
        t.sheets = {};
        buildBracket();
        break;
      }

      // ---- match modal / score mode
      case "close-match": {
        const t = activeT();
        // A race sheet's close returns to the scoring surface; Done closes the match.
        if (t && !window.Sheets.isRack(t.game)) { sheetToScoreMode(); break; }
        closeMatch();
        break;
      }
      case "sheet-to-score": sheetToScoreMode(); break;
      case "save-match": saveMatch(); break;          // ball-marked sheets
      case "clear-match": clearMatch(); break;
      case "score-mode-sheet": scoreModeToSheet(); break;
      case "score-mode-save": scoreModeSave(); break;
      case "score-mode-winner": cycleScoreWinner(); break;
      case "score-mode-exit": closeMatch(); break;    // Done
    }
  }

  // ============================================================
  // Init
  // ============================================================
  document.addEventListener("DOMContentLoaded", () => {
    // The sheet's body is built per match, from the tournament's game (renderSheetBody).
    wireUp();
    loadPersisted();
    if (app.activeId && activeT()) {
      showBracket(app.activeId);
    } else {
      showHome();
    }
  });
})();
