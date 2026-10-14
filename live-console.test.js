/* Drives live.js (the cloud console) in a hand-rolled DOM/FB stub.
   Run with:  node live-console.test.js

   Two things are pinned here. First, the review-flag surface: the console must show a
   flagged match rather than render it as normal, in both the bracket tree and the flat
   match list, and it must pick the flag up from an SSE event without anyone calling a
   render function by hand. Second, the score sheet — the console's one write path: the
   sheet opens from a match, the race comes from the match payload, Save is the only
   thing that submits a result, and the stack reads the saved versions back. Assertions
   are positive (markup must contain X), so a swallowed error cannot pass as success. */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

let passed = 0, failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(" ok ", name);
  } catch (e) {
    failed++;
    console.error("FAIL:", name, "-", e.message);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
// Equality helpers (the local assert() has no strictEqual of its own).
function eq(actual, expected, msg) {
  if (actual !== expected) throw new Error(msg + " — got " + JSON.stringify(actual) + ", expected " + JSON.stringify(expected));
}
function deepEq(actual, expected, msg) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error(msg + " — got " + a + ", expected " + b);
}
// Lets the module's promise chain (openTournament → renderTournament) settle.
async function settle() {
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
}

function mkEl(id) {
  const base = {
    id, innerHTML: "", textContent: "", value: "", hidden: false, style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {}, removeEventListener() {}, appendChild() {}, removeChild() {},
    setAttribute() {}, removeAttribute() {}, getAttribute() { return null; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    focus() {}, blur() {}, click() {}, closest() { return null; }, remove() {},
    insertAdjacentHTML() {}, scrollIntoView() {}
  };
  return new Proxy(base, {
    get(t, k) { return k in t ? t[k] : function () {}; }, // tolerate the rest of the DOM surface
    set(t, k, v) { t[k] = v; return true; }
  });
}

// findButton scans rendered markup for <button> tags and returns the attributes of
// the first one matching pred — so a test clicks what the console actually rendered,
// and a regressed data-action (e.g. a surviving "win") fails the test.
function findButton(html, pred) {
  const re = /<button\b[^>]*>/g;
  let m;
  while ((m = re.exec(html))) {
    const attrs = {};
    m[0].replace(/([a-zA-Z-]+)="([^"]*)"/g, (_, k, v) => { attrs[k] = v; return ""; });
    if (pred(attrs)) return attrs;
  }
  return null;
}

