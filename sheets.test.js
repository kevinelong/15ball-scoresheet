// sheets.test.js — unit tests for the per-discipline sheet definitions.
// Run:  node sheets.test.js
const S = require("./sheets.js");

let pass = 0, fail = 0;
function ok(label, cond, extra) {
  if (cond) { console.log(" ok  " + label); pass++; }
  else { console.log("FAIL " + label + (extra ? "  " + extra : "")); fail++; }
}
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

// -------- id resolution --------
console.log("\n[id]");
ok("canonical id passes through", S.id("straight_14_1") === "straight_14_1");
ok("the app's 14_1 spelling resolves", S.id("14_1") === "straight_14_1");
ok("fifteenBall resolves to rotation", S.id("fifteenBall") === "15ball_rotation");
ok("kball (the id it renamed in place) resolves", S.id("kball") === "15ball_rotation");
ok("onepocket and banks resolve",
   S.id("onepocket") === "one_pocket" && S.id("banks") === "bank_pool");
ok("an unknown game falls back to rotation", S.id("snooker") === "15ball_rotation");
ok("a missing game falls back to rotation", S.id() === "15ball_rotation");
ok("every defined game resolves to itself", S.ids.every((g) => S.id(g) === g));

// -------- the two rack sheets --------
console.log("\n[rack sheets]");
ok("rotation marks 15 balls over 4 racks",
   S.spec("fifteenBall").ballsPerRack === 15 && S.spec("fifteenBall").racks === 4);
ok("14.1 marks 14 balls over 8 racks",
   S.spec("14_1").ballsPerRack === 14 && S.spec("14_1").racks === 8);
ok("14.1's last column is the running total",
   S.spec("14_1").columns[3] === "RUNNING TOTAL");
ok("rotation keeps its game subtotal",
   S.spec("fifteenBall").columns[3] === "GAME SUBTOTAL");
ok("14.1's total is a match total, rotation's a game total",
   S.spec("14_1").finalLabel === "FINAL MATCH TOTAL" &&
   S.spec("fifteenBall").finalLabel === "FINAL GAME TOTAL");
ok("rotation draws pool-ball faces, 14.1 does not",
   S.spec("fifteenBall").ballFaces === true && S.spec("14_1").ballFaces === false);
ok("both rack sheets name fouls as their second column",
   S.ids.filter(S.isRack).every((g) => S.spec(g).columns[1] === "FOULS"));

// -------- goals --------
console.log("\n[goals]");
ok("rotation offers 25 and 50", eq(S.goals("fifteenBall"), [25, 50]));
ok("14.1 offers 75 and 100", eq(S.goals("14_1"), [75, 100]));
ok("goals come back as a copy", (() => {
  const a = S.goals("14_1"); a.push(999); return S.goals("14_1").length === 2;
})());

// -------- race sheets ----------
console.log("\n[race sheets]");
ok("9-ball is a race", S.kind("9ball") === S.RACE && !S.isRack("9ball"));
ok("every games-won discipline is a race",
   ["8ball", "9ball", "10ball", "one_pocket", "bank_pool"].every((g) => !S.isRack(g)));
ok("exactly two disciplines mark balls",
   S.ids.filter(S.isRack).length === 2);

// -------- how a discipline is measured, and the controls that follow --------
console.log("\n[measure + controls]");
ok("the rack sheets are measured in balls",
   S.measure("fifteenBall") === S.BALLS && S.measure("straight_14_1") === S.BALLS);
ok("the games-won disciplines are measured in wins",
   ["8ball", "9ball", "10ball", "one_pocket", "bank_pool"].every((g) => S.measure(g) === S.WINS));
ok("an unknown game measures as rotation's balls", S.measure("snooker") === S.BALLS);
ok("measure and the rendered body agree for every discipline",
   S.ids.every((g) => S.isRack(g) === (S.measure(g) === S.BALLS)));
ok("every discipline declares its jump controls, and none offers one",
   S.ids.every((g) => Array.isArray(S.spec(g).quickAdd) && S.spec(g).quickAdd.length === 0));
ok("the wins disciplines - the ones with a tally - offer none either",
   S.ids.filter((g) => S.measure(g) === S.WINS).every((g) => S.spec(g).quickAdd.length === 0));

console.log("\n" + (fail ? fail + " FAILED" : "all " + pass + " passed"));
process.exit(fail ? 1 : 0);
