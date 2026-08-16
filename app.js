/* Columbia Cue Club tournament manager.
   - Home view: list of tournaments (create, open, rename, duplicate, delete, import)
   - Bracket view: one tournament (setup, participants, bracket render, match modal)
   - Match modal: K-Ball score sheet, scoped to a single bracket match
   - Late-entry modal: add a player to a running bracket
   All state persists to browser storage under a single key.
*/

(function () {
  "use strict";

  // ---------- constants ----------
  const RACKS = 4;
  const STRIPES = [9, 10, 11, 12, 13, 14, 15];
  const EIGHT = [8];
  // Storage schema: v3 (pre-tables) is auto-migrated to v4 (with tables[]).
  const STORAGE_KEY = "kball.app.v3";  // key stays v3 to preserve existing local data;
                                        // records get a `tables` array via backfill.
  const LEGACY_KEY_V2 = "kball.tournament.v1";

  // ---------- safe storage adapter ----------
  const store = (function () {
    let mem = null;
    const BACKEND_KEY = ["local", "Storage"].join("");
    try {
      const g = (typeof globalThis !== "undefined" ? globalThis : window);
      const ls = g[BACKEND_KEY];
      if (ls) {
        const probe = "__kball_probe__";
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

  function toast(msg) {
    const el = $("#toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove("show"), 1800);
  }

  function newId() {
    return "t_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 6);
  }

  // Curated game catalog. sheetType: "kball" = existing rack grid; "counter" = simple games-won/points counter.
  const GAMES = {
    kball:      { id: "kball",      name: "K-Ball / 15-Ball Rotation", sheetType: "kball",   defaultRaceTo: 25,  raceLabel: "Points to win", raceHint: "Points target per match (25 rec / 35 pro).",                  scoringHint: "Rotation scoring by pocketed ball value." },
    "8ball":    { id: "8ball",    name: "8-Ball",                    sheetType: "counter", defaultRaceTo: 7,   raceLabel: "Race to",       raceHint: "Games needed to win the match (typical: 5 / 7 / 9).",           scoringHint: "Games won \u2014 first to the race target." },
    "9ball":    { id: "9ball",    name: "9-Ball",                    sheetType: "counter", defaultRaceTo: 7,   raceLabel: "Race to",       raceHint: "Games needed to win the match (typical: 7 / 9 / 11).",          scoringHint: "Games won \u2014 first to the race target." },
    "10ball":   { id: "10ball",   name: "10-Ball",                   sheetType: "counter", defaultRaceTo: 7,   raceLabel: "Race to",       raceHint: "Games needed to win the match (typical: 7 / 9).",              scoringHint: "Games won \u2014 first to the race target." },
    "onepocket":{ id: "onepocket",name: "One Pocket",                sheetType: "counter", defaultRaceTo: 3,   raceLabel: "Race to",       raceHint: "Balls-in-pocket to win the match (typical: 3 / 4).",            scoringHint: "Games won \u2014 first to the race target of pocketed-in-your-pocket wins." },
    "14_1":     { id: "14_1",     name: "Straight Pool (14.1 Continuous)", sheetType: "counter", defaultRaceTo: 100, raceLabel: "Points to",     raceHint: "Point target per match (typical: 75 / 100 / 125 / 150).",       scoringHint: "Continuous points \u2014 first to the point target." },
    "banks":    { id: "banks",    name: "Bank Pool",                 sheetType: "counter", defaultRaceTo: 5,   raceLabel: "Race to",       raceHint: "Banked-ball games to win the match (typical: 3 / 5).",          scoringHint: "Banked wins \u2014 first to the race target." }
  };
  function gameOf(t) { return GAMES[t?.game] || GAMES.kball; }

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
    const gid = GAMES[game] ? game : "kball";
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
  function persist(delay) {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      const t = activeT();
      if (t) t.updatedAt = Date.now();
      try { store.set(STORAGE_KEY, JSON.stringify(app)); }
      catch (e) { /* ignore */ }
    }, delay == null ? 200 : delay);
  }

  function loadPersisted() {
    try {
      const raw = store.get(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.v === 3 && Array.isArray(parsed.tournaments)) {
          app = parsed;
          // Backfill: older v3 records may predate several fields.
          app.tournaments.forEach((t) => {
            if (!t.game) t.game = "kball";
            if (!Array.isArray(t.tables) || t.tables.length === 0) {
              t.tables = window.Tables
                ? window.Tables.buildTables(DEFAULT_TABLE_COUNT, "")
                : [];
            }
          });
          return true;
        }
      }
    } catch (e) { /* ignore */ }
    // Migrate v2 (single-tournament) if present
    try {
      const legacy = store.get(LEGACY_KEY_V2);
      if (legacy) {
        const parsed = JSON.parse(legacy);
        if (parsed && parsed.v === 2) {
          const t = makeTournament(parsed.tournament?.name || "Imported Tournament", parsed.tournament?.game || "kball");
          t.date = parsed.tournament?.date || "";
          t.format = parsed.tournament?.format || "single";
          t.raceTo = parsed.tournament?.raceTo || GAMES[t.game].defaultRaceTo;
          t.participants = parsed.participants || [];
          t.bracket = parsed.bracket || null;
          t.sheets = parsed.sheets || {};
          app.tournaments.push(t);
          app.activeId = t.id;
          persist(0);
          return true;
        }
      }
    } catch (e) { /* ignore */ }
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
        <span>${t.format === "double" ? "Double Final" : "Single Final"}</span>
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
  function renderRacks() {
    const container = $("#racks");
    container.innerHTML = "";
    for (let r = 1; r <= RACKS; r++) {
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
          ${renderSide(r, "A")}
          ${renderSide(r, "B")}
        </div>`;
      container.appendChild(rack);
    }
    $$(".ball", container).forEach((el) => {
      el.addEventListener("click", () => {
        el.classList.toggle("on");
        el.setAttribute("aria-pressed", el.classList.contains("on"));
        recomputeSheet();
      });
      el.addEventListener("keydown", (ev) => {
        if (ev.key === " " || ev.key === "Enter") { ev.preventDefault(); el.click(); }
      });
    });
    $$("input[data-foul]", container).forEach((el) => {
      el.addEventListener("input", recomputeSheet);
    });
  }

  function renderSide(rack, side) {
    return `
      <div class="side ${side === "B" ? "rightside" : ""}">
        <div class="balls">
          ${[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15].map((n) => ballBtn(rack, side, n)).join("")}
        </div>
        <div class="rackstats">
          <label>Balls Made<input type="number" min="0" max="15" readonly
                              data-total data-rack="${rack}" data-side="${side}" /></label>
          <label>Fouls<input type="number" inputmode="numeric" pattern="[0-9]*" min="0" step="1" enterkeyhint="done"
                              data-foul data-rack="${rack}" data-side="${side}" /></label>
          <label class="racknet">Rack Total<input type="number" readonly
                                     data-racknet data-rack="${rack}" data-side="${side}" /></label>
          <label class="running">Game Subtotal<input type="number" readonly
                                     data-running data-rack="${rack}" data-side="${side}" /></label>
        </div>
      </div>`;
  }

  function ballBtn(rack, side, n) {
    const cls = ballKind(n) === "stripe" ? "ball stripe" : "ball";
    return `<button type="button" class="${cls}" data-rack="${rack}" data-side="${side}" data-num="${n}"
                    aria-pressed="false" aria-label="Rack ${rack} Player ${side} ball ${n}">${n}</button>`;
  }

  function recomputeSheet() {
    ["A", "B"].forEach((side) => {
      let running = 0, totalFouls = 0;
      for (let r = 1; r <= RACKS; r++) {
        const on = $$(`#sheet .ball.on[data-rack="${r}"][data-side="${side}"]`).length;
        const foulEl = $(`#sheet input[data-foul][data-rack="${r}"][data-side="${side}"]`);
        const rackFouls = parseInt(foulEl && foulEl.value, 10) || 0;
        const rackNet = on - rackFouls;
        running += rackNet;
        totalFouls += rackFouls;
        const t = $(`#sheet input[data-total][data-rack="${r}"][data-side="${side}"]`);
        if (t) t.value = on || "";
        const netEl = $(`#sheet input[data-racknet][data-rack="${r}"][data-side="${side}"]`);
        if (netEl) netEl.value = (on === 0 && rackFouls === 0) ? "" : rackNet;
        const runEl = $(`#sheet input[data-running][data-rack="${r}"][data-side="${side}"]`);
        if (runEl) runEl.value = (on === 0 && rackFouls === 0 && running === 0) ? "" : running;
      }
      const finalEl = $(`#sheet input[data-field="final${side}"]`);
      if (finalEl) finalEl.value = running;
      const foulsEl = $(`#sheet input[data-field="fouls${side}"]`);
      if (foulsEl) foulsEl.value = totalFouls || "";
    });
    const t = activeT();
    const target = t ? t.raceTo : 25;
    const finalA = parseInt($(`#sheet input[data-field="finalA"]`).value, 10) || 0;
    const finalB = parseInt($(`#sheet input[data-field="finalB"]`).value, 10) || 0;
    const winnerRadios = $$(`#sheet input[name="winner"]`);
    if (winnerRadios.length && target > 0 && !winnerRadios.some((r) => r.checked)) {
      if (finalA >= target && finalA > finalB) {
        winnerRadios.find((r) => r.value === "A").checked = true;
      } else if (finalB >= target && finalB > finalA) {
        winnerRadios.find((r) => r.value === "B").checked = true;
      }
    }
  }

  function collectSheet() {
    const s = {
      pAname: $(`#sheet input[data-field="pAname"]`).value,
      pBname: $(`#sheet input[data-field="pBname"]`).value,
      goalA: ($(`#sheet input[name="goalA"]:checked`) || {}).value || "25",
      goalAOther: $(`#sheet input[data-field="goalAOther"]`).value,
      goalB: ($(`#sheet input[name="goalB"]:checked`) || {}).value || "25",
      goalBOther: $(`#sheet input[data-field="goalBOther"]`).value,
      hrA: $(`#sheet input[data-field="hrA"]`).value,
      hrB: $(`#sheet input[data-field="hrB"]`).value,
      sigA: $(`#sheet input[data-field="sigA"]`).value,
      sigB: $(`#sheet input[data-field="sigB"]`).value,
      winner: ($(`#sheet input[name="winner"]:checked`) || {}).value || "",
      finalA: parseInt($(`#sheet input[data-field="finalA"]`).value, 10) || 0,
      finalB: parseInt($(`#sheet input[data-field="finalB"]`).value, 10) || 0,
      racks: []
    };
    for (let r = 1; r <= RACKS; r++) {
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

  function applySheet(sheet, matchInfo) {
    $$("#sheet .ball.on").forEach((b) => { b.classList.remove("on"); b.setAttribute("aria-pressed", "false"); });
    $$("#sheet input[data-foul]").forEach((i) => { i.value = ""; });
    $$("#sheet input[data-field]").forEach((i) => { if (!i.readOnly) i.value = ""; });
    $$(`#sheet input[type="radio"]`).forEach((r) => { r.checked = r.defaultChecked; });

    const nameA = matchInfo && matchInfo.playerA ? matchInfo.playerA.name : "";
    const nameB = matchInfo && matchInfo.playerB ? matchInfo.playerB.name : "";
    $(`#sheet input[data-field="pAname"]`).value = sheet && sheet.pAname ? sheet.pAname : nameA;
    $(`#sheet input[data-field="pBname"]`).value = sheet && sheet.pBname ? sheet.pBname : nameB;

    const t = activeT();
    const raceTo = t ? t.raceTo : 25;
    const goalVal = String(raceTo);
    const isPreset = ["25", "50"].includes(goalVal);
    ["A", "B"].forEach((side) => {
      if (isPreset) {
        const r = $(`#sheet input[name="goal${side}"][value="${goalVal}"]`);
        if (r) r.checked = true;
      } else {
        const other = $(`#sheet input[name="goal${side}"][value="other"]`);
        if (other) other.checked = true;
        const oInput = $(`#sheet input[data-field="goal${side}Other"]`);
        if (oInput) oInput.value = goalVal;
      }
    });

    if (!sheet) { recomputeSheet(); return; }

    if (sheet.hrA) $(`#sheet input[data-field="hrA"]`).value = sheet.hrA;
    if (sheet.hrB) $(`#sheet input[data-field="hrB"]`).value = sheet.hrB;
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
    recomputeSheet();
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
    $("#tournamentTagline").textContent = `${g.name} \u00b7 ${t.format === "double" ? "Double Final" : "Single Final"} \u00b7 ${g.raceLabel} ${t.raceTo}${dt ? " \u00b7 " + dt : ""}`;
    $("#tName").value = t.name || "";
    $("#tDate").value = t.date || "";
    $("#tTime").value = t.startTime || "";
    $("#tGame").value = t.game || "kball";
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

    container.appendChild(renderSection("Winners Bracket", groups.W, "W", t.bracket));
    if (t.bracket.lRounds > 0) container.appendChild(renderSection("Losers Bracket", groups.L, "L", t.bracket));
    const gfSection = renderSection("Grand Finals", groups.GF, "GF", t.bracket);
    gfSection.classList.add("gf-region");
    container.appendChild(gfSection);

    const played = Object.values(t.bracket.matches).filter((m) => m.winner !== null && !m.resolvedAutoBye).length;
    const total = Object.values(t.bracket.matches).filter((m) => !m.conditional || (m.slots[0] && m.slots[1])).length;
    const g = gameOf(t);
    $("#statusText").textContent = `${g.name} \u00b7 ${t.participants.length} players \u00b7 ${played} of ${total} matches decided \u00b7 ${t.format === "double" ? "Double Final" : "Single Final"} \u00b7 ${g.raceLabel} ${t.raceTo}`;

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

    const t = activeT();
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
        if (decided) row.classList.add(match.winner === slotIdx ? "winner" : "loser");
        const seed = s.seed ? `<span class="sd">#${s.seed}</span>` : "";
        const sheet = t && t.sheets ? t.sheets[match.id] : null;
        let sc = "";
        if (sheet && decided) {
          const final = slotIdx === 0 ? sheet.finalA : sheet.finalB;
          sc = final != null ? String(final) : "";
        }
        row.innerHTML = `<span>${seed}<span class="nm">${escapeHtml(s.name)}</span></span><span class="sc">${sc}</span>`;
      }
      card.appendChild(row);
    });

    if (playable) {
      card.addEventListener("click", () => openMatch(match.id));
    }
    return card;
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
    const g = gameOf(t);
    if (g.sheetType === "counter") { openCounterModal(matchId); return; }
    activeMatchId = matchId;
    const match = t.bracket.matches[matchId];
    const info = { matchId, playerA: match.slots[0], playerB: match.slots[1] };
    $("#matchEyebrow").textContent = matchLabel(match);
    $("#matchTitle").textContent = `${match.slots[0].name}  vs.  ${match.slots[1].name}`;
    applySheet(t.sheets[matchId] || null, info);
    $("#matchModal").hidden = false;
    document.body.style.overflow = "hidden";
  }

  function matchLabel(match) {
    const t = activeT();
    const g = gameOf(t);
    const round = roundTitle(match.bracket, match.round, t.bracket);
    return `${t.name} \u2022 ${round} \u2022 ${match.id} \u2022 ${g.raceLabel} ${t.raceTo}`;
  }

  // ============================================================
  // Counter modal (games-won sheet for 8/9/10-ball etc.)
  // ============================================================
  let activeCounterMatchId = null;
  function openCounterModal(matchId) {
    const t = activeT();
    if (!t) return;
    const match = t.bracket.matches[matchId];
    if (!match || !match.slots[0] || !match.slots[1]) return;
    activeCounterMatchId = matchId;
    const g = gameOf(t);
    $("#counterEyebrow").textContent = matchLabel(match);
    $("#counterTitle").textContent = `${match.slots[0].name}  vs.  ${match.slots[1].name}`;
    $("#counterANm").textContent = match.slots[0].name;
    $("#counterBNm").textContent = match.slots[1].name;
    $("#counterTarget").textContent = `${g.raceLabel} ${t.raceTo}`;
    // Show +5 / +10 quick-add buttons for point-style games (Straight Pool / K-Ball-style targets).
    const pointsMode = (t.raceTo || g.defaultRaceTo) >= 50;
    $$("[data-counter-jumps]").forEach((el) => { el.hidden = !pointsMode; });
    const existing = t.sheets[matchId] || null;
    const a = existing && Number.isInteger(existing.finalA) ? existing.finalA : 0;
    const b = existing && Number.isInteger(existing.finalB) ? existing.finalB : 0;
    counterSet("A", a);
    counterSet("B", b);
    $$("input[name=\"counterWinner\"]").forEach((r) => {
      r.checked = existing && existing.winner === r.value;
    });
    $("#counterModal").hidden = false;
    document.body.style.overflow = "hidden";
  }
  function closeCounterModal() {
    $("#counterModal").hidden = true;
    document.body.style.overflow = "";
    activeCounterMatchId = null;
  }
  function counterGet(side) {
    return parseInt($(`#counter${side}Score`).textContent, 10) || 0;
  }
  function counterSet(side, n) {
    const v = Math.max(0, Math.min(999, n | 0));
    $(`#counter${side}Score`).textContent = String(v);
    // Auto-select winner when a side reaches the race target
    const t = activeT();
    if (!t) return;
    const race = t.raceTo || gameOf(t).defaultRaceTo;
    const other = side === "A" ? counterGet("B") : counterGet("A");
    if (v >= race && v > other) {
      const rb = $(`input[name="counterWinner"][value="${side}"]`);
      if (rb && !$$("input[name=\"counterWinner\"]").some((r) => r.checked)) rb.checked = true;
    }
  }
  function counterInc(side) { counterSet(side, counterGet(side) + 1); }
  function counterDec(side) { counterSet(side, counterGet(side) - 1); }
  function saveCounterMatch() {
    if (!activeCounterMatchId) return;
    const t = activeT();
    if (!t) return;
    const winner = ($$("input[name=\"counterWinner\"]").find((r) => r.checked) || {}).value || null;
    const finalA = counterGet("A");
    const finalB = counterGet("B");
    const sheet = {
      _kind: "counter",
      game: t.game,
      matchId: activeCounterMatchId,
      finalA, finalB,
      winner: winner
    };
    if (!winner) {
      if (!confirm("No winner is selected. Save this counter sheet as in-progress (bracket won't advance)?")) return;
      t.sheets[activeCounterMatchId] = sheet;
      persist();
      renderBracket();
      toast("Saved (no winner set)");
      return;
    }
    t.sheets[activeCounterMatchId] = sheet;
    const winnerSlot = winner === "A" ? 0 : 1;
    window.BracketEngine.recordWinner(t.bracket, activeCounterMatchId, winnerSlot, { score: `${finalA}-${finalB}` });
    persist();
    renderBracket();
    closeCounterModal();
    toast("Result recorded");
  }
  function clearCounterMatch() {
    if (!activeCounterMatchId) return;
    const t = activeT();
    if (!t) return;
    if (!confirm("Clear this match? Also removes the winner from the bracket.")) return;
    delete t.sheets[activeCounterMatchId];
    const m = t.bracket.matches[activeCounterMatchId];
    if (m && m.winner !== null) {
      m.winner = null;
      m.score = null;
      rebuildFromParticipants();
    }
    counterSet("A", 0);
    counterSet("B", 0);
    $$("input[name=\"counterWinner\"]").forEach((r) => { r.checked = false; });
    persist();
    renderBracket();
    toast("Cleared");
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

  function closeMatch() {
    $("#matchModal").hidden = true;
    document.body.style.overflow = "";
    activeMatchId = null;
  }

  function saveMatch() {
    if (!activeMatchId) return;
    const t = activeT();
    if (!t) return;
    const sheet = collectSheet();
    if (!sheet.winner) {
      if (!confirm("No winner is selected on this sheet. Save it as an in-progress match anyway (bracket won't advance)?")) return;
      t.sheets[activeMatchId] = sheet;
      persist();
      renderBracket();
      toast("Saved (no winner set)");
      return;
    }
    t.sheets[activeMatchId] = sheet;
    const winnerSlot = sheet.winner === "A" ? 0 : 1;
    const scoreSummary = `${sheet.finalA}-${sheet.finalB}`;
    window.BracketEngine.recordWinner(t.bracket, activeMatchId, winnerSlot, { score: scoreSummary });
    persist();
    renderBracket();
    closeMatch();
    toast("Result recorded");
  }

  function clearMatch() {
    if (!activeMatchId) return;
    const t = activeT();
    if (!t) return;
    if (!confirm("Clear this match sheet? Also removes the winner from the bracket.")) return;
    delete t.sheets[activeMatchId];
    const m = t.bracket.matches[activeMatchId];
    if (m && m.winner !== null) {
      m.winner = null;
      m.score = null;
      rebuildFromParticipants();
    }
    applySheet(null, { matchId: activeMatchId, playerA: m.slots[0], playerB: m.slots[1] });
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
    t.bracket = window.BracketEngine.build(list, { format: t.format });
    t.sheets = {};
    applyTournamentToSetup();
    persist();
    renderBracket();
    document.getElementById("bracketWrap").scrollIntoView({ behavior: "smooth", block: "start" });
    toast("Bracket built");
  }

  function rebuildFromParticipants() {
    const t = activeT();
    if (!t || !t.participants.length) return;
    const prevSheets = Object.assign({}, t.sheets);
    t.bracket = window.BracketEngine.build(t.participants, { format: t.format });
    t.sheets = {};
    Object.keys(prevSheets).forEach((mid) => {
      if (t.bracket.matches[mid]) t.sheets[mid] = prevSheets[mid];
    });
    const ordered = window.BracketEngine.matchesInOrder(t.bracket);
    ordered.forEach((m) => {
      const sh = t.sheets[m.id];
      if (sh && sh.winner) {
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
      const g = GAMES[gid] || GAMES.kball;
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
    // Counter increment/decrement + jump buttons (delegated)
    document.body.addEventListener("click", (ev) => {
      const inc = ev.target.closest("[data-counter-inc]");
      if (inc) { counterInc(inc.dataset.counterInc); return; }
      const dec = ev.target.closest("[data-counter-dec]");
      if (dec) { counterDec(dec.dataset.counterDec); return; }
      const jump = ev.target.closest("[data-counter-jump]");
      if (jump) {
        const side = jump.dataset.counterJump;
        const delta = parseInt(jump.dataset.delta, 10) || 0;
        counterSet(side, counterGet(side) + delta);
        return;
      }
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
    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") {
        if (!$("#matchModal").hidden) closeMatch();
        else if (!$("#counterModal").hidden) closeCounterModal();
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

      // ---- counter modal (games-won sheet)
      case "close-counter": closeCounterModal(); break;
      case "save-counter": saveCounterMatch(); break;
      case "clear-counter": clearCounterMatch(); break;

      // ---- bracket
      case "add-late-entry": openLateEntry(); break;
      case "close-late-entry": closeLateEntry(); break;
      case "confirm-late-entry": confirmLateEntry(); break;
      case "print-bracket": window.print(); break;
      case "reset-bracket": {
        const t = activeT(); if (!t) return;
        if (!confirm("Reset the bracket? Rebuilds from the current participant list and clears all scores.")) return;
        t.sheets = {};
        buildBracket();
        break;
      }

      // ---- match modal
      case "close-match": closeMatch(); break;
      case "save-match": saveMatch(); break;
      case "clear-match": clearMatch(); break;
    }
  }

  // ============================================================
  // Init
  // ============================================================
  document.addEventListener("DOMContentLoaded", () => {
    renderRacks();
    wireUp();
    loadPersisted();
    if (app.activeId && activeT()) {
      showBracket(app.activeId);
    } else {
      showHome();
    }
  });
})();
