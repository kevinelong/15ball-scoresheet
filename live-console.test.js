/* Drives live.js (the cloud console) in a hand-rolled DOM/FB stub.
   Run with:  node live-console.test.js

   The console must show a review-flagged match rather than render it as normal, in both
   the bracket tree and the flat match list, and it must pick the flag up from an SSE
   event without anyone calling a render function by hand. Assertions are positive
   (markup must contain X), so a swallowed error cannot pass as success. */

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

// loadConsole runs live.js in public scoring mode (?t=) against the given data. The
// match list is live: setMatches() swaps what the next fetch returns, which is how the
// SSE test simulates the server changing underneath the console.
function loadConsole(data) {
  const els = new Map();
  const timers = [];
  const sseHandlers = {};
  const getEl = (id) => { if (!els.has(id)) els.set(id, mkEl(id)); return els.get(id); };
  let current = data.matches;
  const sse = {
    onmessage: null, onerror: null,
    addEventListener(type, fn) { sseHandlers[type] = fn; },
    close() { sse.closed = true; }
  };
  const api = {
    getTournament: () => Promise.resolve({ tournament: data.tournament }),
    listEntrants: () => Promise.resolve({ items: data.entrants || [] }),
    listMatches: () => Promise.resolve({ items: current }),
    recentPlayers: () => Promise.resolve({ items: [] }),
    events: () => sse
  };
  const sandbox = {
    console, URLSearchParams,
    location: { search: "?t=t1", hash: "", href: "http://x/live.html", origin: "http://x", pathname: "/live.html" },
    document: {
      getElementById: getEl,
      querySelector: (sel) => getEl("sel:" + sel),
      querySelectorAll: () => [],
      createElement: () => mkEl("new"),
      addEventListener() {},
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
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "live.js"), "utf8"), sandbox, { filename: "live.js" });
  return {
    app: () => getEl("app").innerHTML,
    setMatches: (m) => { current = m; },
    // fire delivers an SSE event and runs the debounced reload the console registered.
    fireMessage: () => { if (sse.onmessage) sse.onmessage({ data: "{}" }); timers.splice(0).forEach((fn) => fn()); },
    sseClosed: () => sse.closed === true
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

  console.log(`\n${passed} passed, ${failed} failed.`);
  process.exit(failed === 0 ? 0 : 1);
})();
