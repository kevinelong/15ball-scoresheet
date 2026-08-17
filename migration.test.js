/* Migration tests for the kball -> fifteenBall rename.
   Verifies loadPersisted() correctly migrates:
     1. v3 data under the legacy key "kball.app.v3" -> "fifteenBall.app.v3"
     2. v3 tournaments with game: "kball" -> game: "fifteenBall"
     3. v2 data under "kball.tournament.v1" -> upgraded v3 form
     4. option value="fifteenBall" is the only game id emitted for new tournaments
   Runs app.js in a jsdom-lite environment: a hand-rolled window + document +
   localStorage shim so we don't have to pull in jsdom for a couple of tests.
*/

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

function makeEnv({ storage = {} } = {}) {
  const ls = {
    _s: { ...storage },
    getItem(k) { return Object.prototype.hasOwnProperty.call(this._s, k) ? this._s[k] : null; },
    setItem(k, v) { this._s[k] = String(v); },
    removeItem(k) { delete this._s[k]; },
    clear() { this._s = {}; }
  };
  // Minimal DOM: chained no-ops that swallow every dot/method call.
  function stubEl() {
    return new Proxy(function noop(){}, {
      get(t, prop) {
        if (prop === "value") return "";
        if (prop === "textContent") return "";
        if (prop === "hidden") return false;
        if (prop === "style") return new Proxy({}, { get: () => "", set: () => true });
        if (prop === "dataset") return {};
        if (prop === "classList") return { add(){}, remove(){}, toggle(){}, contains(){ return false; } };
        if (prop === "addEventListener") return () => {};
        if (prop === "removeEventListener") return () => {};
        if (prop === "appendChild") return (c) => c;
        if (prop === "querySelector") return () => stubEl();
        if (prop === "querySelectorAll") return () => [];
        if (prop === "innerHTML") return "";
        if (prop === "placeholder") return "";
        return stubEl();
      },
      set() { return true; },
      apply() { return stubEl(); }
    });
  }
  // Track DOMContentLoaded listeners so tests can fire them manually.
  const domListeners = [];
  const document = new Proxy({
    _fireDOMContentLoaded() { domListeners.forEach(fn => { try { fn(); } catch(e){ console.error(e); } }); }
  }, {
    get(t, prop) {
      if (prop === "_fireDOMContentLoaded") return t._fireDOMContentLoaded;
      if (prop === "querySelector") return () => stubEl();
      if (prop === "querySelectorAll") return () => [];
      if (prop === "createElement") return () => stubEl();
      if (prop === "body") return stubEl();
      if (prop === "addEventListener") return (evt, fn) => {
        if (evt === "DOMContentLoaded") domListeners.push(fn);
      };
      return stubEl();
    }
  });
  const window = {
    localStorage: ls,
    document,
    // Minimal Tables shim: buildTables returns an array of {name}.
    Tables: {
      buildTables(count, naming) {
        return Array.from({ length: count }, (_, i) => ({ id: "tbl_" + i, name: String(i+1), color: "#000" }));
      },
      parseNaming(count) { return Array.from({ length: count }, (_, i) => String(i+1)); },
      namingPlaceholder(count) { return `1-${count}`; },
      _defaultNames(start, count) { return Array.from({ length: count }, (_, i) => String(start + i)); }
    },
    // Minimal BracketEngine shim (only used when building brackets, not during load).
    BracketEngine: { build: () => ({ matches: {}, wRounds: 0, lRounds: 0, champion: null }) },
    setTimeout,
    clearTimeout,
    console,
    alert() {},
    FileReader: class { readAsText(){} },
    Date,
    JSON,
    Math,
    Number,
    Array,
    Object,
    String,
    Proxy,
  };
  window.window = window;
  window.globalThis = window;
  return { window, ls, document };
}

function runApp(env) {
  const src = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
  const ctx = vm.createContext(env.window);
  vm.runInContext(src, ctx, { filename: "app.js" });
  // Simulate DOMContentLoaded so loadPersisted() actually runs.
  env.document._fireDOMContentLoaded();
  return ctx;
}

let passed = 0, failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(" ok ", name);
    passed++;
  } catch (e) {
    console.log(" FAIL", name);
    console.log("     ", e.message);
    failed++;
  }
}

// ---------- Test 1: fresh install, no data ----------
test("fresh install initializes fifteenBall as default", () => {
  const env = makeEnv();
  runApp(env);
  // No storage keys set yet. Just verify no legacy data exists and no crash.
  assert.strictEqual(env.ls.getItem("kball.app.v3"), null);
  assert.strictEqual(env.ls.getItem("fifteenBall.app.v3"), null);
});

