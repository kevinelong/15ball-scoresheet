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
  // classList is backed by a real set so a test can read the classes the module adds
  // (`card.classList.add("decided")` and the winner/loser row marks).
  const classes = new Set();
  const base = {
    tagName: tag || "div", innerHTML: "", textContent: "", value: "", hidden: false,
    className: "", dataset: {}, style: {}, _kids: [], _listeners: {}, _classes: classes,
    classList: {
      add(...names) { names.forEach((n) => classes.add(n)); },
      remove(...names) { names.forEach((n) => classes.delete(n)); },
      toggle(n) { if (classes.has(n)) { classes.delete(n); return false; } classes.add(n); return true; },
      contains(n) { return classes.has(n); }
    },
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

// slotRows returns the two player rows of a rendered match card, in slot order — the rows
// renderMatchCard builds, as opposed to the match-id badge above them.
function slotRows(card) {
  return (card._kids || []).filter((k) => k.className === "slot");
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
  // The swipe gesture needs a panel box: 400px wide at the origin, so a gesture starting left
  // of x=200 is Player A's half and one starting right of it is Player B's.
  const swipePanel = getEl("#race");
  swipePanel.getBoundingClientRect = () => ({ left: 0, top: 0, width: PANEL_WIDTH, height: 600 });
  swipePanel.setPointerCapture = () => {};
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
    action(name) { this.delegatedClick({ action: name }); },
    // delegatedClick fires the body's delegated click listeners with the data-* attributes
    // of one control, answering closest(sel) only for the attribute the test is firing, so
    // the handler's own if-chain runs exactly as it does in the browser.
    delegatedClick(attrs) {
      const handlers = getEl("body")._listeners.click || [];
      assert.ok(handlers.length > 0, "the module should delegate actions on the body");
      handlers.forEach((fn) => fn({ target: { closest: (sel) => controlFor(sel, attrs) } }));
    },
    // raceInc / raceDec press the tally's own step buttons; raceJump presses a quick-add
    // control (the markup for one is what the sheet is not supposed to have any more).
    raceInc(side) { this.delegatedClick({ raceInc: side }); },
    raceDec(side) { this.delegatedClick({ raceDec: side }); },
    raceJump(side, delta) { this.delegatedClick({ raceJump: side, delta: String(delta) }); },
    // pointer fires one pointer event at the swipe panel, as a real finger would.
    pointer(type, opts) {
      const panel = getEl("#race");
      const handlers = (panel._listeners && panel._listeners[type]) || [];
      assert.ok(handlers.length > 0, `the tally panel should listen for ${type}`);
      const ev = Object.assign({
        pointerType: "touch", pointerId: 1, clientX: 100, clientY: 100, cancelable: true,
        preventDefault() {}, stopPropagation() {}
      }, opts || {});
      handlers.forEach((fn) => fn(ev));
    },
    // swipe is one whole gesture: down at (x, from), move to `to`, release.
    swipe(x, from, to, opts) {
      this.pointer("pointerdown", Object.assign({ clientX: x, clientY: from }, opts || {}));
      this.pointer("pointermove", Object.assign({ clientX: x, clientY: to }, opts || {}));
      this.pointer("pointerup", Object.assign({ clientX: x, clientY: to }, opts || {}));
    },
    // clickThroughPanel presses the +/- button the way the browser would: the panel's
    // capture listeners see the click first, and the delegated body handler only runs if
    // none of them stopped propagation - which is how a taken gesture cancels the press.
    clickThroughPanel(attrs) {
      let stopped = false;
      const ev = {
        target: { closest: (sel) => controlFor(sel, attrs) },
        stopPropagation() { stopped = true; },
        preventDefault() {}
      };
      const panel = getEl("#race");
      (((panel._listeners || {}).click) || []).forEach((fn) => fn(ev));
      if (stopped) return false;
      this.delegatedClick(attrs);
      return true;
    }
  };
}

// controlFor answers one closest(sel) call from a delegated handler: the attribute the test
// fired is present, anything else is null - as it is in the browser.
function controlFor(sel, attrs) {
  const m = /^\[(data-[a-z-]+)\]$/.exec(sel);
  if (!m) return null;
  const key = m[1].slice("data-".length).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  return Object.prototype.hasOwnProperty.call(attrs, key) ? { dataset: attrs } : null;
}

