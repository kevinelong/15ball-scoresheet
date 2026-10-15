// sheet-queue.test.js — the printed-sheet queue (decision 018).
//
// Decision 018 requires three bracket-propagation cases: Round 1 is ready the moment the
// bracket is built, saving a Round 1 winner makes the right semi-final ready, and editing a
// saved winner makes its downstream sheet a reprint with a bumped version. They live here
// rather than in bracket.test.js because the state they assert is this module's; bracket.js
// keeps its own engine primitives and its own suite.
//
// Run:  node sheet-queue.test.js
require("./bracket.js");
const B = globalThis.BracketEngine;
const Q = require("./sheet-queue.js");

let pass = 0, fail = 0;
function ok(label, cond, extra) {
  if (cond) { console.log(" ok  " + label); pass++; }
  else { console.log("FAIL " + label + (extra ? "  " + extra : "")); fail++; }
}
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

const BYE = { id: "__bye__", name: "\u2014 BYE \u2014", isBye: true };

// A match with the fields bracket.js gives every match, so the queue reads a real shape.
function mk(id, who, opts) {
  const o = opts || {};
  return {
    id: id,
    round: o.round || 1,
    bracket: o.bracket || "W",
    slots: [who[0] ? { name: who[0], seed: 1 } : null,
            o.bye ? BYE : (who[1] ? { name: who[1], seed: 2 } : null)],
    winner: null,
    score: null,
    sheetIssuedAt: null,
    sheetIssueVersion: 0,
    sheetPlayersSnapshot: null,
    sheetRaceTo: null
  };
}

function tour(bracket, opts) {
  return Object.assign({
    id: "t_" + (opts && opts.id || "q"),
    name: "Queue test",
    game: "9ball",
    format: "single_elim",
    raceTo: 7,
    bracket: { matches: bracket }
  }, opts || {});
}

const T1 = "2026-10-15T14:00:00.000Z";
const T2 = "2026-10-15T14:05:00.000Z";

// -------- who is ready for a sheet --------
console.log("\n[ready]");
{
  const m = mk("W1M1", ["Alice", "Bob"]);
  ok("a named pairing names its two players", eq(Q.names(m), ["Alice", "Bob"]));
  ok("and is ready", Q.ready(m) && Q.state(m, tour({})) === "ready");
  ok("a match with a BYE is not a pairing", Q.names(mk("W1M2", ["Alice", "Bob"], { bye: true })) === null);
  ok("a match with one player known is not either", Q.names(mk("W2M1", ["Alice", null])) === null);
  ok("an unresolved match is pending, not ready", Q.state(mk("W2M1", [null, null]), tour({})) === "pending");
}

// -------- issuing, and what makes an issue stale --------
console.log("\n[issue]");
{
  const m = mk("W1M1", ["Alice", "Bob"]);
  const t = tour({ W1M1: m });
  const rec = Q.mark(m, t, T1);
  ok("the first issue is v1", rec.version === 1, "got " + rec.version);
  ok("it stamps the names printed", eq(rec.snapshot, ["Alice", "Bob"]));
  ok("it stamps the target printed", rec.raceTo === 7, "got " + rec.raceTo);
  ok("its stamp reads back as the ISO time given", rec.at === T1, "got " + rec.at);
  ok("a printed sheet that still agrees with the bracket is current", Q.state(m, t) === "printed");
  ok("and is not stale", Q.stale(m, t) === false);
  ok("the record is bracket.js's own fields, not a second copy",
     m.sheetIssueVersion === 1 && m.sheetIssuedAt === Date.parse(T1) && eq(m.sheetPlayersSnapshot, ["Alice", "Bob"]));

  const second = Q.mark(m, t, T2);
  ok("a second copy of the same sheet is issued as v2", second.version === 2, "got " + second.version);
  ok("and it is still current", Q.state(m, t) === "printed");

  const pending = mk("W2M1", [null, null]);
  ok("a pending match cannot be issued", Q.mark(pending, t, T1) === null && Q.issue(pending) === null);

  ok("an edited name voids the paper", (() => {
    m.slots[0] = { name: "Carol", seed: 3 };
    return Q.state(m, t) === "stale";
  })());
  const reprint = Q.mark(m, t, T2);
  ok("the reprint bumps the version", reprint.version === 3, "got " + reprint.version);
  ok("and carries the corrected names", eq(reprint.snapshot, ["Carol", "Bob"]));
  ok("so the sheet is current again", Q.state(m, t) === "printed");

  ok("a target changed after printing voids the paper too",
     Q.state(m, { raceTo: 25 }) === "stale");
  ok("...and so does a target that went away", Q.state(m, {}) === "stale");
  ok("the tournament's own target leaves it current", Q.state(m, { raceTo: 7 }) === "printed");

  const gone = mk("W2M1", ["Alice", "Bob"]);
  Q.mark(gone, t, T1);
  gone.slots[0] = null;
  ok("a sheet whose pairing went away is void, not pending again", Q.state(gone, t) === "stale");
}

