/* Transport-level tests for api-client.js. Run with:  node api-client.test.js

   The repair path for a review-flagged match is API-only today (no console button), so
   its client half is pinned here: the documented verb, path, Idempotency-Key and body.
   fetch is stubbed, so nothing leaves the process. */

const assert = require("assert");
const api = require("./api-client.js");

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

// capture() stubs fetch and returns the recorded requests.
function capture(body) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify(body === undefined ? { match: { id: "m1" } } : body)
    };
  };
  return calls;
}

function client() { return api.createClient({ base: "https://club.test/15ball/api" }); }

(async function run() {
  await test("clearMatchReview: verb, path, key, body and CSRF header", async () => {
    const calls = capture();
    await client().clearMatchReview("t1", "m1", "replayed with the corrected players", "key-1");
    assert.strictEqual(calls.length, 1, "one request");
    const { url, opts } = calls[0];
    assert.strictEqual(url, "https://club.test/15ball/api/v1/tournaments/t1/matches/m1/clear-review");
    assert.strictEqual(opts.method, "POST");
    assert.strictEqual(opts.headers["Idempotency-Key"], "key-1");
    assert.strictEqual(opts.headers["X-CO"], "1", "mutations carry the CSRF header");
    assert.strictEqual(opts.headers["Content-Type"], "application/json");
    assert.strictEqual(opts.credentials, "include", "the session cookie must go along");
    assert.deepStrictEqual(JSON.parse(opts.body), { reason: "replayed with the corrected players" });
  });

  await test("clearMatchReview: reason is optional and ids are url-encoded", async () => {
    const calls = capture();
    await client().clearMatchReview("t/1", "m 1", undefined, "key-2");
    const { url, opts } = calls[0];
    assert.strictEqual(url, "https://club.test/15ball/api/v1/tournaments/t%2F1/matches/m%201/clear-review");
    assert.deepStrictEqual(JSON.parse(opts.body), {}, "no reason → empty body, still a POST");
    assert.strictEqual(opts.headers["Idempotency-Key"], "key-2");
  });

  await test("clearMatchReview: a key is generated when the caller omits one", async () => {
    const calls = capture();
    const c = client();
    await c.clearMatchReview("t1", "m1");
    await c.clearMatchReview("t1", "m1");
    const k1 = calls[0].opts.headers["Idempotency-Key"];
    const k2 = calls[1].opts.headers["Idempotency-Key"];
    assert.ok(k1 && k1.length > 0, "a key is always sent (the endpoint requires one)");
    assert.notStrictEqual(k1, k2, "a fresh key per action, so retries are the caller's call");
  });

  await test("clearMatchReview: a 409 not_flagged surfaces as FBApiError", async () => {
    globalThis.fetch = async () => ({
      ok: false, status: 409, statusText: "Conflict",
      text: async () => JSON.stringify({ error: { code: "not_flagged", message: "match does not require review" } })
    });
    await assert.rejects(
      () => client().clearMatchReview("t1", "m1", "x", "key-3"),
      (e) => e instanceof api.FBApiError && e.status === 409 && e.code === "not_flagged"
    );
  });

  await test("the documented repair path is reachable end to end from the client", async () => {
    const calls = capture();
    const c = client();
    await c.reopenMatch("t1", "m1", "replay after the correction", "k-reopen");
    await c.submitResult("t1", "m1", { winnerEntrantId: "e1", loserEntrantId: "e2" }, "k-result");
    await c.clearMatchReview("t1", "m1", "replayed", "k-clear");
    assert.deepStrictEqual(calls.map((x) => x.opts.method), ["POST", "POST", "POST"]);
    assert.deepStrictEqual(
      calls.map((x) => x.url.replace("https://club.test/15ball/api/v1/tournaments/t1/matches/m1", "")),
      ["/reopen", "/result", "/clear-review"]
    );
    assert.deepStrictEqual(
      calls.map((x) => x.opts.headers["Idempotency-Key"]),
      ["k-reopen", "k-result", "k-clear"]
    );
  });

  console.log(`\n${passed} passed, ${failed} failed.`);
  process.exit(failed === 0 ? 0 : 1);
})();
