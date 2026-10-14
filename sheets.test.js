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

// -------- race sheets --------
console.log("\n[race sheets]");
ok("9-ball is a race", S.spec("9ball").kind === S.RACE && !S.isRack("9ball"));
ok("every games-won discipline is a race",
   ["8ball", "9ball", "10ball", "one_pocket", "bank_pool"].every((g) => !S.isRack(g)));
ok("exactly two disciplines mark balls",
   S.ids.filter(S.isRack).length === 2);

console.log("\n" + (fail ? fail + " FAILED" : "all " + pass + " passed"));
process.exit(fail ? 1 : 0);