// -------- reading a record an older console left --------
console.log("\n[old records]");
{
  const m = mk("W1M1", ["Alice", "Bob"]);
  m.sheetIssuedAt = T1;                       // the older shape stored an ISO string
  m.sheetIssueVersion = 2;
  m.sheetPlayersSnapshot = ["Alice", "Bob"];
  const rec = Q.issue(m);
  ok("a record stamped with an ISO string still reads", rec && rec.at === T1 && rec.version === 2);
  ok("a record with no target reads as no target", rec.raceTo === null);
  ok("...which a tournament that names one calls a reprint", Q.state(m, { raceTo: 7 }) === "stale");
  ok("a record with no snapshot cannot be proven current", (() => {
    const n = mk("W1M2", ["Alice", "Bob"]);
    n.sheetIssuedAt = Date.parse(T1);
    n.sheetIssueVersion = 1;
    return Q.state(n, { raceTo: 7 }) === "stale";
  })());
  ok("junk on the match reads as never issued", Q.issue({ sheetIssuedAt: null }) === null && Q.issue(null) === null);
}

// -------- the three cases decision 018 requires of the bracket --------
console.log("\n[the bracket and the queue]");
{
  const players = ["A", "B", "C", "D", "E", "F", "G", "H"].map((name) => ({ name }));
  const br = B.build(players, { format: "single_elim" });
  const t = tour(br.matches, { id: "prop" });

  const r1 = Q.roundOne(t);
  ok("Round 1 is ready for sheets the moment the bracket is built",
     r1.length === 4 && r1.every((e) => e.state === "ready"), JSON.stringify(r1.map((e) => e.state)));
  ok("the semi-finals are not, still waiting on both winners",
     Q.entries(t).filter((e) => e.bracket === "W" && e.round === 2).every((e) => e.state === "pending"));

  Q.mark(br.matches.W1M1, t, T1);
  Q.mark(br.matches.W1M2, t, T1);
  B.recordWinner(br, "W1M1", 0);
  ok("one semi-final slot filled is not a pairing yet", Q.state(br.matches.W2M1, t) === "pending");
  B.recordWinner(br, "W1M2", 0);
  ok("saving the second Round 1 winner makes SF1 ready for its sheet",
     Q.state(br.matches.W2M1, t) === "ready");
  Q.mark(br.matches.W2M1, t, T1);
  ok("...and printing it makes it current", Q.state(br.matches.W2M1, t) === "printed");
  const firstSnapshot = Q.issue(br.matches.W2M1).snapshot;

  // The desk corrects Round 1: the other player won, which is the engine's own edit path
  // (recordWinner clears the downstream slots and voids any sheet down there).
  B.recordWinner(br, "W1M1", 1);
  ok("editing a saved Round 1 winner turns the downstream sheet into a reprint",
     Q.state(br.matches.W2M1, t) === "stale");
  const versionBefore = br.matches.W2M1.sheetIssueVersion;
  const again = Q.mark(br.matches.W2M1, t, T2);
  ok("the reprint bumps sheetIssueVersion by exactly one",
     versionBefore === 1 && again.version === 2, `was ${versionBefore}, now ${again.version}`);
  ok("the reprint carries the corrected pairing, not the old one",
     !eq(again.snapshot, firstSnapshot) &&
     eq(again.snapshot, br.matches.W2M1.slots.map((s) => s.name)));
  ok("the corrected sheet is current again", Q.state(br.matches.W2M1, t) === "printed");

  // The console's own edit path rebuilds the bracket and replays the stored sheets, which is
  // where carry() comes in: the paper in the desk's hand survives the rebuild and shows up
  // as the reprint it needs.
  const fresh = B.build(players, { format: "single_elim" });
  const kept = Q.carry(br, fresh);
  ok("a rebuild carries the printed sheets of the matches that still exist", kept === 3, "carried " + kept);
  ok("the fresh bracket starts with none of its own", fresh.matches.W1M1.sheetIssueVersion === 1);
  B.recordWinner(fresh, "W1M1", 0);
  B.recordWinner(fresh, "W1M2", 0);
  ok("a rebuilt bracket with the old pairing reports the carried sheet as a reprint",
     Q.state(fresh.matches.W2M1, t) === "stale" &&
     eq(Q.issue(fresh.matches.W2M1).snapshot, again.snapshot));
  ok("a match that did not exist before is not invented a record",
     Q.issue(fresh.matches.W2M2) === null);
}