const players = [{ name: "P1" }, { name: "P2" }, { name: "P3" }, { name: "P4" }];

// The swipe panel's box in the harness (see loadApp), and the gesture's 48px threshold.
const PANEL_WIDTH = 400;
const PANEL_MID = PANEL_WIDTH / 2;
const SWIPE_MIN = 48;

// raceApp opens the tally for a 9-ball race to 7 — the sheet the step and swipe paths share.
function raceApp(label) {
  const app = loadApp(label, (B) => tourney("t_" + label, "single_elim",
    B.build(players, { format: "single_elim" }), null, { game: "9ball", raceTo: 7 }));
  app.clickCard("W1M1");
  return app;
}
function tourney(id, format, bracket, sheets, opts) {
  return Object.assign({
    id, name: "T " + id, date: "2026-01-01", startTime: "14:00", game: "fifteenBall",
    format, raceTo: 25, createdAt: 1, updatedAt: 1,
    participants: bracket.participants, bracket, sheets: sheets || {}, tables: []
  }, opts || {});
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
  // The card carries win/loss and nothing else, so the fixture is proven by its winner rows
  // (there is no score text to look for any more).
  const finalBefore = lastCard(app.created, "W2M1");
  assert.ok(slotRows(finalBefore).some((r) => r._classes.has("winner")),
    "fixture: the final's winner should be on screen before the clear");
  const semiBefore = lastCard(app.created, "W1M2");
  assert.ok(slotRows(semiBefore).some((r) => r._classes.has("winner")),
    "fixture: the semi's winner should be on screen before the clear");
  assert.ok(app.getEl("#champBanner").hidden === false, "fixture: the played-out bracket has a champion");

  app.clickCard("W1M2");               // open the sheet modal for the semi
  app.action("clear-match");           // clear it → winner cleared → rebuildFromParticipants()

  const finalCard = app.cardText("W2M1");
  assert.ok(finalCard.indexOf("awaiting") !== -1,
    `the rebuilt final should wait on its feeder: ${finalCard}`);
  // The cleared match no longer has a winner to mark.
  const semiAfter = lastCard(app.created, "W1M2");
  assert.ok(!slotRows(semiAfter).some((r) => r._classes.has("winner")),
    "the cleared sheet must leave no winner behind");
  // The surviving final sheet must be skipped, not replayed: it would have decided the
  // final (a score on slot a, and a champion) even though one slot is empty.
  assert.ok(finalCard.indexOf("25") === -1,
    `the skipped sheet must not show a score on the final: ${finalCard}`);
  assert.ok(app.getEl("#champBanner").hidden === true,
    `the rebuilt bracket has no champion until the final is played: ${app.getEl("#champBanner").textContent}`);
});

// ---------- no quick-add controls, in any dialog, for any discipline ----------
// The +5 / +10 / -5 jumps are gone as data, not just as markup: every discipline declares
// which controls it gets (Sheets.spec(g).quickAdd) and every one of them declares none, so
// no dialog can render one and no handler can act on one.
test("no dialog offers a +5 / +10 / -5 quick add, for any discipline", () => {
  const S = require("./sheets.js");
  for (const game of S.ids) {
    const spec = S.spec(game);
    assert.ok(Array.isArray(spec.quickAdd), `${game} must declare its jump controls`);
    assert.strictEqual(spec.quickAdd.length, 0, `${game} must declare no quick add: ${JSON.stringify(spec.quickAdd)}`);
  }

  const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
  assert.ok(html.indexOf("data-race-jump") === -1 && html.indexOf("data-counter-jump") === -1,
    "no quick-add control may survive in the markup");
  assert.ok(!/data-race-jumps|data-counter-jumps/.test(html), "nor its wrapper");
  assert.ok(!/>\+5</.test(html) && !/>\+10</.test(html) && !/&minus;5</.test(html),
    "nor a +5 / +10 / -5 label");
});

