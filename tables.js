/**
 * tables.js — Table roster generation for tournaments.
 *
 * A "table" (a.k.a. station) is a physical playing surface in the venue.
 * Every tournament owns a fixed roster of tables. This module builds that
 * roster from user input on the tournament setup form.
 *
 * The parser accepts three input styles for the optional `naming` field:
 *
 *   1. Blank / whitespace          →  Table 1, Table 2, ..., Table N
 *   2. Numeric offset range        →  "7-12"  → Table 7, Table 8, ..., Table 12
 *                                     "7 - 12" (whitespace tolerated)
 *      When count and range disagree, `count` wins for how many are made
 *      but the offset determines the starting number.
 *   3. Comma-separated custom list →  "Stream, A, B" → Stream, Table A, Table B
 *      (bare words auto-prefixed with "Table " unless they already start
 *      with a non-numeric character sequence like "Stream")
 *
 * Output is always an array of table records:
 *   { id: "t_abc", name: "Table 1", state: "empty" }
 *
 * The state machine (see assignments.js in Phase 2) is what actually
 * manages state transitions; this module just seeds every new table
 * with state="empty".
 *
 * This module is CommonJS + browser-safe: it exports via `module.exports`
 * (for Node tests) and attaches to `window.Tables` (for the browser app).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.Tables = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Tiny id generator; avoids depending on crypto.randomUUID for Node parity.
  function tableId() {
    return "t_" + Math.random().toString(36).slice(2, 10);
  }

  /**
   * Parse the naming input into an array of display names of length `count`.
   * Never throws — falls back to "Table N" defaults on any parse failure.
   *
   * @param {number} count - Desired number of tables (>= 1).
   * @param {string} naming - Optional naming/range string.
   * @returns {string[]} Array of table display names, length `count`.
   */
  function parseNaming(count, naming) {
    const n = Math.max(1, Math.floor(Number(count) || 1));
    const raw = typeof naming === "string" ? naming.trim() : "";

    // Style 1: blank → Table 1..N
    if (raw === "") return defaultNames(1, n);

    // Style 3: comma-separated custom list (takes precedence over "-" so that
    // a stray hyphen in a name like "T-Rex Room" doesn't get parsed as a range).
    if (raw.includes(",")) {
      const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
      const names = parts.slice(0, n).map(prefixIfBare);
      // If the list is shorter than count, pad with sequential "Table k".
      while (names.length < n) names.push("Table " + (names.length + 1));
      return names;
    }

    // Style 2: numeric offset range "start-end" (only the start matters;
    // `count` controls how many we generate).
    const rangeMatch = raw.match(/^(-?\d+)\s*-\s*(-?\d+)$/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1], 10);
      return defaultNames(start, n);
    }

    // A single bare token like "A" or "Stream": treat as first name, then pad.
    const names = [prefixIfBare(raw)];
    while (names.length < n) names.push("Table " + (names.length + 1));
    return names;
  }

  function defaultNames(start, n) {
    const out = [];
    for (let i = 0; i < n; i++) out.push("Table " + (start + i));
    return out;
  }

  // "3" → "Table 3"; "A" → "Table A"; "Stream" → "Stream" (already word-heavy).
  // Rule: if the token is purely numeric OR a single letter, prefix with "Table ".
  // Otherwise assume it's a full name (like "Stream Table" or "Back Room 2").
  function prefixIfBare(token) {
    const t = token.trim();
    if (t === "") return "Table";
    if (/^-?\d+$/.test(t)) return "Table " + t;
    if (/^[A-Za-z]$/.test(t)) return "Table " + t.toUpperCase();
    return t;
  }

  /**
   * Build the full table roster for a tournament.
   * @param {number} count
   * @param {string} naming
   * @returns {{id:string,name:string,state:"empty"}[]}
   */
  function buildTables(count, naming) {
    const names = parseNaming(count, naming);
    return names.map((name) => ({
      id: tableId(),
      name,
      state: "empty"
      // future fields (Phase 2+): currentMatchId, onDeckMatchId, stateChangedAt
    }));
  }

  /**
   * Placeholder text for the naming input, given a table count.
   * "1-6" when count is 6, "1-N" in general.
   */
  function namingPlaceholder(count) {
    const n = Math.max(1, Math.floor(Number(count) || 1));
    return "1-" + n;
  }

  return {
    parseNaming,
    buildTables,
    namingPlaceholder,
    // exposed for testing
    _prefixIfBare: prefixIfBare,
    _defaultNames: defaultNames
  };
});