// -------- the queue's sections --------
console.log("\n[queue]");
{
  const bracket = {
    W1M1: mk("W1M1", ["Alice", "Bob"]),
    W1M2: mk("W1M2", ["Carol", "Dave"]),
    W1M3: mk("W1M3", [null, null]),
    W2M1: mk("W2M1", ["Alice", "Carol"], { round: 2 })
  };
  const t = tour(bracket);
  Q.mark(bracket.W1M2, t, T1);
  Q.mark(bracket.W2M1, t, T1);
  bracket.W2M1.slots[1] = { name: "Eve", seed: 4 };   // the bracket moved under the SF sheet
  const q = Q.queue(t);

  ok("ready lists the match with no sheet yet",
     eq(q.ready.map((e) => e.matchId), ["W1M1"]));
  ok("reprints lists the sheet the bracket moved under", eq(q.reprints.map((e) => e.matchId), ["W2M1"]));
  ok("printed lists the sheet that still agrees", eq(q.printed.map((e) => e.matchId), ["W1M2"]));
  ok("pending lists the match with no pairing", eq(q.pending.map((e) => e.matchId), ["W1M3"]));
  ok("Round 1's batch is what is not pending", eq(q.roundOne.map((e) => e.matchId), ["W1M1", "W1M2"]));
  ok("nothing has been superseded yet", q.voided === 0);
  ok("the queue keeps every match out of exactly one section at a time",
     q.ready.length + q.reprints.length + q.printed.length + q.pending.length === 4);

  Q.mark(bracket.W2M1, t, T2);
  ok("a reprint supersedes a paper copy, and the count says so", Q.voided(t) === 1);
  ok("the reprint is current now, so the queue is empty of reprints", Q.queue(t).reprints.length === 0);
}

// -------- recently printed: newest first, capped --------
console.log("\n[recently printed]");
{
  const bracket = {};
  for (let i = 0; i < 25; i++) {
    bracket["W1M" + (i + 1)] = mk("W1M" + (i + 1), ["P" + i, "Q" + i]);
  }
  const t = tour(bracket, { id: "recent" });
  for (let i = 0; i < 25; i++) {
    Q.mark(bracket["W1M" + (i + 1)], t, new Date(Date.UTC(2026, 9, 15, 12, 0, i)).toISOString());
  }
  const q = Q.queue(t);
  ok("the list is capped at the documented limit",
     q.printed.length === Q.RECENT_LIMIT && Q.RECENT_LIMIT === 20, "got " + q.printed.length);
  ok("newest first", q.printed[0].matchId === "W1M25" && q.printed[1].matchId === "W1M24");
  ok("...dropping the oldest", q.printed[q.printed.length - 1].matchId === "W1M6");
  ok("every issue is one version, so 25 first issues void nothing", Q.voided(t) === 0);
}

