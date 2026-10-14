// sheet-payload.test.js — unit tests for the score-sheet record.
// Run:  node sheet-payload.test.js
//
// The record is the one thing the result endpoint's `score` field carries, and the one
// thing the stack view reads back. These tests pin its shape, the two instruments it
// names, and that a reader never dies on a payload it did not write (the Android app's
// older payload is the live example).
const P = require("./sheet-payload.js");
const S = require("./sheets.js");

let pass = 0, fail = 0;
function ok(label, cond, extra) {
  if (cond) { console.log(" ok  " + label); pass++; }
  else { console.log("FAIL " + label + (extra ? "  " + extra : "")); fail++; }
}
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function throws(fn) { try { fn(); return false; } catch (e) { return true; } }

// A filled-in 15-Ball Rotation sheet, in the console's own collected shape.
const rackSheet = {
  _kind: "rack",
  pAname: "Ada", pBname: "Bo",
  winner: "A",
  finalA: 25, finalB: 13,
  racks: [
    { rack: 1, A: { balls: [1, 2, 3], fouls: 0 }, B: { balls: [4], fouls: 1 } },
    { rack: 2, A: { balls: [5, 6], fouls: 0 }, B: { balls: [], fouls: 0 } }
  ]
};
// A filled-in 9-Ball tally, the counter shape the console stores.
const tallySheet = { _kind: "race", pAname: "Ada", pBname: "Bo", winner: "B", finalA: 4, finalB: 7 };

// -------- build: the record the console submits --------
console.log("\n[build]");
const rackRec = P.build({ game: "15ball_rotation", sheet: rackSheet, raceTo: 25, appVersion: "15ball-live/1" });
ok("the record's version is 2 (the rename that split it from the match payload's raceFrom)",
   rackRec.payloadVersion === P.VERSION && P.VERSION === 2);
ok("the discipline is the canonical id", rackRec.discipline === "15ball_rotation");
ok("kind is the sheet body, sheetKind the instrument",
   rackRec.kind === P.RACK && rackRec.sheetKind === P.RACK_INSTRUMENT);
ok("the measurement and the goals travel with the record",
   rackRec.measure === "balls" && eq(rackRec.goals, [25, 50]));
ok("the race is a snapshot, with where the scorer got it",
   rackRec.raceTo === 25 && rackRec.raceOrigin === P.FROM_BRACKET);
ok("the record's key is its own — never the match payload's raceFrom",
   rackRec.raceFrom === undefined &&
   rackRec.raceOrigin === P.FROM_BRACKET);
ok("per-rack detail carries both sides, made and net", rackRec.racks.length === 2 &&
   eq(rackRec.racks[0].a, { balls: [1, 2, 3], fouls: 0, made: 3, net: 3 }) &&
   eq(rackRec.racks[0].b, { balls: [4], fouls: 1, made: 1, net: 0 }));
ok("rack numbers are filled in even when the sheet left them off",
   rackRec.racks[0].rack === 1 && rackRec.racks[1].rack === 2);
ok("racksPlayed counts the racks with anything on them", rackRec.racksPlayed === 2);
ok("finals and winner come off the sheet", eq(rackRec.finals, { a: 25, b: 13 }) && rackRec.winner === "A");
ok("names come off the sheet", eq(rackRec.names, { a: "Ada", b: "Bo" }));
ok("the app and its version name the producer",
   rackRec.app === P.APP && rackRec.appVersion === "15ball-live/1");

const tallyRec = P.build({ game: "9ball", sheet: tallySheet, raceTo: 7 });
ok("a tally record has no racks at all", tallyRec.racks === undefined && tallyRec.ballsPerRack === undefined);
ok("a tally's instrument is a tally, its body a race",
   tallyRec.sheetKind === P.TALLY && tallyRec.kind === P.RACE);
ok("a tally carries no goal presets — its goal is the race",
   eq(tallyRec.goals, []) && tallyRec.raceTo === 7);
ok("its finals are the games won", eq(tallyRec.finals, { a: 4, b: 7 }) && tallyRec.winner === "B");
ok("an offline tournament says where its race came from",
   P.build({ game: "9ball", sheet: tallySheet, raceTo: 7, raceOrigin: P.FROM_LOCAL }).raceOrigin === P.FROM_LOCAL);
ok("the app's own spelling of a game canonicalises", P.build({ game: "fifteenBall", sheet: rackSheet }).discipline === "15ball_rotation");
ok("an unset race is null, not a made-up number", P.build({ game: "9ball", sheet: tallySheet }).raceTo === null);
ok("names passed in beat the sheet's own", P.build({ game: "9ball", sheet: tallySheet, names: { a: "Ada L.", b: "Bo S." } }).names.a === "Ada L.");
ok("an empty winner box stays null, never a guess",
   P.build({ game: "9ball", sheet: { _kind: "race", finalA: 0, finalB: 0 } }).winner === null);
ok("build does not mutate the sheet it was handed",
   eq(rackSheet.racks[0].A.balls, [1, 2, 3]) && rackSheet.racks[0].A.made === undefined);

// -------- read: our own record round-trips --------
console.log("\n[read: the console's record]");
const back = P.read(JSON.parse(JSON.stringify(rackRec)));
ok("a round-tripped record keeps its shape",
   back.payloadVersion === P.VERSION && back.rackSheet !== true &&
   back.discipline === "15ball_rotation" && back.sheetKind === P.RACK_INSTRUMENT);