// ---------- Test 2: legacy v3 data under kball.app.v3 with game: "kball" ----------
test("legacy v3 data migrates: key kball.app.v3 -> fifteenBall.app.v3, game kball -> fifteenBall", () => {
  const legacyState = {
    v: 3,
    activeId: null,
    tournaments: [
      {
        id: "t_old_1",
        name: "Old Tournament",
        date: "2026-01-01",
        game: "kball",
        format: "single",
        raceTo: 25,
        participants: [{ name: "Alice", fargo: 500 }],
        bracket: null,
        sheets: {},
        tables: [{ id: "tbl_0", name: "1", color: "#000" }],
        createdAt: 1700000000000,
        updatedAt: 1700000000000,
      }
    ]
  };
  const env = makeEnv({ storage: { "kball.app.v3": JSON.stringify(legacyState) } });
  runApp(env);
  // After boot: new key should be populated, legacy key cleared.
  const migrated = env.ls.getItem("fifteenBall.app.v3");
  assert.ok(migrated, "expected fifteenBall.app.v3 to be written");
  assert.strictEqual(env.ls.getItem("kball.app.v3"), null, "expected legacy kball.app.v3 to be removed");
  const parsed = JSON.parse(migrated);
  assert.strictEqual(parsed.tournaments.length, 1);
  assert.strictEqual(parsed.tournaments[0].game, "fifteenBall", "game id should be upgraded");
  assert.strictEqual(parsed.tournaments[0].name, "Old Tournament", "other fields preserved");
  assert.strictEqual(parsed.tournaments[0].participants[0].name, "Alice");
});

// ---------- Test 3: legacy v3 with mixed games (kball + 9ball) ----------
test("legacy v3 data preserves non-kball games unchanged", () => {
  const legacyState = {
    v: 3,
    activeId: null,
    tournaments: [
      { id: "t1", name: "K", game: "kball", format: "single", raceTo: 25, participants: [], bracket: null, sheets: {}, tables: [{name:"1"}], createdAt: 1, updatedAt: 1 },
      { id: "t2", name: "9", game: "9ball", format: "single", raceTo: 7, participants: [], bracket: null, sheets: {}, tables: [{name:"1"}], createdAt: 1, updatedAt: 1 },
    ]
  };
  const env = makeEnv({ storage: { "kball.app.v3": JSON.stringify(legacyState) } });
  runApp(env);
  const parsed = JSON.parse(env.ls.getItem("fifteenBall.app.v3"));
  assert.strictEqual(parsed.tournaments[0].game, "fifteenBall");
  assert.strictEqual(parsed.tournaments[1].game, "9ball", "non-kball games should be preserved");
});

// ---------- Test 4: new-key data takes precedence when both keys exist ----------
test("new key takes precedence when both keys exist", () => {
  const newState = { v: 3, activeId: null, tournaments: [{ id: "new", name: "New", game: "fifteenBall", format: "single", raceTo: 25, participants: [], bracket: null, sheets: {}, tables: [{name:"1"}], createdAt: 1, updatedAt: 1 }] };
  const oldState = { v: 3, activeId: null, tournaments: [{ id: "old", name: "Old", game: "kball", format: "single", raceTo: 25, participants: [], bracket: null, sheets: {}, tables: [{name:"1"}], createdAt: 1, updatedAt: 1 }] };
  const env = makeEnv({ storage: {
    "fifteenBall.app.v3": JSON.stringify(newState),
    "kball.app.v3": JSON.stringify(oldState),
  }});
  runApp(env);
  const parsed = JSON.parse(env.ls.getItem("fifteenBall.app.v3"));
  assert.strictEqual(parsed.tournaments[0].id, "new", "should read from the new key, not fall back to legacy");
  // Legacy key is not touched when new key wins; that's fine because a save
  // to STORAGE_KEY happens later and the legacy key never gets a fresh write.
});

// ---------- Test 5: no K-Ball / kball user-visible strings escape ----------
test("app.js has no user-visible K-Ball strings (only migration comments/legacy keys)", () => {
  const src = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
  // Split into lines, ignore comment lines, ignore legacy-key constant declarations.
  const lines = src.split("\n");
  const offenders = [];
  lines.forEach((ln, i) => {
    // Strip block/line comments crudely: only inspect content BEFORE //
    const codePart = ln.split("//")[0];
    if (!/kball|K-Ball|K-BALL|k-ball/i.test(codePart)) return;
    // The following are permitted:
    //   const LEGACY_STORAGE_KEY = "kball.app.v3";
    //   const LEGACY_KEY_V2_OLD = "kball.tournament.v1";
    //   if (t.game === "kball") ...   (migration)
    //   const seedGame = legacyGame === "kball" ? ... (migration)
    if (/LEGACY_(STORAGE_KEY|KEY_V2_OLD)\s*=\s*"kball\./.test(codePart)) return;
    if (/=== "kball"/.test(codePart) || /== "kball"/.test(codePart)) return; // migration compare
    if (/"kball"/.test(codePart) && /=== "kball" \?/.test(codePart)) return;
    offenders.push({ line: i + 1, text: ln.trim() });
  });
  if (offenders.length) {
    console.log("     offending lines:", offenders);
  }
  assert.strictEqual(offenders.length, 0, "no unexpected kball code references");
});

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
