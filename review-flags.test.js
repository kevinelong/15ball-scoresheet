/* Review-flag surfacing tests for the OBS overlay client.
   Run with:  node review-flags.test.js

   A match can come back flagged for review when a corrected upstream result reaches it
   after it was played (03-state-machines "Match review flag"). The overlay must show that
   state - never look normal, never crash - and the normalized `overlay.reviewRequired`
   that a non-DOM consumer reads must agree with what the DOM shows. The four cases here
   mirror the four subtests of TestOverlayReviewRequired in bracket_review_paths_test.go,
   which pins the server side of that signal.

   overlay-live.js runs in a hand-rolled DOM/FB stub (same style as migration.test.js).
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

// Loads overlay-live.js against the given data and returns the card element it writes.
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

// The rule the server implements for snapshot.overlay.reviewRequired: true when any match
// of the tournament carries needsReview.
const anyFlagged = (ms) => ms.filter((m) => m.needsReview === true).length > 0;

const tournament = { id: "t1", name: "Review Cup", game: "15ball_rotation", state: "in_progress" };
const entrants = [
  { id: "e1", displayName: "Ada", archivedAt: null },
  { id: "e2", displayName: "Bo", archivedAt: null },
  { id: "e3", displayName: "Cy", archivedAt: null }
];
const live = { id: "m2", matchLabel: "W1M2", bracket: "W", bracketRound: 1, slot: 1, state: "in_progress", entrantAId: "e2", entrantBId: "e3" };
const flagged = { id: "m3", matchLabel: "W2M1", bracket: "W", bracketRound: 2, slot: 0, state: "completed", entrantAId: "e1", entrantBId: "e3", winnerEntrantId: "e3", needsReview: true };

const cases = [
  { name: "flagged match that is not featured", matches: [live, flagged], reviewRequired: true, tag: "Needs review: W2M1", also: "W1M2" },
  { name: "flagged featured match", matches: [Object.assign({}, live, { needsReview: true }), Object.assign({}, flagged, { needsReview: false })], reviewRequired: true, tag: "Needs review: W1M2", also: null },
  { name: "clean bracket", matches: [Object.assign({}, live, { needsReview: false }), Object.assign({}, flagged, { needsReview: false })], reviewRequired: false, tag: null, also: "W1M2" },
  { name: "flagged bracket with nothing live", matches: [flagged], reviewRequired: true, tag: "Needs review: W2M1", also: "Standing by" }
];

(async function run() {
  for (const c of cases) {
    await test(`overlay: ${c.name}`, async () => {
      // The fixture has to describe the bracket consistently with the normalized signal.
      assert(anyFlagged(c.matches) === c.reviewRequired,
        `fixture: anyFlagged=${anyFlagged(c.matches)} but reviewRequired=${c.reviewRequired}`);

      const card = loadOverlay({ tournament, entrants, matches: c.matches });
      await flush(); await flush(); await flush();
      const html = card.innerHTML;

      if (c.also) {
        assert(html.indexOf(c.also) !== -1, `expected ${c.also} in the card, got: ${html}`);
      }
      if (c.tag) {
        assert(html.indexOf(c.tag) !== -1, `expected the review tag "${c.tag}", got: ${html}`);
      } else {
        assert(html.indexOf("Needs review") === -1, `expected no review tag, got: ${html}`);
      }
      // The DOM signal and the normalized signal agree in every case.
      assert((html.indexOf("Needs review") !== -1) === c.reviewRequired,
        "the rendered tag must agree with overlay.reviewRequired");
    });
  }

  console.log(`\n${passed} passed, ${failed} failed.`);
  process.exit(failed === 0 ? 0 : 1);
})();
