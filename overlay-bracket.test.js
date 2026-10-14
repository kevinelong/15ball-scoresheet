/* Bracket-overlay rule tests.
   Run with:  node overlay-bracket.test.js

   The OBS bracket overlay records win/loss and nothing else, exactly like the in-app
   bracket card: the winning slot is marked (a ✓ and the `win` class), the losing slot is
   marked `lose`, and no numeric score appears anywhere. The overlay's API never carries a
   score, but this test hands each match both a `score` and a `sheet` anyway, so the
   assertion has teeth: if the render ever started printing one, it would show up here.

   overlay-bracket.js runs in a hand-rolled DOM/FB stub (same style as review-flags.test.js).
   Assertions are positive, so a swallowed error cannot pass as success. */

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
function flush() { return new Promise((r) => setTimeout(r, 0)); }

function el() {
  return {
    innerHTML: "", textContent: "", value: "", style: {}, hidden: false,
    classList: { add() {}, remove() {}, contains() { return false; } },
    setAttribute() {}, getAttribute() { return null; }, appendChild() {},
    addEventListener() {}, removeEventListener() {}, querySelector() { return el(); },
    querySelectorAll() { return []; }, closest() { return null; }
  };
}

// Loads overlay-bracket.js against the given data and returns the app element it writes.
function loadOverlay(data) {
  const app = el();
  const api = {
    getTournament: () => Promise.resolve({ tournament: data.tournament }),
    listEntrants: () => Promise.resolve({ items: data.entrants || [] }),
    listMatches: () => Promise.resolve({ items: data.matches || [] }),
    events: () => ({ addEventListener() {}, close() {}, onmessage: null, onerror: null })
  };
  const sandbox = {
    console, URLSearchParams,
    location: { search: "?t=t1", href: "http://localhost/overlay-bracket.html" },
    document: {
      getElementById: (id) => (id === "app" ? app : el()),
      addEventListener() {}, body: el(), readyState: "complete", createElement: () => el()
    },
    FB: { createClient: () => api },
    setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {},
    EventSource: function () {}
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "overlay-bracket.js"), "utf8"), sandbox, { filename: "overlay-bracket.js" });
  return app;
}

const tournament = { id: "t1", name: "Card Cup", game: "15ball_rotation", state: "in_progress" };
const entrants = [
  { id: "e1", displayName: "Ada", seed: 1 },
  { id: "e2", displayName: "Bo", seed: 2 }
];

// A decided match that carries a score and a sheet the overlay should never print.
function decided(winnerId, score, sheet) {
  return {
    id: "m1", matchLabel: "W1M1", bracket: "W", bracketRound: 1, slot: 0,
    state: "completed", entrantAId: "e1", entrantBId: "e2",
    winnerEntrantId: winnerId, score: score, sheet: sheet
  };
}

(async function run() {
  const cases = [
    { name: "Ada wins slot A", winner: "e1", aClass: "slot win", bClass: "slot lose" },
    { name: "Bo wins slot B", winner: "e2", aClass: "slot lose", bClass: "slot win" }
  ];

  for (const c of cases) {
    await test(`overlay bracket card: ${c.name}, marked with no score`, async () => {
      const match = decided(c.winner, "25-10", { finalA: 25, finalB: 10 });
      const app = loadOverlay({ tournament, entrants, matches: [match] });
      await flush(); await flush(); await flush();
      const html = app.innerHTML;

      assert(html.length > 0, "the overlay should render the bracket, not stand by");
      assert(html.indexOf('<div class="' + c.aClass + '">') !== -1,
        `slot A should be marked ${c.aClass}, got: ${html}`);
      assert(html.indexOf('<div class="' + c.bClass + '">') !== -1,
        `slot B should be marked ${c.bClass}, got: ${html}`);
      assert(html.indexOf('<span class="score">✓</span>') !== -1,
        `the winning slot carries the ✓ marker: ${html}`);
      // The score the tournament provider could attach must stay off the overlay.
      assert(html.indexOf("25") === -1, `no 25 anywhere in the markup: ${html}`);
      assert(html.indexOf("10") === -1, `no 10 anywhere in the markup: ${html}`);
      assert(!/class="score">\s*\d/.test(html), `the score slot holds no number: ${html}`);
    });
  }

  console.log(`\n${passed} passed, ${failed} failed.`);
  process.exit(failed === 0 ? 0 : 1);
})();