// loadConsole runs live.js in public scoring mode (?t=) against the given data. The
// match list is live: setMatches() swaps what the next fetch returns, which is how the
// SSE test simulates the server changing underneath the console. opts.search = "" boots
// signed-in (director) mode instead, and opts.me sets the session.
function loadConsole(data, opts) {
  opts = opts || {};
  const els = new Map();
  const timers = [];
  const sseHandlers = {};
  const listeners = {};
  const calls = {
    submitResult: [], assignMatch: [], startMatch: [], matchHistory: [],
    createDivision: [], patchDivision: [], createTournament: [], patchTournament: []
  };
  const getEl = (id) => { if (!els.has(id)) els.set(id, mkEl(id)); return els.get(id); };
  getEl("sheetModal").hidden = true; // the shell ships hidden; only renderSheet unhides it
  let current = data.matches;
  const sse = {
    onmessage: null, onerror: null,
    addEventListener(type, fn) { sseHandlers[type] = fn; },
    close() { sse.closed = true; }
  };
  const api = {
    me: () => Promise.resolve(opts.me || { userId: "u1", email: "dir@club.test", roles: ["tournament_director"] }),
    getTournament: () => Promise.resolve({ tournament: data.tournament }),
    listEntrants: () => Promise.resolve({ items: data.entrants || [] }),
    listMatches: () => Promise.resolve({ items: current }),
    listDivisions: () => Promise.resolve({ items: data.divisions || [] }),
    listTournaments: () => Promise.resolve({ items: data.tournaments || [] }),
    listVenues: () => Promise.resolve({ items: [] }),
    recentPlayers: () => Promise.resolve({ items: [] }),
    createTournament: (body) => { calls.createTournament.push(body); return Promise.resolve({ tournament: data.tournament }); },
    patchTournament: (tid, body) => { calls.patchTournament.push({ tid, body }); return Promise.resolve({ tournament: data.tournament }); },
    createDivision: (tid, body) => {
      calls.createDivision.push({ tid, body });
      const d = { id: "d1", raceTo: body.raceTo };
      (data.divisions = data.divisions || []).push(d);
      return Promise.resolve({ division: d });
    },
    patchDivision: (tid, did, body) => {
      calls.patchDivision.push({ tid, did, body });
      // The server resolves the effective value; the console must show what comes back.
      (data.divisions || []).forEach((d) => { if (d.id === did) d.raceTo = body.raceTo; });
      return Promise.resolve({ division: { id: did, raceTo: body.raceTo } });
    },
    assignMatch: (tid, mid, body) => { calls.assignMatch.push({ tid, mid, body }); return Promise.resolve({ match: {} }); },
    startMatch: (tid, mid) => { calls.startMatch.push({ tid, mid }); return Promise.resolve({ match: {} }); },
    submitResult: (tid, mid, body) => { calls.submitResult.push({ tid, mid, body }); return Promise.resolve({ match: {} }); },
    matchHistory: (tid, mid) => { calls.matchHistory.push({ tid, mid }); return Promise.resolve(data.history || { versions: [] }); },
    events: () => sse
  };
  const sandbox = {
    console, URLSearchParams,
    location: { search: opts.search !== undefined ? opts.search : "?t=t1", hash: "", href: "http://x/live.html", origin: "http://x", pathname: "/live.html" },
    document: {
      getElementById: getEl,
      querySelector: (sel) => getEl("sel:" + sel),
      querySelectorAll: () => [],
      createElement: () => mkEl("new"),
      addEventListener(type, fn) { listeners[type] = fn; },
      body: mkEl("body"),
      readyState: "complete"
    },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    history: { replaceState() {}, pushState() {} },
    navigator: { userAgent: "node" },
    setTimeout(fn) { timers.push(fn); return timers.length; },
    clearTimeout() {},
    setInterval() { return 0; },
    clearInterval() {},
    EventSource: function () {},
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
    FB: { createClient: () => api }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  // live.html loads sheets.js then sheet-payload.js before live.js; do the same.
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "sheets.js"), "utf8"), sandbox, { filename: "sheets.js" });
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "sheet-payload.js"), "utf8"), sandbox, { filename: "sheet-payload.js" });
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "live.js"), "utf8"), sandbox, { filename: "live.js" });
  return {
    app: () => getEl("app").innerHTML,
    setMatches: (m) => { current = m; },
    // fire delivers an SSE event and runs the debounced reload the console registered.
    fireMessage: () => { if (sse.onmessage) sse.onmessage({ data: "{}" }); timers.splice(0).forEach((fn) => fn()); },
    sseClosed: () => sse.closed === true,
    calls,
    // click dispatches a delegated click carrying the given data-* attributes; the
    // handler's target.closest('[data-action]') resolves to that button.
    click: (attrs) => {
      const btn = { getAttribute: (k) => (k in attrs ? attrs[k] : null) };
      if (listeners.click) return listeners.click({ target: { closest: () => btn } });
    },
    change: (attrs) => {
      const sel = { id: attrs.id, value: attrs.value, classList: { contains: () => false } };
      if (listeners.change) return listeners.change({ target: sel });
    },
    setValue: (id, v) => { getEl(id).value = String(v); },
    sheetHidden: () => getEl("sheetModal").hidden === true,
    sheetTitle: () => getEl("sheetTitle").innerHTML,
    sheetNames: () => getEl("sheetNames").innerHTML,
    sheetRace: () => getEl("sheetRace").innerHTML,
    sheetBody: () => getEl("sheetBody").innerHTML,
    sheetWinner: () => getEl("sheetWinner").innerHTML,
    sheetStack: () => getEl("sheetStack").innerHTML,
    saveDisabled: () => getEl("sheetSave").disabled === true
  };
}