ok("its racks survive the trip", back.racks.length === 2 && back.racks[1].a.made === 2);
ok("its finals survive the trip", eq(back.finals, { a: 25, b: 13 }) && back.winner === "A");
ok("a record that names its own origin is believed", back.raceOrigin === P.FROM_BRACKET);
ok("and its reader reports the origin under the record's own key",
   back.raceFrom === undefined && back.raceOrigin === P.FROM_BRACKET);

// -------- read: a sheet saved by the version-1 key --------
console.log("\n[read: a legacy-keyed sheet]");
// Before the rename, the record's key was `raceFrom` (payloadVersion 1) — the same word
// the *match payload* uses for the layer that supplied the number. A sheet already saved
// on a device carries it, so the reader must map it rather than fall back to "unknown".
const legacyBracket = { payloadVersion: 1, discipline: "9ball", measure: "wins", raceTo: 11,
  raceFrom: "bracket", finals: { a: 11, b: 6 }, winner: "A", app: "score-console" };
const legacyLocal = { payloadVersion: 1, discipline: "9ball", raceTo: 7, raceFrom: "local", finals: { a: 7, b: 4 } };
ok("a version-1 record's old key reads as the origin, not as unknown",
   P.read(legacyBracket).raceOrigin === P.FROM_BRACKET &&
   P.read(legacyBracket, { raceTo: 11 }).raceOrigin === P.FROM_BRACKET);
ok("its local origin survives too", P.read(legacyLocal).raceOrigin === P.FROM_LOCAL);
ok("its own version reads back as 1", P.read(legacyBracket).payloadVersion === 1);
ok("the rest of a legacy sheet reads as it did",
   P.read(legacyBracket).raceTo === 11 && P.read(legacyBracket).winner === "A" &&
   eq(P.read(legacyBracket).finals, { a: 11, b: 6 }));
ok("a legacy value that is not one of the four is still inferred, never echoed",
   P.read({ payloadVersion: 1, discipline: "9ball", raceTo: 11, raceFrom: "division" },
          { raceTo: 11 }).raceOrigin === P.FROM_BRACKET);
ok("a record carrying both keys is read by the new one",
   P.read({ discipline: "9ball", raceTo: 11, raceFrom: "local", raceOrigin: "bracket" }).raceOrigin === P.FROM_BRACKET);
ok("a legacy record with no race at all reads as unknown, not as an invented origin",
   P.read({ payloadVersion: 1, discipline: "9ball", finals: { a: 3, b: 1 } }).raceOrigin === P.FROM_UNKNOWN);

// -------- read: the Android app's payload --------
console.log("\n[read: the phone's payload]");
// What MainActivity posts today (score "a-b", home/away, discipline, app, goals, raceTo).
const phone = {
  score: "4-7", home: 4, away: 7, discipline: "9ball",
  app: "score-android", appVersion: "1.4.0", goals: [7, 7], raceTo: 9,
  names: { a: "Ada", b: "Bo" }
};
const phoneView = P.read(phone, { raceTo: 7 });
ok("the phone's number is a tally, and the record says so", phoneView.sheetKind === P.TALLY);
ok("its number reads off home/away", eq(phoneView.finals, { a: 4, b: 7 }));
ok("the instrument is still named for a phone record", P.instrument(phoneView) === "tally (score-android)");
ok("its discipline still resolves to a sheet body and a measure",
   phoneView.kind === P.RACE && phoneView.measure === S.WINS);
ok("a hand-typed race that disagrees with the bracket is an explicit override",
   phoneView.raceOrigin === P.FROM_OVERRIDE);
ok("a hand-typed race that agrees with the bracket is not an override",
   P.read(phone, { raceTo: 9 }).raceOrigin === P.FROM_BRACKET);
ok("with no bracket race to compare, a phone record is still an override",
   P.read(phone).raceOrigin === P.FROM_OVERRIDE);
ok("a payload with no version is version 0, not a lie",
   phoneView.payloadVersion === 0);
ok("a record that names its own origin keeps it, even if the bracket has changed since",
   P.read(rackRec, { raceTo: 50 }).raceOrigin === P.FROM_BRACKET);
ok("a record with no named origin that disagrees with the bracket reads as an override",
   P.read({ payloadVersion: 1, discipline: "15ball_rotation", raceTo: 25, finals: { a: 25, b: 13 } },
          { raceTo: 50 }).raceOrigin === P.FROM_OVERRIDE);
ok("and one that agrees reads as the bracket's",
   P.read(rackRec, { raceTo: 25 }).raceOrigin === P.FROM_BRACKET);
ok("a marker one day added by the phone is believed",
   P.read({ app: "score-android", discipline: "9ball", sheetKind: "rack" }).sheetKind === "rack");

// -------- read: junk --------
console.log("\n[read: junk]");
ok("null, a string and an empty object all read without throwing",
   !throws(() => P.read(null)) && !throws(() => P.read("1234")) && !throws(() => P.read({})));
ok("an empty payload reads as a zeroed view, not as an error",
   eq(P.read({}).finals, { a: 0, b: 0 }) && P.read({}).winner === null && P.read({}).racks.length === 0);
ok("an unknown discipline falls back to rotation's sheet",
   P.read({ discipline: "snooker" }).kind === P.RACK);

// -------- the line the stack prints --------
console.log("\n[summary]");
ok("a rack result reads as its finals and its winner", P.summary(back) === "25\u201313 \u00b7 winner A");
ok("a record with no winner says so", P.summary(P.read({ finalA: 3, finalB: 1 })).indexOf("no winner") !== -1);
ok("the instrument reads in words", P.instrument(back) === "rack sheet" && P.instrument(P.read(tallyRec)) === "tally");

console.log("\n" + (fail ? fail + " FAILED" : "all " + pass + " passed"));
process.exit(fail ? 1 : 0);