// -------- what a print covers --------
console.log("\n[selection]");
{
  const bracket = {
    W1M1: mk("W1M1", ["Alice", "Bob"]),
    W1M2: mk("W1M2", ["Carol", "Dave"]),
    W1M3: mk("W1M3", [null, null]),
    W2M1: mk("W2M1", ["Alice", "Carol"], { round: 2 })
  };
  const t = tour(bracket);
  Q.mark(bracket.W1M2, t, T1);
  ok("Round 1's batch is the whole round, minus what cannot be printed",
     eq(Q.selection(t, {}).map((e) => e.matchId), ["W1M1", "W1M2"]));
  ok("a named match is selected on its own", eq(Q.selection(t, { matchId: "W2M1" }).map((e) => e.matchId), ["W2M1"]));
  ok("a named match that is already printed is still selected, for a lost sheet",
     eq(Q.selection(t, { matchId: "W1M2" }).map((e) => e.state), ["printed"]));
  ok("a named match with no pairing is not selected at all", Q.selection(t, { matchId: "W1M3" }).length === 0);
  ok("any round can be asked for", eq(Q.selection(t, { round: 2 }).map((e) => e.matchId), ["W2M1"]));
}

// -------- the print page's URL --------
console.log("\n[uri]");
{
  ok("the queue page is print.html with the tournament",
     Q.uri({ id: "t_141_001" }) === "print.html?t=t_141_001");
  ok("one match adds m",
     Q.uri({ id: "t1" }, { matchId: "W1M1" }) === "print.html?t=t1&m=W1M1");
  ok("the Round 1 batch adds round",
     Q.uri({ id: "t1" }, { roundOne: true }) === "print.html?t=t1&round=1");
  ok("an id with a space is encoded", Q.uri({ id: "t 1" }) === "print.html?t=t%201");
  ok("no tournament is still a valid URL", Q.uri(null) === "print.html?t=");
}

// -------- the round label the printed sheet carries --------
console.log("\n[label]");
{
  ok("a winners-round match prints its round and match",
     Q.label({ id: "W1M1" }) === "R1 \u00b7 Match 1", Q.label({ id: "W1M1" }));
  ok("a losers-round match keeps the L", Q.label({ id: "L2M3" }) === "L2 \u00b7 Match 3");
  ok("a grand final prints as itself", Q.label({ id: "GF1" }) === "GF1");
  ok("an unknown id is passed through rather than guessed", Q.label({ id: "X9" }) === "X9");
}

// -------- the two pages sharing one storage key --------
console.log("\n[sharing the bracket with the print page]");
{
  const rec = { at: T2, version: 2, snapshot: ["Alice", "Bob"], raceTo: 7 };
  const mine = mk("W1M1", ["Alice", "Bob"]);
  const stored = mk("W1M1", ["Alice", "Bob"]);
  Q.mark(mine, tour({ raceTo: 7 }), T1);
  Q.restore(stored, rec);
  const taken = Q.adopt({ W1M1: mine }, { W1M1: stored });
  ok("the newer record wins when the print page has printed a sheet", taken === 1);
  ok("...and this page now reads the version the print page wrote", Q.issue(mine).version === 2);
  ok("the older record loses", Q.adopt({ W1M1: stored }, { W1M1: mine }) === 0);
  ok("a match the stored copy does not have is left alone",
     Q.adopt({ W1M3: mk("W1M3", ["x", "y"]) }, { W1M1: stored }) === 0);
  ok("a stored record for a match this page has never seen is taken",
     (() => { const blank = mk("W1M1", ["Alice", "Bob"]); return Q.adopt({ W1M1: blank }, { W1M1: stored }) === 1; })());
  ok("restore and issue are inverses", eq(Q.issue(stored), rec));
}

console.log("\n" + (fail ? fail + " FAILED" : "all " + pass + " passed"));
process.exit(fail ? 1 : 0);