const tournament = { id: "t1", slug: "review-cup", name: "Review Cup", game: "15ball_rotation", state: "in_progress" };
const entrants = [
  { id: "e1", displayName: "Ada", archivedAt: null },
  { id: "e2", displayName: "Bo", archivedAt: null },
  { id: "e3", displayName: "Cy", archivedAt: null },
  { id: "e4", displayName: "Di", archivedAt: null }
];
// Double-elimination shaped set: has bracket tags → the tree renderer.
const treeClean = [
  { id: "m1", matchLabel: "W1M1", bracket: "W", bracketRound: 1, slot: 0, state: "completed", entrantAId: "e1", entrantBId: "e2", winnerEntrantId: "e1", needsReview: false },
  { id: "m2", matchLabel: "W1M2", bracket: "W", bracketRound: 1, slot: 1, state: "scheduled", entrantAId: "e3", entrantBId: "e4" }
];
const treeFlagged = [
  Object.assign({}, treeClean[0], { needsReview: true }),
  treeClean[1]
];
// Single elimination shaped set: no bracket tags → the flat list renderer.
const listClean = [
  { id: "m1", matchLabel: "W1M1", bracket: null, bracketRound: 1, slot: 0, state: "completed", entrantAId: "e1", entrantBId: "e2", winnerEntrantId: "e1", needsReview: false },
  { id: "m2", matchLabel: "W2M1", bracket: null, bracketRound: 2, slot: 0, state: "scheduled", entrantAId: "e3", entrantBId: "e4" }
];
const listFlagged = [Object.assign({}, listClean[0], { needsReview: true }), listClean[1]];

// ---- score-sheet fixtures ----
// 9-Ball: its own race default is 7, so a match payload of 11 proves the race comes
// from the match, not the game.
const nineTournament = { id: "t1", slug: "nine-cup", name: "Nine Cup", game: "9ball", state: "in_progress" };
const nineScheduled = [
  { id: "m1", matchLabel: "W1M1", bracket: null, bracketRound: 1, slot: 0, state: "scheduled", entrantAId: "e1", entrantBId: "e2", raceTo: 11 }
];
// An older server that resolved no race at all: no raceTo on the payload.
const nineNoRace = [
  { id: "m1", matchLabel: "W1M1", bracket: null, bracketRound: 1, slot: 0, state: "scheduled", entrantAId: "e1", entrantBId: "e2" }
];
// A bracketed (double-elim shaped) scheduled match: exercises bracketSlot(), the tree.
const nineTreeScheduled = [
  { id: "m1", matchLabel: "W1M1", bracket: "W", bracketRound: 1, slot: 0, state: "scheduled", entrantAId: "e1", entrantBId: "e2", raceTo: 11 }
];
// A match already on the table: the result endpoint accepts exactly in_progress (and
// reopened), so this is the state a scorer is scoring — it must open the sheet too.
const nineInProgress = [
  { id: "m1", matchLabel: "W1M1", bracket: null, bracketRound: 1, slot: 0, state: "in_progress", entrantAId: "e1", entrantBId: "e2", raceTo: 11 }
];
// A ball-marked discipline (15-Ball Rotation) for the rack body.
const rotationTournament = { id: "t1", slug: "rot-cup", name: "Rotation Cup", game: "15ball_rotation", state: "in_progress" };
const rotationScheduled = [
  { id: "m1", matchLabel: "W1M1", bracket: null, bracketRound: 1, slot: 0, state: "scheduled", entrantAId: "e1", entrantBId: "e2", raceTo: 25 }
];
// A played match carrying two saved sheets: the console's own, and a phone's tally.
const playedMatch = [
  { id: "m1", matchLabel: "W1M1", bracket: null, bracketRound: 1, slot: 0, state: "completed", entrantAId: "e1", entrantBId: "e2", winnerEntrantId: "e1", raceTo: 11 }
];
const history = { versions: [
  { id: "res_1", resultVersion: 1, winnerEntrantId: "e1", loserEntrantId: "e2",
    payload: { payloadVersion: 1, sheetKind: "tally", discipline: "9ball", measure: "wins", raceTo: 11, raceFrom: "bracket",
               finals: { a: 11, b: 4 }, winner: "A", names: { a: "Ada", b: "Bo" }, app: "score-console", appVersion: "1.0.0" },
    submittedByEmail: "dir@club.test", submittedAt: 1700000000, supersededBy: "" },
  { id: "res_2", resultVersion: 2, winnerEntrantId: "e1", loserEntrantId: "e2",
    payload: { app: "score-android", home: 11, away: 9, winner: "A" },
    submittedByEmail: "", submittedAt: 1700003600, supersededBy: "" }
] };
// Director fixtures: a draft tournament whose race the director can set.
const draftTournament = { id: "t1", slug: "race-cup", name: "Race Cup", game: "9ball", state: "draft" };

