/* Double-elimination bracket engine.
   Pure functions: given a seeded participant list + format, produce a match
   graph. Match results flow deterministically through the graph.

   Vocabulary:
     - W1, W2, W3 ...   Winner-bracket rounds
     - L1, L2, L3 ...   Loser-bracket rounds
     - GF1              Grand Final match 1 (W-champ vs L-champ)
     - GF2              Grand Final "reset" match (must-beat-twice format only,
                        only played if L-champ won GF1)
   Match ID scheme: "W2M1" (bracket W, round 2, match 1). Grand finals are
   "GF1" and "GF2".

   Format:
     "single"  \u2014 GF1 is decisive.
     "double"  \u2014 If L-champ wins GF1, GF2 is played (must beat twice).

   API:
     BracketEngine.build(participants, options)  \u2192 tournament state
     BracketEngine.recordWinner(state, matchId, winnerSlotIdx) \u2192 mutated state
     BracketEngine.matchesInOrder(state)  \u2192 ordered array for rendering
*/

(function (global) {
  "use strict";

  const BYE = { id: "__bye__", name: "\u2014 BYE \u2014", isBye: true };

  function nextPow2(n) {
    let p = 1;
    while (p < n) p *= 2;
    return p;
  }

  // Standard "vs opposite" seed ordering for round 1 of a bracket of size N.
  // For N=8: [1, 8, 5, 4, 3, 6, 7, 2] laid out pair-by-pair means matches are
  // (1 vs 8), (4 vs 5), (3 vs 6), (2 vs 7). Balanced so #1 meets #2 in the
  // final assuming form holds.
  function seedOrder(size) {
    let order = [1];
    while (order.length < size) {
      const nextRound = order.length * 2 + 1;
      const out = [];
      for (const seed of order) {
        out.push(seed);
        out.push(nextRound - seed);
      }
      order = out;
    }
    return order;
  }

  function build(participants, options) {
    options = options || {};
    const format = options.format === "double" ? "double" : "single";
    // Copy so we don't mutate the caller's array.
    const players = participants.slice();
    if (players.length < 2) {
      return {
        format,
        participants: players.map((p, i) => ({ ...p, seed: i + 1 })),
        matches: {},
        order: [],
        wRounds: 0,
        lRounds: 0
      };
    }
    // Assign seeds in the order provided. If a "seed" property is missing,
    // it's just their position + 1. Callers can seed by Fargo before passing.
    const seeded = players.map((p, i) => ({ ...p, seed: i + 1 }));
    const bracketSize = nextPow2(seeded.length);
    const byes = bracketSize - seeded.length;
    const order = seedOrder(bracketSize);

    // Round-1 slots: array of length `bracketSize`, where each slot is either
    // a participant or a BYE. Seed `s` (1-based) goes to position order.indexOf(s).
    const slots = new Array(bracketSize);
    for (let i = 0; i < bracketSize; i++) {
      const seedNum = order[i];
      slots[i] = seedNum <= seeded.length ? seeded[seedNum - 1] : { ...BYE };
    }

    const matches = {};
    const roundOrder = []; // array of match IDs in render order

    // Winner bracket
    const wRounds = Math.log2(bracketSize);
    // Build W-bracket matches level by level. Winners feed forward.
    let prevRoundMatchIds = [];
    for (let round = 1; round <= wRounds; round++) {
      const roundIds = [];
      const matchesInRound = bracketSize / Math.pow(2, round);
      for (let m = 1; m <= matchesInRound; m++) {
        const id = "W" + round + "M" + m;
        const match = {
          id,
          round,
          bracket: "W",
          slots: [null, null],
          winner: null,     // slot index 0 or 1
          score: null,      // free-form score summary, set by score sheet
          feedsWinnerTo: null,
          feedsLoserTo: null,
          resolvedAutoBye: false
        };
        if (round === 1) {
          match.slots[0] = slots[(m - 1) * 2];
          match.slots[1] = slots[(m - 1) * 2 + 1];
        } else {
          const parentA = prevRoundMatchIds[(m - 1) * 2];
          const parentB = prevRoundMatchIds[(m - 1) * 2 + 1];
          matches[parentA].feedsWinnerTo = { matchId: id, slot: 0 };
          matches[parentB].feedsWinnerTo = { matchId: id, slot: 1 };
        }
        matches[id] = match;
        roundIds.push(id);
      }
      prevRoundMatchIds = roundIds;
    }
    // The winner of the last W-bracket match will feed into GF1.
    const wFinalId = prevRoundMatchIds[0];

    // Loser bracket
    // Standard double-elim L-bracket has 2*(wRounds-1) rounds.
    // Round pattern for size N=8 (wRounds=3, lRounds=4):
    //   L1: 2 matches, both fed by W1 losers.
    //   L2: 2 matches, each fed by 1 L1 winner + 1 W2 loser.
    //   L3: 1 match, fed by 2 L2 winners.
    //   L4: 1 match, fed by L3 winner + W3 loser.  (= L-Final)
    // Odd L rounds (1, 3, 5, ...) consolidate: two L winners meet.
    // Even L rounds (2, 4, 6, ...) drop-in: an L winner meets a fresh W-loser.
    // Loser drop pairing across-side (upper half W losers meet lower half in L)
    // to prevent a rematch until the final.
    const lRounds = wRounds > 1 ? 2 * (wRounds - 1) : 0;
    let lPrev = [];
    for (let lr = 1; lr <= lRounds; lr++) {
      const roundIds = [];
      // Number of matches this L round hosts.
      let n;
      if (lr === 1) {
        n = bracketSize / 4;
      } else if (lr % 2 === 0) {
        // Drop-in round: same count as previous consolidate round.
        n = lPrev.length;
      } else {
        // Consolidate round: half the count of previous drop-in round.
        n = lPrev.length / 2;
      }
      for (let m = 1; m <= n; m++) {
        const id = "L" + lr + "M" + m;
        matches[id] = {
          id,
          round: lr,
          bracket: "L",
          slots: [null, null],
          winner: null,
          score: null,
          feedsWinnerTo: null,
          feedsLoserTo: null,
          resolvedAutoBye: false
        };
        roundIds.push(id);
      }

      // Wire feeders into this L round's matches.
      if (lr === 1) {
        // W1 losers feed L1. Pair losers cross-side.
        const wr1 = Object.values(matches).filter((mm) => mm.bracket === "W" && mm.round === 1);
        // Cross pairing: pair W1M1 loser with W1M(N/2+1) loser, etc.
        // Simple stable pattern that matches most bracket software.
        const half = wr1.length / 2;
        for (let m = 1; m <= n; m++) {
          const a = wr1[m - 1];
          const b = wr1[wr1.length - m];
          if (a) a.feedsLoserTo = { matchId: "L1M" + m, slot: 0 };
          if (b) b.feedsLoserTo = { matchId: "L1M" + m, slot: 1 };
        }
      } else if (lr % 2 === 0) {
        // Drop-in round: L(lr-1) winners take slot 0, W(lr/2 + 1) losers take slot 1.
        const wRoundForDrop = lr / 2 + 1;
        const wLosers = Object.values(matches).filter((mm) => mm.bracket === "W" && mm.round === wRoundForDrop);
        for (let m = 1; m <= n; m++) {
          const lPrevMatch = matches[lPrev[m - 1]];
          if (lPrevMatch) lPrevMatch.feedsWinnerTo = { matchId: "L" + lr + "M" + m, slot: 0 };
          const wLoser = wLosers[wLosers.length - m];
          if (wLoser) wLoser.feedsLoserTo = { matchId: "L" + lr + "M" + m, slot: 1 };
        }
      } else {
        // Consolidate round: winners of previous L round pair up.
        for (let m = 1; m <= n; m++) {
          const parentA = matches[lPrev[(m - 1) * 2]];
          const parentB = matches[lPrev[(m - 1) * 2 + 1]];
          if (parentA) parentA.feedsWinnerTo = { matchId: "L" + lr + "M" + m, slot: 0 };
          if (parentB) parentB.feedsWinnerTo = { matchId: "L" + lr + "M" + m, slot: 1 };
        }
      }
      lPrev = roundIds;
    }
    const lFinalId = lPrev[0] || null;

    // Grand Finals
    matches["GF1"] = {
      id: "GF1", round: wRounds + 1, bracket: "GF", slots: [null, null],
      winner: null, score: null,
      feedsWinnerTo: null, feedsLoserTo: null, resolvedAutoBye: false
    };
    if (wFinalId) matches[wFinalId].feedsWinnerTo = { matchId: "GF1", slot: 0 };
    if (lFinalId) matches[lFinalId].feedsWinnerTo = { matchId: "GF1", slot: 1 };
    if (format === "double") {
      matches["GF2"] = {
        id: "GF2", round: wRounds + 2, bracket: "GF", slots: [null, null],
        winner: null, score: null,
        feedsWinnerTo: null, feedsLoserTo: null, resolvedAutoBye: false,
        conditional: true   // Only played if L-champ wins GF1.
      };
    }

    const state = {
      format,
      participants: seeded,
      bracketSize,
      byes,
      wRounds,
      lRounds,
      matches,
      wFinalId,
      lFinalId,
      champion: null
    };

    // Auto-advance any BYE matches so real players face real opponents.
    autoResolveByes(state);
    return state;
  }

  function autoResolveByes(state) {
    // Walk W1 matches; if one slot is BYE, auto-advance the other.
    Object.values(state.matches).forEach((m) => {
      if (m.bracket !== "W" || m.round !== 1) return;
      const [a, b] = m.slots;
      if (a && b && (a.isBye || b.isBye) && !m.winner) {
        const winnerSlot = a.isBye ? 1 : 0;
        m.winner = winnerSlot;
        m.resolvedAutoBye = true;
        m.score = "BYE";
        propagate(state, m, winnerSlot);
      }
    });
    // Some L-bracket matches may end up with a BYE-loser as a slot;
    // resolve those too, up to a few passes.
    for (let pass = 0; pass < 4; pass++) {
      let changed = false;
      Object.values(state.matches).forEach((m) => {
        if (m.bracket !== "L" || m.winner !== null) return;
        const [a, b] = m.slots;
        if (a && b && (a.isBye || b.isBye)) {
          const winnerSlot = a.isBye ? 1 : 0;
          m.winner = winnerSlot;
          m.resolvedAutoBye = true;
          m.score = "BYE";
          propagate(state, m, winnerSlot);
          changed = true;
        }
      });
      if (!changed) break;
    }
  }

  function propagate(state, match, winnerSlotIdx) {
    const winner = match.slots[winnerSlotIdx];
    const loser = match.slots[1 - winnerSlotIdx];
    if (match.feedsWinnerTo && winner) {
      const target = state.matches[match.feedsWinnerTo.matchId];
      if (target) target.slots[match.feedsWinnerTo.slot] = winner;
    }
    if (match.feedsLoserTo && loser && !loser.isBye) {
      const target = state.matches[match.feedsLoserTo.matchId];
      if (target) target.slots[match.feedsLoserTo.slot] = loser;
    }
    // GF handling
    if (match.id === "GF1") {
      const wChampWasSlot0 = true; // by construction
      if (state.format === "double" && winnerSlotIdx === 1) {
        // L-champ won GF1: GF2 is required, seed it with same two players.
        const gf2 = state.matches["GF2"];
        if (gf2) {
          gf2.slots[0] = match.slots[0];
          gf2.slots[1] = match.slots[1];
        }
      } else {
        // W-champ won GF1 (or single-final format): tournament ends.
        state.champion = winner;
        // Skip GF2
        if (state.matches["GF2"]) state.matches["GF2"].slots = [null, null];
      }
    } else if (match.id === "GF2") {
      state.champion = winner;
    }
  }

  function recordWinner(state, matchId, winnerSlotIdx, opts) {
    const match = state.matches[matchId];
    if (!match) return state;
    const previousWinner = match.winner;
    match.winner = winnerSlotIdx;
    if (opts && typeof opts.score === "string") match.score = opts.score;
    // If we're changing the winner of a resolved match, clear downstream first.
    if (previousWinner !== null && previousWinner !== winnerSlotIdx) {
      clearDownstream(state, match);
    }
    propagate(state, match, winnerSlotIdx);
    return state;
  }

  function clearDownstream(state, match) {
    const visit = new Set();
    const walk = (m) => {
      if (!m || visit.has(m.id)) return;
      visit.add(m.id);
      if (m.feedsWinnerTo) {
        const t = state.matches[m.feedsWinnerTo.matchId];
        if (t) {
          t.slots[m.feedsWinnerTo.slot] = null;
          t.winner = null;
          t.score = null;
          walk(t);
        }
      }
      if (m.feedsLoserTo) {
        const t = state.matches[m.feedsLoserTo.matchId];
        if (t) {
          t.slots[m.feedsLoserTo.slot] = null;
          t.winner = null;
          t.score = null;
          walk(t);
        }
      }
    };
    walk(match);
    state.champion = null;
  }

  // Sort matches into (bracket, round, matchNumber) order for renderers.
  function matchesInOrder(state) {
    return Object.values(state.matches).slice().sort((a, b) => {
      const rank = (m) => (m.bracket === "W" ? 0 : m.bracket === "L" ? 1 : 2);
      if (rank(a) !== rank(b)) return rank(a) - rank(b);
      if (a.round !== b.round) return a.round - b.round;
      return a.id.localeCompare(b.id, undefined, { numeric: true });
    });
  }

  // ============================================================
  // Late-add a participant to a running bracket.
  // mode: "W" = winners side (next-round bye), "L" = losers side
  //
  // Preserves all decided matches and all currently-populated slots.
  // Strategy:
  //   1. Add the participant to state.participants (with a new seed number).
  //   2. Find the first empty slot in the target bracket, from the earliest
  //      undecided round forward. "Empty" means slot is null or BYE and the
  //      containing match is not yet decided.
  //   3. If found, place them there. This gives them an effective bye until
  //      their opponent is determined (or immediately if the other slot is
  //      already populated).
  //   4. If no empty slot exists, create a play-in match that pairs them with
  //      the winner of the appropriate feeder match — but that path is
  //      complex; we fall back to reporting failure and let the caller decide.
  //
  // Returns { placed: true, matchId, slot } on success,
  //         { placed: false, reason } otherwise.
  // ============================================================
  function addLateEntry(state, participant, mode) {
    mode = (mode === "L") ? "L" : "W";
    // Assign a new seed (end of the list)
    const newSeed = state.participants.length + 1;
    const entry = Object.assign({}, participant, { seed: newSeed, lateEntry: true });
    state.participants.push(entry);

    // Find candidate matches: same bracket as mode, not decided yet,
    // and containing at least one empty/BYE slot.
    const candidates = Object.values(state.matches)
      .filter((m) => m.bracket === mode && m.winner === null)
      .filter((m) => {
        const a = m.slots[0], b = m.slots[1];
        return !a || a.isBye || !b || b.isBye;
      })
      .sort((a, b) => {
        if (a.round !== b.round) return a.round - b.round;
        return a.id.localeCompare(b.id, undefined, { numeric: true });
      });

    if (candidates.length === 0) {
      return { placed: false, reason: "No open slot in the " + (mode === "W" ? "winners" : "losers") + " bracket. All matches are either decided or fully paired." };
    }

    const target = candidates[0];
    // Prefer slot 0 if empty, else slot 1.
    let slotIdx;
    if (!target.slots[0] || target.slots[0].isBye) slotIdx = 0;
    else slotIdx = 1;

    // Was this slot previously an auto-resolved bye that gave the other player a free win?
    // If yes, we need to "un-auto-resolve" that match to make it playable.
    const wasAutoByeMatch = target.resolvedAutoBye === true;
    target.slots[slotIdx] = entry;

    if (wasAutoByeMatch) {
      // The match had auto-advanced due to a BYE opponent.
      // Reset it so it can be played fairly with the new entrant.
      // BUT: only reset if the auto-advance winner has not yet played their
      // next match. If they have, we cannot rewrite history — the late entry
      // must wait for a later slot.
      const winnerFedTo = target.feedsWinnerTo;
      let downstreamPlayed = false;
      if (winnerFedTo) {
        const downstream = state.matches[winnerFedTo.matchId];
        if (downstream && downstream.winner !== null) downstreamPlayed = true;
      }
      if (!downstreamPlayed) {
        // Reset this match. Clear the downstream slot too.
        const priorWinner = target.slots[1 - slotIdx];
        target.winner = null;
        target.resolvedAutoBye = false;
        target.score = null;
        if (winnerFedTo) {
          const t = state.matches[winnerFedTo.matchId];
          if (t) t.slots[winnerFedTo.slot] = null;
        }
        return { placed: true, matchId: target.id, slot: slotIdx, note: "Match re-opened; " + (priorWinner ? priorWinner.name : "the prior BYE recipient") + " now plays the new entrant." };
      } else {
        // Downstream match already played — back out and find a later slot.
        target.slots[slotIdx] = null; // revert
        // Retry into the next candidate.
        for (let i = 1; i < candidates.length; i++) {
          const alt = candidates[i];
          let s;
          if (!alt.slots[0] || alt.slots[0].isBye) s = 0;
          else if (!alt.slots[1] || alt.slots[1].isBye) s = 1;
          else continue;
          if (alt.resolvedAutoBye) continue; // skip other auto-byes with downstream played
          alt.slots[s] = entry;
          return { placed: true, matchId: alt.id, slot: s };
        }
        state.participants.pop();
        return { placed: false, reason: "All open slots are downstream of already-played matches. Cannot insert without rewriting history." };
      }
    }

    return { placed: true, matchId: target.id, slot: slotIdx };
  }

  global.BracketEngine = { build, recordWinner, matchesInOrder, seedOrder, nextPow2, addLateEntry };
})(typeof window !== "undefined" ? window : globalThis);
