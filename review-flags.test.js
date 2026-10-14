/* Review-flag surfacing tests for the clients that render a bracket.
   Run with:  node review-flags.test.js

   A match can come back flagged for review when a corrected upstream result reaches
   it after it was played (03-state-machines "Match review flag"). The OBS overlay and
   the console must show that state — never look normal, never crash.

   overlay-live.js runs in a hand-rolled DOM/FB stub (same style as migration.test.js);
   live.js is a closed IIFE, so it is loaded for a no-throw check plus a source check
   that a flagged match is marked. */

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

function el() {
  return {
    innerHTML: "", textContent: "", value: "", style: {}, hidden: false,
    classList: { add() {}, remove() {}, contains() { return false; } },
    setAttribute() {}, getAttribute() { return null; }, appendChild() {},
    addEventListener() {}, removeEventListener() {}, querySelector() { return el(); },
    querySelectorAll() { return []; }, closest() { return null; }
  };
}
function flush() { return new Promise((r) => setTimeout(r, 0)); }

// Loads overlay-live.js against the given data and returns the card element.
function loadOverlay(data) {
  const card = el();
  const api = {
    getTournament: () => Promise.resolve({ tournament: data.tournament }),
    listEntrants: () => Promise.resolve({ items: data.entrants || [] }),
    listMatches: () => Promise.resolve({ items: data.matches || [] }),
    events: () => ({ addEventListener() {}, close() {}, onmessage: null, onerror: null })
  };
  const sandbox = {
    console, URLSearchParams,
    location: { search: "?t=t1", href: "http://localhost/overlay-live.html" },
    document: {
      getElementById: (id) => (id === "card" ? card : el()),
      addEventListener() {}, body: el(), readyState: "complete", createElement: () => el()
    },
    FB: { createClient: () => api },
    setInterval: () => 0, clearInterval() {}, setTimeout: (fn) => 0, clearTimeout() {},
    EventSource: function () {}
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "overlay-live.js"), "utf8"), sandbox, { filename: "overlay-live.js" });
  return card;
}

const tournament = { id: "t1", name: "Review Cup", game: "15ball_rotation", state: "in_progress" };
const entrants = [
  { id: "e1", displayName: "Ada", archivedAt: null },
  { id: "e2", displayName: "Bo", archivedAt: null },
  { id: "e3", displayName: "Cy", archivedAt: null }
];
const live = { id: "m2", matchLabel: "W1M2", bracket: "W", bracketRound: 1, slot: 1, state: "in_progress", entrantAId: "e2", entrantBId: "e3" };
const flaggedFinal = { id: "m3", matchLabel: "W2M1", bracket: "W", bracketRound: 2, slot: 0, state: "completed", entrantAId: "e1", entrantBId: "e3", winnerEntrantId: "e3", needsReview: true };
const cleanFinal = Object.assign({}, flaggedFinal, { needsReview: false });
const cleanLive = Object.assign({}, live, { needsReview: false });

(async function run() {
  await test("overlay: a flagged match that is not featured still shows on the card", async () => {
    const card = loadOverlay({ tournament, entrants, matches: [live, flaggedFinal] });
    await flush(); await flush(); await flush();
    assert(card.innerHTML.indexOf("Needs review: W2M1") !== -1, "expected the review tag, got: " + card.innerHTML);
    assert(card.innerHTML.indexOf("W1M2") !== -1, "the live match should still be featured: " + card.innerHTML);
  });

  await test("overlay: a flagged featured match is named in the tag", async () => {
    const card = loadOverlay({ tournament, entrants, matches: [Object.assign({}, live, { needsReview: true }), cleanFinal] });
    await flush(); await flush(); await flush();
    assert(card.innerHTML.indexOf("Needs review: W1M2") !== -1, "expected the featured label, got: " + card.innerHTML);
  });

  await test("overlay: nothing flagged, nothing shown", async () => {
    const card = loadOverlay({ tournament, entrants, matches: [cleanLive, cleanFinal] });
    await flush(); await flush(); await flush();
    assert(card.innerHTML.indexOf("Needs review") === -1, "no flag should render no tag: " + card.innerHTML);
    assert(card.innerHTML.indexOf("W1M2") !== -1, "the live match should still render: " + card.innerHTML);
  });

  await test("overlay: standing by still reports an outstanding review", async () => {
    const card = loadOverlay({ tournament, entrants, matches: [flaggedFinal] });
    await flush(); await flush(); await flush();
    assert(card.innerHTML.indexOf("Standing by") !== -1, "expected the standby card: " + card.innerHTML);
    assert(card.innerHTML.indexOf("Needs review: W2M1") !== -1, "the standby card must not look normal: " + card.innerHTML);
  });

  await test("live.js loads under a DOM stub without throwing", () => {
    const sandbox = {
      console, URLSearchParams,
      location: { search: "", hash: "", href: "http://localhost/live.html" },
      document: (() => {
        const stub = new Proxy(function () { return stub; }, {
          get: (t, k) => (k === "innerHTML" || k === "textContent" || k === "value" ? "" : stub),
          set: () => true, apply: () => stub
        });
        return { getElementById: () => stub, querySelector: () => stub, querySelectorAll: () => [],
          addEventListener() {}, removeEventListener() {}, body: stub, readyState: "complete", createElement: () => stub };
      })(),
      localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      history: { replaceState() {}, pushState() {} },
      navigator: { userAgent: "node" },
      setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
      EventSource: function () {}, fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
      FB: { createClient: () => new Proxy({}, { get: () => () => Promise.resolve({ items: [] }) }) }
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "live.js"), "utf8"), sandbox, { filename: "live.js" });
  });

  await test("live.js marks a flagged match in both renderers", () => {
    const src = fs.readFileSync(path.join(__dirname, "live.js"), "utf8");
    assert(/function reviewPill\(m\)\s*\{[^}]*needsReview/.test(src), "reviewPill should key off needsReview");
    assert(src.indexOf("pill warn") !== -1, "the marker should reuse the warn pill");
    const matchRow = src.slice(src.indexOf("function matchRow"), src.indexOf("function shortName"));
    const bracketCard = src.slice(src.indexOf("function bracketCard"), src.indexOf("function bracketColumn"));
    assert(matchRow.indexOf("reviewPill(m)") !== -1, "the match list should mark a flagged match");
    assert(bracketCard.indexOf("reviewPill(m)") !== -1, "the bracket card should mark a flagged match");
  });

  console.log(`\n${passed} passed, ${failed} failed.`);
  process.exit(failed === 0 ? 0 : 1);
})();