(async function run() {
  await test("console: the bracket tree marks a flagged match, and only that one", async () => {
    const c = loadConsole({ tournament, entrants, matches: treeFlagged });
    await settle();
    const html = c.app();
    assert(html.indexOf("W1M1") !== -1 && html.indexOf("W1M2") !== -1, "both matches should render: " + html.slice(0, 400));
    assert(html.indexOf("needs review") !== -1, "the flagged match should be marked: " + html.slice(0, 600));
    assert((html.match(/needs review/g) || []).length === 1, "only the flagged match is marked");
    assert(html.indexOf('class="pill warn"') !== -1, "the marker reuses the warn pill");
  });

  await test("console: the flat list marks a flagged match, and only that one", async () => {
    const c = loadConsole({ tournament, entrants, matches: listFlagged });
    await settle();
    const html = c.app();
    assert(html.indexOf("W1M1") !== -1 && html.indexOf("W2M1") !== -1, "both matches should render: " + html.slice(0, 400));
    assert((html.match(/needs review/g) || []).length === 1, "only the flagged match is marked: " + html.slice(0, 600));
  });

  await test("console: a clean bracket shows no marker at all", async () => {
    const c = loadConsole({ tournament, entrants, matches: treeClean });
    await settle();
    const html = c.app();
    assert(html.indexOf("W1M1") !== -1, "the bracket should render: " + html.slice(0, 400));
    assert(html.indexOf("needs review") === -1, "nothing flagged, nothing marked: " + html.slice(0, 400));
  });

  await test("console: the marker arrives on an SSE event, no render call by hand", async () => {
    const c = loadConsole({ tournament, entrants, matches: listClean });
    await settle();
    assert(c.app().indexOf("needs review") === -1, "precondition: clean render, no marker");
    assert(c.app().indexOf("W1M1") !== -1, "precondition: the match list rendered");

    // The server says the match now needs review; the console only hears an event.
    c.setMatches(listFlagged);
    c.fireMessage();
    await settle();

    const html = c.app();
    assert(html.indexOf("needs review") !== -1, "the SSE event should have redrawn it with the marker: " + html.slice(0, 600));
    assert((html.match(/needs review/g) || []).length === 1, "one marked match");
  });

  await test("console: an SSE event that changes nothing leaves a clean render clean", async () => {
    const c = loadConsole({ tournament, entrants, matches: treeClean });
    await settle();
    c.fireMessage(); // same data: a redraw, but no flag
    await settle();
    assert(c.app().indexOf("needs review") === -1, "a no-op event must not invent a marker: " + c.app().slice(0, 400));
  });

  // ---- score sheet: the race, the one write path, the record ----
  await test("console: the race comes from the match payload, not the game default", async () => {
    const c = loadConsole({ tournament: nineTournament, entrants, matches: nineScheduled });
    await settle();
    const slot = findButton(c.app(), (a) => a["data-action"] === "sheet" && a["data-w"] === "e1");
    assert(slot, "a player's slot opens the sheet: " + c.app().slice(0, 600));
    assert(!findButton(c.app(), (a) => a["data-action"] === "win"), "the old one-tap win action must be gone");
    c.click(slot);
    assert(c.sheetHidden() === false, "the sheet modal opens");
    assert(c.sheetRace().indexOf("11") !== -1, "the race comes from the match payload: " + c.sheetRace());
    assert(c.sheetRace().indexOf("7") === -1, "never the game's own default (9-ball = 7): " + c.sheetRace());
    assert(c.sheetRace().indexOf("from the bracket") !== -1, "and it says where it came from: " + c.sheetRace());
    assert(c.sheetWinner().indexOf("Winner: Ada") !== -1, "the tapped player is the winner candidate: " + c.sheetWinner());
    assert(c.calls.submitResult.length === 0, "opening the sheet must submit nothing");
  });

  await test("console: the bracket slot opens the sheet, and nothing else can submit", async () => {
    const c = loadConsole({ tournament: nineTournament, entrants, matches: nineTreeScheduled });
    await settle();
    const slot = findButton(c.app(), (a) => a["data-action"] === "sheet" && a["data-w"] === "e1");
    assert(slot, "the tree's player slot opens the sheet: " + c.app().slice(0, 600));
    assert(!findButton(c.app(), (a) => a["data-action"] === "win"), "the tree must render no win button");
    // A dispatched legacy 'win' (an old client, or a stale DOM) must not submit anything.
    c.click({ "data-action": "win", "data-m": "m1", "data-w": "e1", "data-l": "e2" });
    await settle();
    eq(c.calls.submitResult.length, 0, "the win action must not accept a result");
    eq(c.calls.assignMatch.length, 0, "…nor touch the match");
    eq(c.sheetHidden(), true, "…and must not open the sheet either");
    // The real slot, meanwhile, opens the sheet with that player preselected.
    c.click(slot);
    assert(c.sheetWinner().indexOf("Winner: Ada") !== -1, "the tapped player is the candidate: " + c.sheetWinner());
    eq(c.calls.submitResult.length, 0, "opening the sheet still submits nothing");
  });

  await test("console: a match already in progress opens the sheet (the state the endpoint takes)", async () => {
    const c = loadConsole({ tournament: nineTournament, entrants, matches: nineInProgress });
    await settle();
    const slot = findButton(c.app(), (a) => a["data-action"] === "sheet" && a["data-w"] === "e1");
    assert(slot, "an in-progress match's slot opens the sheet: " + c.app().slice(0, 600));
    c.click(slot);
    eq(c.sheetHidden(), false, "the sheet opens for a live match");
    assert(c.sheetRace().indexOf("11") !== -1, "with the race the bracket carries: " + c.sheetRace());
    c.click({ "data-action": "sheet-save" });
    await settle();
    eq(c.calls.submitResult.length, 1, "and its Save records the result — one submit");
  });

  await test("console: a match with no raceTo falls back to the game default and records raceFrom local", async () => {
    const c = loadConsole({ tournament: nineTournament, entrants, matches: nineNoRace });
    await settle();
    const slot = findButton(c.app(), (a) => a["data-action"] === "sheet" && a["data-w"] === "e1");
    assert(slot, "the slot still opens the sheet");
    c.click(slot);
    assert(c.sheetRace().indexOf("7") !== -1, "9-ball's local default is 7: " + c.sheetRace());
    assert(c.sheetRace().indexOf("local default") !== -1, "and the sheet says the race is local: " + c.sheetRace());
    c.click({ "data-action": "sheet-save" });
    await settle();
    assert(c.calls.submitResult.length === 1, "one submit");
    const rec = c.calls.submitResult[0].body.score;
    eq(rec.raceTo, 7, "the local default is echoed on the record");
    eq(rec.raceFrom, "local", "and labelled local");
  });

  await test("console: Save submits exactly one result whose record is the sheet", async () => {
    const c = loadConsole({ tournament: nineTournament, entrants, matches: nineScheduled });
    await settle();
    const slot = findButton(c.app(), (a) => a["data-action"] === "sheet" && a["data-w"] === "e2");
    c.click(slot);
    for (let i = 0; i < 3; i++) c.click({ "data-action": "sheet-step", "data-side": "A", "data-delta": "1" });
    assert(c.calls.submitResult.length === 0, "tapping the sheet must not submit anything");
    c.click({ "data-action": "sheet-save" });
    await settle();
    eq(c.calls.submitResult.length, 1, "exactly one result");
    const body = c.calls.submitResult[0].body;
    eq(body.winnerEntrantId, "e2", "the tapped player's slot is the winner");
    eq(body.loserEntrantId, "e1", "the other is the loser");
    const rec = body.score;
    eq(rec.payloadVersion, 1);
    eq(rec.sheetKind, "tally");
    eq(rec.discipline, "9ball");
    eq(rec.measure, "wins");
    eq(rec.raceTo, 11);
    eq(rec.raceFrom, "bracket");
    deepEq(rec.finals, { a: 3, b: 0 });
    eq(rec.winner, "B");
    eq(rec.app, "score-console");
    eq(typeof rec.appVersion, "string");
    assert(rec.appVersion.length > 0, "appVersion is recorded");
    eq(rec.racks, undefined, "a tally carries no racks: " + JSON.stringify(rec.racks));
  });

  await test("console: a double Save submits once (the busy guard)", async () => {
    const c = loadConsole({ tournament: nineTournament, entrants, matches: nineScheduled });
    await settle();
    c.click(findButton(c.app(), (a) => a["data-action"] === "sheet" && a["data-w"] === "e1"));
    c.click({ "data-action": "sheet-save" });
    c.click({ "data-action": "sheet-save" });
    assert(c.saveDisabled() === true, "Save is disabled while the call is in flight");
    await settle();
    eq(c.calls.submitResult.length, 1, "two taps, one submit: " + c.calls.submitResult.length);
  });

  await test("console: a rack discipline's record carries per-rack ball and foul detail", async () => {
    const c = loadConsole({ tournament: rotationTournament, entrants, matches: rotationScheduled });
    await settle();
    c.click(findButton(c.app(), (a) => a["data-action"] === "sheet" && a["data-w"] === "e1"));
    const markup = c.sheetBody();
    ["BALLS MADE", "FOULS", "RACK TOTAL", "GAME SUBTOTAL"].forEach((col) => {
      assert(markup.indexOf(col) !== -1, "the discipline's own column " + col + ": " + markup.slice(0, 300));
    });
    assert(findButton(markup, (a) => a["data-action"] === "sheet-ball" && a["data-rack"] === "0" && a["data-side"] === "A" && a["data-ball"] === "15"),
      "15-Ball draws ball numbers up to 15");
    [1, 2, 3].forEach((n) => c.click({ "data-action": "sheet-ball", "data-rack": "0", "data-side": "A", "data-ball": String(n) }));
    c.click({ "data-action": "sheet-foul", "data-rack": "0", "data-side": "A", "data-delta": "1" });
    c.click({ "data-action": "sheet-ball", "data-rack": "0", "data-side": "B", "data-ball": "1" });
    c.click({ "data-action": "sheet-save" });
    await settle();
    eq(c.calls.submitResult.length, 1, "one submit");
    const rec = c.calls.submitResult[0].body.score;
    eq(rec.sheetKind, "rack");
    eq(rec.kind, "rack");
    eq(rec.measure, "balls");
    deepEq(rec.racks[0].a.balls, [1, 2, 3], "the marked balls, per rack");
    eq(rec.racks[0].a.fouls, 1);
    eq(rec.racks[0].a.made, 3);
    eq(rec.racks[0].a.net, 2);
    eq(rec.racks[0].b.made, 1);
    eq(rec.finals.a, 2, "the running total is made − fouls");
    eq(rec.finals.b, 1);
    eq(rec.winner, "A", "the winner box carried the tapped player");
  });

  // ---- the stack: the read side ----
  await test("console: the stack lists saved versions newest first and reads a phone payload as a tally", async () => {
    const c = loadConsole({ tournament: nineTournament, entrants, matches: playedMatch, history });
    await settle();
    const btn = findButton(c.app(), (a) => a["data-action"] === "stack" && a["data-m"] === "m1");
    assert(btn, "a played match carries a Sheets control: " + c.app().slice(0, 600));
    c.click(btn);
    await settle();
    eq(c.calls.matchHistory.length, 1, "the control fetches the history");
    const stack = c.sheetStack();
    assert(stack.indexOf("v2") !== -1 && stack.indexOf("v1") !== -1, "both versions listed: " + stack);
    assert(stack.indexOf("v2") < stack.indexOf("v1"), "newest first: " + stack);
    assert(stack.indexOf("an open scoring link") !== -1, "no account → plainly an open scoring link: " + stack);
    assert(stack.indexOf("dir@club.test") !== -1, "the console's own sheet names its saver: " + stack);
    assert(stack.indexOf("2023-11-14") !== -1, "when is rendered readably: " + stack);
    // The newest version is selected by default: the phone's tally, 11–9.
    assert(c.sheetBody().indexOf("11\u20139") !== -1, "the phone payload reads as a tally: " + c.sheetBody());
    assert(c.sheetBody().indexOf("tally") !== -1, "…and says so: " + c.sheetBody());
    // Selecting the older version shows that version's sheet.
    c.click({ "data-action": "stack-version", "data-v": "1" });
    assert(c.sheetBody().indexOf("11\u20134") !== -1, "the older sheet is shown: " + c.sheetBody());
    // Closing repaints the bracket, where the control now knows its count.
    c.click({ "data-action": "sheet-close" });
    assert(c.app().indexOf("Sheets (2)") !== -1, "the control shows the count once known: " + c.app().slice(0, 500));
  });

  // ---- director: the race ----
  await test("console: the create form passes the race to the division", async () => {
    const c = loadConsole({ tournament: draftTournament, entrants, matches: [] }, { search: "" });
    await settle();
    c.setValue("tname", "Race Cup");
    c.setValue("tgame", "9ball");
    c.setValue("trace", "11");
    c.click({ "data-action": "create-tournament" });
    await settle();
    eq(c.calls.createTournament.length, 1, "the tournament is created");
    eq(c.calls.createTournament[0].game, "9ball");
    c.click({ "data-action": "open-reg" });
    await settle();
    eq(c.calls.createDivision.length, 1, "one division");
    eq(c.calls.createDivision[0].body.raceTo, 11, "carrying the director's race");
  });

  await test("console: the director's race edit patches the division and shows the server value", async () => {
    const c = loadConsole({ tournament: draftTournament, entrants, matches: [], divisions: [{ id: "d1", raceTo: 7 }] }, { search: "" });
    await settle();
    c.click({ "data-action": "open-t", "data-id": "t1" });
    await settle();
    assert(c.app().indexOf("Effective now: Race to 7") !== -1, "shows the effective server value: " + c.app().slice(0, 700));
    c.setValue("raceedit", "11");
    c.click({ "data-action": "race-save", "data-id": "d1" });
    await settle();
    eq(c.calls.patchDivision.length, 1, "one patch");
    eq(c.calls.patchDivision[0].body.raceTo, 11);
    assert(c.app().indexOf("Effective now: Race to 11") !== -1, "shows what came back, not what was typed: " + c.app().slice(0, 700));
  });

  console.log(`\n${passed} passed, ${failed} failed.`);
  process.exit(failed === 0 ? 0 : 1);
})();