test("a win-measured race cannot exceed its target by a step, and a stray jump scores nothing", () => {
  // 9-ball: a games-won discipline, race to 7.
  const app = raceApp("race");
  assert.strictEqual(app.getEl("#raceAScore").textContent, "0", "fixture: the tally opens at 0");

  app.raceJump("A", 5);
  assert.strictEqual(app.getEl("#raceAScore").textContent, "0",
    "a quick add is not a control this discipline offers, so it must not move the tally");

  for (let i = 0; i < 9; i++) app.raceInc("A");
  assert.strictEqual(app.getEl("#raceAScore").textContent, "7",
    "a race to 7 is won at 7: a step must not carry the tally past the target");
  assert.strictEqual(app.getEl('#sheet input[name="winner"][value="A"]').checked, true,
    "hitting the target still auto-selects the winner");

  app.raceDec("A");
  assert.strictEqual(app.getEl("#raceAScore").textContent, "6", "and a step back still works");
  app.raceInc("A");
  assert.strictEqual(app.getEl("#raceAScore").textContent, "7", "back up to the target, not past it");
});

// ---------- the swipe gesture (ported from the Android app's SwipePanel) ----------
// Real pointer events at the tally panel: a mostly-vertical drag past ~48 CSS px is one step
// for the side the gesture started in, and only ever for a touch or pen finger.
test("one gesture is one step, however far the finger travels, on the half it started in", () => {
  const app = raceApp("swipe");
  app.pointer("pointerdown", { clientX: PANEL_MID - 120, clientY: 300 });
  app.pointer("pointermove", { clientX: PANEL_MID - 120, clientY: 300 - SWIPE_MIN });
  assert.strictEqual(app.getEl("#raceAScore").textContent, "1",
    `a ${SWIPE_MIN}px drag up in the left half steps Player A`);
  app.pointer("pointermove", { clientX: PANEL_MID - 120, clientY: 40 });
  assert.strictEqual(app.getEl("#raceAScore").textContent, "1", "a finger that keeps travelling does not step again");
  assert.strictEqual(app.getEl("#raceBScore").textContent, "0", "and the other half is untouched");
  app.pointer("pointerup", { clientX: PANEL_MID - 120, clientY: 40 });

  app.swipe(PANEL_MID + 120, 300, 300 - SWIPE_MIN);
  assert.strictEqual(app.getEl("#raceBScore").textContent, "1", "a fresh gesture in the right half steps Player B");
  assert.strictEqual(app.getEl("#raceAScore").textContent, "1", "and leaves Player A alone");
});

test("the half is the panel's half: the midpoint belongs to Player B", () => {
  const app = raceApp("half");
  app.swipe(PANEL_MID - 1, 300, 300 - SWIPE_MIN);
  assert.strictEqual(app.getEl("#raceAScore").textContent, "1", "just left of the midpoint is A");
  app.swipe(PANEL_MID, 300, 300 - SWIPE_MIN);
  assert.strictEqual(app.getEl("#raceBScore").textContent, "1", "the midpoint itself is B");
});

test("a downward drag steps back, and stops at zero", () => {
  const app = raceApp("down");
  app.swipe(100, 300, 300 - SWIPE_MIN);
  assert.strictEqual(app.getEl("#raceAScore").textContent, "1", "fixture: one step up");
  app.swipe(100, 100, 100 + SWIPE_MIN);
  assert.strictEqual(app.getEl("#raceAScore").textContent, "0", "a finger down steps back");
  app.swipe(100, 100, 100 + 200);
  assert.strictEqual(app.getEl("#raceAScore").textContent, "0", "and the tally cannot go below zero");
});

test("a drag shorter than the threshold does nothing", () => {
  const app = raceApp("short");
  app.swipe(100, 300, 300 - (SWIPE_MIN - 8));
  assert.strictEqual(app.getEl("#raceAScore").textContent, "0",
    `a ${SWIPE_MIN - 8}px drag is under the ${SWIPE_MIN}px travel the gesture needs`);
});

test("a drag across the panel does nothing", () => {
  const app = raceApp("across");
  app.pointer("pointerdown", { clientX: 60, clientY: 300 });
  app.pointer("pointermove", { clientX: 260, clientY: 280 });
  app.pointer("pointerup", { clientX: 260, clientY: 280 });
  assert.strictEqual(app.getEl("#raceAScore").textContent, "0", "a mostly-horizontal drag is not a step");
  // Vertical-dominant only: 70px of fall with 80px of travel across it is a drag across.
  app.pointer("pointerdown", { clientX: 60, clientY: 300 });
  app.pointer("pointermove", { clientX: 140, clientY: 230 });
  app.pointer("pointerup", { clientX: 140, clientY: 230 });
  assert.strictEqual(app.getEl("#raceAScore").textContent, "0", "a diagonal that is not vertical-dominant is not a step");
});

