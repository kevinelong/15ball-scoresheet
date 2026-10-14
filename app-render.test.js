/* Render tests for app.js (the standalone console).
   Run with:  node app-render.test.js

   These are the client-side bits of the single-elimination work that had no direct
   coverage: the format label mapping, the grand-final section that must not render for
   single elimination, and the sheet-replay loop that must skip a match which is not
   playable any more (recordWinner refuses an empty/BYE slot, so replaying a stored
   sheet onto it would throw).

   app.js is a closed IIFE, so it runs in a hand-rolled DOM shim (same style as
   migration.test.js) plus a real BracketEngine loaded into the same context, and the
   tests read the markup the module actually writes. Assertions are positive, so a
   swallowed error cannot pass as success. */

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

let passed = 0, failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(" ok ", name);
  } catch (e) {
    failed++;
    console.error("FAIL:", name, "-", e.message);
  }
}

function mkEl(tag) {
  const base = {
    tagName: tag || "div", innerHTML: "", textContent: "", value: "", hidden: false,
    className: "", dataset: {}, style: {}, _kids: [], _listeners: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener(type, fn) { (base._listeners[type] = base._listeners[type] || []).push(fn); },
    removeEventListener() {},
    appendChild(c) { base._kids.push(c); return c; },
    removeChild() {},
    setAttribute() {}, removeAttribute() {}, getAttribute() { return null; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    focus() {}, blur() {}, click() {}, closest() { return null; }, remove() {},
    insertAdjacentHTML() {}, scrollIntoView() {}, print() {}
  };
  return new Proxy(base, {
    get(t, k) { return k in t ? t[k] : function () {}; },
    set(t, k, v) { if (k === "innerHTML" && v === "") t._kids = []; t[k] = v; return true; }
  });
}

// lastCard returns the most recently rendered card for a match: a re-render creates new
// nodes, and the old ones are still in `created`.
function lastCard(created, matchId) {
  const cards = created.filter((e) => e.dataset && e.dataset.matchId === matchId);
  assert.ok(cards.length > 0, `no card rendered for match ${matchId}`);
  return cards[cards.length - 1];
}

// textOf walks an element stub, collecting everything the module rendered into it.
function textOf(node) {
  let out = "";
  const walk = (e) => {
    if (!e) return;
    out += " " + (e.textContent || "") + " " + (e.innerHTML || "");
    (e._kids || []).forEach(walk);
  };
  walk(node);
  return out;
}

// loadApp builds a tournament with the real bracket engine, seeds it into localStorage,
// loads app.js and fires DOMContentLoaded — the same path the browser takes.
function loadApp(label, buildTournament) {
  const els = new Map();
  const created = [];
  const docListeners = {};
  const getEl = (sel) => { if (!els.has(sel)) els.set(sel, mkEl("stub")); return els.get(sel); };
  const ls = {
    _s: {},
    getItem(k) { return Object.prototype.hasOwnProperty.call(this._s, k) ? this._s[k] : null; },
    setItem(k, v) { this._s[k] = String(v); },
    removeItem(k) { delete this._s[k]; }
  };
  const documentShim = {
    querySelector: (sel) => getEl(sel),
    querySelectorAll: () => [],
    getElementById: (id) => getEl("#" + id),
    createElement: (tag) => { const e = mkEl(tag); created.push(e); return e; },
    addEventListener(type, fn) { (docListeners[type] = docListeners[type] || []).push(fn); },
    body: getEl("body"),
    readyState: "complete",
    hidden: false
  };
  const sandbox = {
    localStorage: ls, document: documentShim, console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    alert() {}, confirm: () => true, prompt: () => "x",
    scrollTo() {}, matchMedia: () => ({ matches: false, addListener() {}, addEventListener() {} }),
    URLSearchParams, Date, JSON, Math, Number, Array, Object, String,
    FileReader: class { readAsText() {} }, print() {},
    Tables: {
      buildTables: (n) => Array.from({ length: n }, (_, i) => ({ id: "tbl_" + i, name: String(i + 1), color: "#000" })),
      parseNaming: (n) => Array.from({ length: n }, (_, i) => String(i + 1)),
      namingPlaceholder: (n) => `1-${n}`,
      _defaultNames: (start, count) => Array.from({ length: count }, (_, i) => String(start + i))
    }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  // The script order index.html uses: bracket.js, tables.js, sheets.js, then app.js.
  // sheets.js matters here because opening a match now builds its sheet body from the
  // discipline's definition (`window.Sheets`).
  vm.runInContext(fs.readFileSync(path.join(__dirname, "bracket.js"), "utf8"), ctx, { filename: "bracket.js" });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "sheets.js"), "utf8"), ctx, { filename: "sheets.js" });
  const tournament = buildTournament(sandbox.BracketEngine);
  ls.setItem("fifteenBall.app.v3", JSON.stringify({ v: 3, activeId: tournament.id, tournaments: [tournament] }));
  vm.runInContext(fs.readFileSync(path.join(__dirname, "app.js"), "utf8"), ctx, { filename: "app.js" });
  (docListeners.DOMContentLoaded || []).forEach((fn) => fn());

  return {
    sandbox, created, ls, getEl,
    tagline: () => getEl("#tournamentTagline").textContent,
    bracketText: () => textOf(getEl("#bracket")),
    // cardText walks the rendered markup of one match card (the freshest render).
    cardText(matchId) { return textOf(lastCard(created, matchId)); },
    // clickCard fires the click listener renderBracket put on a match card.
    clickCard(matchId) {
      const card = lastCard(created, matchId);
      const handlers = (card._listeners && card._listeners.click) || [];
      assert.ok(handlers.length > 0, `match card ${matchId} is not clickable`);
      handlers.forEach((fn) => fn());
    },
    // action fires the delegated body-click handler with a data-action element.
    action(name) {
      const handlers = getEl("body")._listeners.click || [];
      assert.ok(handlers.length > 0, "the module should delegate actions on the body");
      handlers.forEach((fn) => fn({ target: { closest: () => ({ dataset: { action: name } }) } }));
    }
  };
}

