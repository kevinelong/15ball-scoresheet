/* Per-discipline score-sheet definitions.
 *
 * The paper sheets in docs/ are one per discipline; this is the same idea for the in-app
 * sheet, which until now was a single hard-coded 15-ball layout with everything else
 * falling back to a generic games-won counter. The sheet's geometry, column labels and
 * goal presets come from the tournament's game instead.
 *
 * Two spellings of the same game exist in this codebase: the app has always used its own
 * ids for some disciplines (fifteenBall, 14_1, onepocket, banks) while the tournament
 * server uses canonical ones (15ball_rotation, straight_14_1, one_pocket, bank_pool). Both
 * resolve here, so a tournament imported from the server and one built in the app get the
 * same sheet.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) { module.exports = factory(); }
  else { root.Sheets = factory(); }
})(typeof window !== "undefined" ? window : globalThis, function () {
  /** Mark the balls of each rack; the sheet adds the columns up to a total. */
  const RACK = "rack";
  /** Tally games won against a race target. */
  const RACE = "race";
  /** Marked one ball at a time — the sheet is a rack grid. */
  const BALLS = "balls";
  /** One step per game won — the sheet is a tally against the race target. */
  const WINS = "wins";

  // Canonical id -> sheet.
  //
  // `measure` says how the discipline is scored, and it is the *only* thing that decides
  // which controls the sheet gets: "balls" is marked one at a time in a rack grid, "wins" is
  // stepped with the +/- buttons. It is data, not an inference about the target number — the
  // console used to guess "points mode" from `raceTo >= 50`, which was wrong both ways (a
  // small points target got no controls, and a win-measured race got jumps).
  //
  // `quickAdd` lists the jump controls the tally offers, and every discipline offers none: a
  // jump can overshoot the race it is scoring (three taps took a race to 7 to 15, and the
  // winner was selected for the desk), and the +/- step is the instrument that cannot.
  const DEFS = {
    "15ball_rotation": {
      measure: BALLS,
      quickAdd: [],
      ballsPerRack: 15,      // a full rack; the ball number is its point value
      racks: 4,              // 4 x 15 = 60 balls, enough for the 25/50 club targets
      goals: [25, 50],
      columns: ["BALLS MADE", "FOULS", "RACK TOTAL", "GAME SUBTOTAL"],
      finalLabel: "FINAL GAME TOTAL",
      ballFaces: true        // solid/stripe faces, because the numbers mean something
    },
    "straight_14_1": {
      measure: BALLS,
      quickAdd: [],
      ballsPerRack: 14,      // the fifteenth ball stays on the table as the break ball
      racks: 8,              // 8 x 14 = 112 balls: what a match to 100 needs
      goals: [75, 100],
      columns: ["BALLS MADE", "FOULS", "RACK TOTAL", "RUNNING TOTAL"],
      finalLabel: "FINAL MATCH TOTAL",
      ballFaces: false       // every ball is one point, so a mark is a count, not a ball
    },
    "8ball":      { measure: WINS, quickAdd: [] },
    "9ball":      { measure: WINS, quickAdd: [] },
    "10ball":     { measure: WINS, quickAdd: [] },
    "one_pocket": { measure: WINS, quickAdd: [] },
    "bank_pool":  { measure: WINS, quickAdd: [] }
  };

  // The app's older spellings, including the game id it renamed in place.
  const ALIASES = {
    fifteenBall: "15ball_rotation",
    kball: "15ball_rotation",
    "14_1": "straight_14_1",
    onepocket: "one_pocket",
    banks: "bank_pool"
  };

  const DEFAULT = "15ball_rotation";

  /** Resolve any spelling of a game to a defined canonical id. */
  function id(game) {
    if (!game) { return DEFAULT; }
    const key = ALIASES[game] || game;
    return Object.prototype.hasOwnProperty.call(DEFS, key) ? key : DEFAULT;
  }

  function spec(game) { return DEFS[id(game)]; }

  /** How a discipline is scored: `BALLS` (marked one at a time) or `WINS` (stepped). */
  function measure(game) { return spec(game).measure; }

  /** True when the match is scored by marking balls rather than tallying games. */
  function isRack(game) { return spec(game).measure === BALLS; }

  /** The body a discipline's sheet renders — also the `_kind` a saved sheet carries. */
  function kind(game) { return isRack(game) ? RACK : RACE; }

  /** Goal checkboxes for a rack sheet, in the discipline's own usual targets. */
  function goals(game) { return spec(game).goals.slice(); }

  return {
    RACK: RACK,
    RACE: RACE,
    BALLS: BALLS,
    WINS: WINS,
    defaultId: DEFAULT,
    ids: Object.keys(DEFS),
    id: id,
    spec: spec,
    measure: measure,
    kind: kind,
    isRack: isRack,
    goals: goals
  };
});