test("a mouse drag never takes the gesture", () => {
  const app = raceApp("mouse");
  app.swipe(100, 300, 160, { pointerType: "mouse" });
  assert.strictEqual(app.getEl("#raceAScore").textContent, "0",
    "a vertical mouse drag must keep scrolling the page, not score");
});

test("a drag that starts on the increment button scores exactly once", () => {
  const app = raceApp("button");
  assert.strictEqual(app.clickThroughPanel({ raceInc: "A" }), true, "fixture: a plain press on + scores");
  assert.strictEqual(app.getEl("#raceAScore").textContent, "1", "fixture: one step");

  app.pointer("pointerdown", { clientX: 100, clientY: 300 });
  app.pointer("pointermove", { clientX: 100, clientY: 300 - SWIPE_MIN });
  app.pointer("pointerup", { clientX: 100, clientY: 300 - SWIPE_MIN });
  assert.strictEqual(app.getEl("#raceAScore").textContent, "2", "the drag itself is one step");
  assert.strictEqual(app.clickThroughPanel({ raceInc: "A" }), false,
    "the press the drag started on is cancelled, not also scored");
  assert.strictEqual(app.getEl("#raceAScore").textContent, "2", "so the button does not score a second time");
});

// ---------- the bracket card: win/loss only ----------
// The bracket records who won and who lost, and nothing else. A played-out match's sheet
// (with its finals) must not bleed onto the card — no score element, no final values — while
// the card still marks the winner against the loser.
test("a decided bracket card shows win/loss and no score", () => {
  const app = loadApp("cardwin", (B) => {
    const bracket = B.build(players, { format: "single_elim" });
    B.recordWinner(bracket, "W1M1", 0, { score: "25-10" });
    const sheets = { W1M1: { winner: "A", finalA: 25, finalB: 10 } };
    return tourney("t_cardwin", "single_elim", bracket, sheets);
  });

  const card = lastCard(app.created, "W1M1");
  const markup = textOf(card);
  assert.ok(markup.indexOf('class="sc"') === -1, `the card must carry no score element: ${markup}`);
  assert.ok(markup.indexOf("25") === -1, `the sheet's 25 must not be on the card: ${markup}`);
  assert.ok(markup.indexOf("10") === -1, `the sheet's 10 must not be on the card: ${markup}`);

  const rows = slotRows(card);
  assert.strictEqual(rows.length, 2, `a two-slot card renders two rows: ${rows.length}`);
  assert.ok(rows[0]._classes.has("winner"), "the winner's row is marked");
  assert.ok(rows[1]._classes.has("loser"), "the loser's row is marked");
  assert.ok(card._classes.has("decided"), "a decided card says so");
});

// ---------- every advertised target is reachable ----------
// A discipline's sheet has a fixed number of racks, so it has a ceiling: racks x ballsPerRack.
// A hint that advertises a target above that ceiling offers the scorekeeper something their
// sheet cannot record (15-Ball Rotation used to show 14.1's text, with 150 on a 60-ball sheet).
test("every target a rack discipline advertises is reachable on its sheet", () => {
  const S = require("./sheets.js");
  const appGames = ["fifteenBall", "8ball", "9ball", "10ball", "onepocket", "14_1", "banks"];
  const hints = {};
  for (const game of appGames) {
    const app = loadApp("reach-" + game, (B) =>
      tourney("t_" + game, "single_elim", B.build(players, { format: "single_elim" }), null, { game }));
    hints[game] = app.getEl("#tRaceHint").textContent;
    const spec = S.spec(game);
    if (!spec.racks) continue;                       // a games tally has no rack ceiling
    const ceiling = spec.racks * spec.ballsPerRack;
    for (const n of (hints[game].match(/\d+/g) || []).map(Number)) {
      if (n <= spec.ballsPerRack) continue;          // a rack/ball count, not a target
      assert.ok(n <= ceiling,
        `${game} advertises ${n} in its hint, above its own ceiling of ${ceiling}: ${hints[game]}`);
    }
    for (const g of S.goals(game)) {
      assert.ok(g >= spec.ballsPerRack && g <= ceiling,
        `${game}'s goal ${g} is outside its reachable ${spec.ballsPerRack}..${ceiling}`);
    }
  }
  // 15-Ball keeps its own text: 14.1's copy (and its 150) must not be on it.
  assert.ok(hints.fifteenBall.indexOf("Straight Pool") === -1,
    `15-Ball must not carry 14.1's text: ${hints.fifteenBall}`);
  assert.ok(!/(^|\D)150(\D|$)/.test(hints.fifteenBall),
    `15-Ball must not advertise 150: ${hints.fifteenBall}`);
  assert.ok(!/(^|\D)150(\D|$)/.test(hints["14_1"]),
    `14.1 must not advertise 150 either: ${hints["14_1"]}`);
});

