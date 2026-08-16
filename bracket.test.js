// Simple sanity checks for bracket.js. Run with:  node bracket.test.js
const g = globalThis;
require("./bracket.js");
const B = g.BracketEngine;

function assert(cond, msg) {
  if (!cond) { console.error("FAIL:", msg); process.exit(1); }
  else console.log(" ok ", msg);
}

// --- N=2 ---
{
  const s = B.build([{ name: "A" }, { name: "B" }], { format: "double" });
  assert(s.wRounds === 1 && s.lRounds === 0, "N=2 has 1 W round, 0 L rounds");
  assert(s.matches["W1M1"] && s.matches["GF1"] && s.matches["GF2"], "N=2 double has W1M1, GF1, GF2");
  B.recordWinner(s, "W1M1", 0);
  assert(s.matches["GF1"].slots[0].name === "A", "W1 winner feeds GF1 slot 0");
}

// --- N=3 (has one bye) ---
{
  const s = B.build([{ name: "A" }, { name: "B" }, { name: "C" }], { format: "single" });
  assert(s.bracketSize === 4 && s.byes === 1, "N=3 -> bracketSize 4, 1 bye");
  // The bye should auto-resolve.
  const w1 = Object.values(s.matches).filter(m => m.bracket === "W" && m.round === 1);
  const auto = w1.filter(m => m.resolvedAutoBye);
  assert(auto.length === 1, "one W1 match auto-resolves for a bye");
}

// --- N=6 double: full run to see propagation. Force upset in W1 to test L path. ---
{
  const players = [1, 2, 3, 4, 5, 6].map(n => ({ name: "P" + n }));
  const s = B.build(players, { format: "double" });
  assert(s.bracketSize === 8 && s.byes === 2, "N=6 -> size 8, 2 byes");
  assert(s.wRounds === 3 && s.lRounds === 4, "N=6 wRounds=3 lRounds=4");
  // Verify wFinal and lFinal both feed GF1
  const gf1 = s.matches["GF1"];
  assert(s.matches[s.wFinalId].feedsWinnerTo.matchId === "GF1", "W-final feeds GF1");
  assert(s.matches[s.lFinalId].feedsWinnerTo.matchId === "GF1", "L-final feeds GF1");
  assert(gf1.slots[0] === null && gf1.slots[1] === null, "GF1 slots empty before play");
}

// --- N=6 single format: no GF2 exists ---
{
  const players = [1, 2, 3, 4, 5, 6].map(n => ({ name: "P" + n }));
  const s = B.build(players, { format: "single" });
  assert(!s.matches["GF2"], "single format has no GF2");
}

// --- N=6 double: run through, prove GF2 gets seeded when L-champ wins GF1 ---
{
  const players = [1, 2, 3, 4, 5, 6, 7, 8].map(n => ({ name: "P" + n }));
  const s = B.build(players, { format: "double" });
  const wMatches = Object.values(s.matches).filter(m => m.bracket === "W").sort((a, b) => a.round - b.round || a.id.localeCompare(b.id));
  wMatches.forEach(m => { if (m.slots[0] && m.slots[1] && !m.winner) B.recordWinner(s, m.id, 0); });
  const lMatches = Object.values(s.matches).filter(m => m.bracket === "L").sort((a, b) => a.round - b.round || a.id.localeCompare(b.id));
  lMatches.forEach(m => { if (m.slots[0] && m.slots[1] && !m.winner) B.recordWinner(s, m.id, 0); });
  // Now play GF1 with L-champ winning
  B.recordWinner(s, "GF1", 1);
  assert(s.matches["GF2"].slots[0] && s.matches["GF2"].slots[1], "GF2 gets seeded on L-champ upset");
  // Reset: W-champ wins GF1 instead
  B.recordWinner(s, "GF1", 0);
  assert(s.champion && s.champion.name === s.matches["GF1"].slots[0].name, "W-champ winning GF1 sets champion");
}

// --- Late-add: W-side entry into an auto-bye slot ---
{
  const players = [1, 2, 3].map((n) => ({ name: "P" + n }));
  const s = B.build(players, { format: "double" });
  // N=3 has 1 auto-bye in W1. Add late entry on W side.
  const res = B.addLateEntry(s, { name: "Late1" }, "W");
  assert(res.placed, "late-add W into an auto-bye slot succeeds");
  assert(s.participants.length === 4, "participants count is 4 after late-add");
  const target = s.matches[res.matchId];
  assert(target.slots[res.slot].name === "Late1", "late entry sits in the reported slot");
  assert(target.winner === null, "target match is re-opened for play");
}

// --- Late-add: L-side entry into an open L-bracket slot ---
{
  const players = [1, 2, 3, 4, 5, 6].map((n) => ({ name: "P" + n }));
  const s = B.build(players, { format: "double" });
  // Play W1 fully so L1 slots get populated. But L bracket typically fills as W losers arrive.
  // We'll just try to add before any play — there should be open L slots (empty).
  const res = B.addLateEntry(s, { name: "LateL" }, "L");
  assert(res.placed, "late-add L into an open L slot succeeds");
  assert(s.participants[s.participants.length - 1].name === "LateL", "L late entry is appended to participants");
  const target = s.matches[res.matchId];
  assert(target.bracket === "L", "late-add L placed the entry in an L-bracket match");
}

// --- Late-add: preserves decided matches ---
{
  const players = [1, 2, 3, 4].map((n) => ({ name: "P" + n }));
  const s = B.build(players, { format: "double" });
  B.recordWinner(s, "W1M1", 0, { score: "25-10" });
  const w1m1Before = { winner: s.matches["W1M1"].winner, score: s.matches["W1M1"].score, slot0: s.matches["W1M1"].slots[0].name, slot1: s.matches["W1M1"].slots[1].name };
  B.addLateEntry(s, { name: "LateP" }, "W");
  const after = s.matches["W1M1"];
  assert(after.winner === w1m1Before.winner && after.score === w1m1Before.score, "decided W1M1 remains decided after late-add");
  assert(after.slots[0].name === w1m1Before.slot0 && after.slots[1].name === w1m1Before.slot1, "decided W1M1 slots unchanged");
}

// --- 8-Ball match: recordWinner accepts arbitrary score summary ---
{
  const players = [1, 2].map((n) => ({ name: "P" + n }));
  const s = B.build(players, { format: "double" });
  // Simulate a games-won result posted from the counter modal (7-3)
  B.recordWinner(s, "W1M1", 1, { score: "3-7" });
  assert(s.matches["W1M1"].winner === 1, "counter-modal winner recorded (slot 1)");
  assert(s.matches["W1M1"].score === "3-7", "counter-modal score string persisted verbatim");
  // Winner advances to GF1
  assert(s.matches["GF1"].slots[0]?.name === "P2", "W1 winner (P2) feeds GF1 slot 0 in 2-player double");
}

console.log("\nAll bracket tests passed.");
