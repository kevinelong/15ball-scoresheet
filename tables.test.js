// tables.test.js — unit tests for the table roster parser & builder.
// Run:  node tables.test.js
const T = require("./tables.js");

let pass = 0, fail = 0;
function ok(label, cond, extra) {
  if (cond) { console.log(" ok  " + label); pass++; }
  else      { console.log("FAIL " + label + (extra ? "  " + extra : "")); fail++; }
}
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

// -------- parseNaming --------
console.log("\n[parseNaming]");
ok("blank → Table 1..N",
   eq(T.parseNaming(6, ""), ["Table 1","Table 2","Table 3","Table 4","Table 5","Table 6"]));
ok("undefined naming → default",
   eq(T.parseNaming(3), ["Table 1","Table 2","Table 3"]));
ok("whitespace only → default",
   eq(T.parseNaming(3, "   "), ["Table 1","Table 2","Table 3"]));
ok("offset range 7-12 with count 6",
   eq(T.parseNaming(6, "7-12"), ["Table 7","Table 8","Table 9","Table 10","Table 11","Table 12"]));
ok("offset range with whitespace",
   eq(T.parseNaming(3, "  7 - 9  "), ["Table 7","Table 8","Table 9"]));
ok("range: count overrides the end (5 tables starting at 10)",
   eq(T.parseNaming(5, "10-99"), ["Table 10","Table 11","Table 12","Table 13","Table 14"]));
ok("comma list: three named tables",
   eq(T.parseNaming(3, "Stream, A, B"), ["Stream","Table A","Table B"]));
ok("comma list: pads with defaults if shorter than count",
   eq(T.parseNaming(4, "Stream, A"), ["Stream","Table A","Table 3","Table 4"]));
ok("comma list: truncates if longer than count",
   eq(T.parseNaming(2, "A, B, C, D"), ["Table A","Table B"]));
ok("comma list: numeric tokens get Table prefix",
   eq(T.parseNaming(3, "1, 2, 3"), ["Table 1","Table 2","Table 3"]));
ok("single word (not a range) becomes first name + pad",
   eq(T.parseNaming(3, "Stream"), ["Stream","Table 2","Table 3"]));
ok("single letter becomes Table X + pad",
   eq(T.parseNaming(2, "A"), ["Table A","Table 2"]));
ok("names containing hyphens are not treated as ranges (comma-split path)",
   eq(T.parseNaming(2, "T-Rex Room, Back Room"), ["T-Rex Room","Back Room"]));
ok("count 0 → coerces to 1",
   eq(T.parseNaming(0, ""), ["Table 1"]));
ok("negative count → coerces to 1",
   eq(T.parseNaming(-3, ""), ["Table 1"]));
ok("fractional count → floor to at least 1",
   eq(T.parseNaming(2.9, ""), ["Table 1","Table 2"]));
ok("garbage naming falls back to first-token+pad",
   eq(T.parseNaming(2, "!!!"), ["!!!","Table 2"]));

// -------- buildTables --------
console.log("\n[buildTables]");
const built = T.buildTables(3, "");
ok("buildTables returns 3 records", built.length === 3);
ok("every record has id/name/state", built.every(r => r.id && r.name && r.state === "empty"));
ok("ids are unique", new Set(built.map(r => r.id)).size === 3);
ok("names follow parseNaming",
   eq(built.map(r => r.name), ["Table 1","Table 2","Table 3"]));

const custom = T.buildTables(3, "Stream, A, B");
ok("buildTables respects custom naming",
   eq(custom.map(r => r.name), ["Stream","Table A","Table B"]));

// -------- namingPlaceholder --------
console.log("\n[namingPlaceholder]");
ok("placeholder for 6 is '1-6'", T.namingPlaceholder(6) === "1-6");
ok("placeholder for 1 is '1-1'", T.namingPlaceholder(1) === "1-1");
ok("placeholder for 0 coerces to '1-1'", T.namingPlaceholder(0) === "1-1");

// -------- summary --------
console.log(`\n${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);
console.log("All table tests passed.");