// ---------- One Pocket's two models ----------
// One Pocket's catalog line used to run the match's race and the game's rule together as if
// "balls-in-pocket" were what a match races to. The match is a race of games; a game is won
// by pocketing 8 balls in your own pocket — each said once, in its own place.
test("One Pocket reads as a race of games, and the 8-balls rule is the game's own line", () => {
  const app = loadApp("onepocket", (B) =>
    tourney("t_op", "single_elim", B.build(players, { format: "single_elim" }), null, { game: "onepocket", raceTo: 3 }));
  const hint = app.getEl("#tRaceHint").textContent;
  assert.ok(/games/i.test(hint), `the match line must read as a race of games: ${hint}`);
  assert.ok(hint.indexOf("Balls-in-pocket") === -1, `the match line is not balls-in-pocket: ${hint}`);
  const own = app.getEl("#tGameHint").textContent;
  assert.ok(/8\b/.test(own) && /own pocket/i.test(own),
    `the game's own line must state the 8-balls-in-your-own-pocket rule: ${own}`);
});

// ---------- the static default hint ----------
// index.html's #tRaceHint is what a first-load visitor reads before app.js runs, and the
// app's default game is 15-Ball. It is the same string the app writes, read off disk so the
// two cannot drift.
test("index.html's static race hint is the 15-Ball hint the app writes", () => {
  const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
  const m = /<small id="tRaceHint">([\s\S]*?)<\/small>/.exec(html);
  assert.ok(m, "index.html should carry a static #tRaceHint");
  const app = loadApp("statichint", (B) =>
    tourney("t_sh", "single_elim", B.build(players, { format: "single_elim" })));
  assert.strictEqual(m[1].trim(), app.getEl("#tRaceHint").textContent,
    "the static default hint must be exactly the 15-Ball hint the app writes on load");
});

// ---------- the 14.1 paper sheet and rules are linked ----------
test("both 14.1 PDFs are linked from the app header", () => {
  const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
  const sheet = (html.match(/docs\/141-paper-sheet\.pdf/g) || []).length;
  const rules = (html.match(/docs\/141-rules\.pdf/g) || []).length;
  assert.strictEqual(sheet, 2, `both header blocks should link the 14.1 paper sheet (found ${sheet})`);
  assert.strictEqual(rules, 2, `both header blocks should link the 14.1 rules (found ${rules})`);
});

// ---------- the console saves on this device ----------
test("the score sheet says the console saves on this device, and the save toast agrees", () => {
  const NOTE = "Saved on this device — this console has no server link, so the sheet stays in this browser.";
  const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
  const modalAt = html.indexOf('id="matchModal"');
  const noteAt = html.indexOf(NOTE);
  assert.ok(modalAt !== -1 && noteAt !== -1, "the modal must carry the device-only note");
  assert.ok(noteAt > modalAt && noteAt < html.indexOf('id="exportModal"'),
    "the note belongs to the score-sheet modal, not another one");

  const app = loadApp("device", (B) =>
    tourney("t_device", "single_elim", B.build(players, { format: "single_elim" })));
  app.clickCard("W1M1");
  app.action("save-match");
  const toast = app.getEl("#toast").textContent;
  assert.ok(toast.indexOf("this device") !== -1, `the save toast must say where the sheet goes: ${toast}`);
  assert.ok(toast.indexOf("no server link") !== -1, `the save toast must say there is no server link: ${toast}`);
  assert.ok(toast.indexOf("Result recorded") === -1, `the old over-claiming toast is gone: ${toast}`);
});

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);