const players = [{ name: "P1" }, { name: "P2" }, { name: "P3" }, { name: "P4" }];
function tourney(id, format, bracket, sheets) {
  return {
    id, name: "T " + id, date: "2026-01-01", startTime: "14:00", game: "fifteenBall",
    format, raceTo: 25, createdAt: 1, updatedAt: 1,
    participants: bracket.participants, bracket, sheets: sheets || {}, tables: []
  };
}

// ---------- format labels ----------
test("format labels: all three formats read distinctly, and 'single' still means Single Final", () => {
  const labels = {};
  for (const f of ["single_elim", "single", "double"]) {
    const app = loadApp(f, (B) => tourney("t_" + f, f, B.build(players, { format: f })));
    labels[f] = app.tagline();
  }
  assert.ok(labels.single_elim.indexOf("Single Elimination") !== -1, `single_elim tagline: ${labels.single_elim}`);
  assert.ok(labels.single.indexOf("Single Final") !== -1, `single tagline must stay "Single Final": ${labels.single}`);
  assert.ok(labels.double.indexOf("Double Final") !== -1, `double tagline: ${labels.double}`);
  assert.strictEqual(new Set(Object.values(labels)).size, 3, "the three labels must not collide");
  assert.ok(labels.single_elim.indexOf("Single Final") === -1, "single elimination must not read as a single final");
});

// ---------- grand-final section ----------
test("single elimination renders no Grand Finals section", () => {
  const app = loadApp("se", (B) => tourney("t_se", "single_elim", B.build(players, { format: "single_elim" })));
  const text = app.bracketText();
  assert.ok(text.indexOf("W1M1") !== -1, `the bracket should render: ${text.slice(0, 300)}`);
  assert.ok(text.indexOf("Grand Finals") === -1, `no grand-final card should be rendered: ${text.slice(0, 400)}`);
  assert.ok(text.indexOf("Grand Final") === -1, `nor a grand-final match: ${text.slice(0, 400)}`);
});

test("the same bracket keeps its Grand Finals section for the shipped formats", () => {
  for (const f of ["single", "double"]) {
    const app = loadApp(f, (B) => tourney("t_" + f, f, B.build(players, { format: f })));
    const text = app.bracketText();
    assert.ok(text.indexOf("Grand Finals") !== -1, `${f} should render the grand-final section: ${text.slice(0, 400)}`);
    assert.ok(text.indexOf("GF1") !== -1, `${f} should render GF1: ${text.slice(0, 400)}`);
  }
});

// ---------- sheet replay ----------
// A played-out bracket whose W1M2 sheet is cleared (the documented "clear this match
// sheet" flow): the rebuild replays the surviving sheets in match order, and W2M1's
// sheet must be skipped because its feeder no longer has a result.
test("clearing a sheet rebuilds without replaying it onto a match that is not playable", () => {
  const app = loadApp("replay", (B) => {
    const bracket = B.build(players, { format: "single_elim" }); // no losers bracket: a played-out field has no open slots
    B.recordWinner(bracket, "W1M1", 0, { score: "25-10" });
    B.recordWinner(bracket, "W1M2", 0, { score: "25-11" });
    B.recordWinner(bracket, "W2M1", 0, { score: "25-12" });
    assert.ok(bracket.matches["W2M1"].winner !== null, "fixture: the final should be played");
    const sheets = {
      W1M1: { winner: "A", finalA: 25, finalB: 10 },
      W1M2: { winner: "A", finalA: 25, finalB: 11 },
      W2M1: { winner: "A", finalA: 25, finalB: 12 }
    };
    return tourney("t_replay", "single_elim", bracket, sheets);
  });

  assert.ok(app.bracketText().indexOf("awaiting") === -1, "fixture: a played-out bracket has no open slots");
  assert.ok(app.cardText("W2M1").indexOf("12") !== -1, "fixture: the final's sheet should be on screen before the clear");
  assert.ok(app.cardText("W1M2").indexOf("11") !== -1, "fixture: the semi's sheet should be on screen before the clear");
  assert.ok(app.getEl("#champBanner").hidden === false, "fixture: the played-out bracket has a champion");

  app.clickCard("W1M2");               // open the sheet modal for the semi
  app.action("clear-match");           // clear it → winner cleared → rebuildFromParticipants()

  const finalCard = app.cardText("W2M1");
  assert.ok(finalCard.indexOf("awaiting") !== -1,
    `the rebuilt final should wait on its feeder: ${finalCard}`);
  assert.ok(app.cardText("W1M2").indexOf("11") === -1, "the cleared sheet must be gone");
  // The surviving final sheet must be skipped, not replayed: it would have decided the
  // final (a score on slot a, and a champion) even though one slot is empty.
  assert.ok(finalCard.indexOf("25") === -1,
    `the skipped sheet must not show a score on the final: ${finalCard}`);
  assert.ok(app.getEl("#champBanner").hidden === true,
    `the rebuilt bracket has no champion until the final is played: ${app.getEl("#champBanner").textContent}`);
});

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
