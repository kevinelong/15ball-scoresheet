/* sheet-payload.js — the score sheet as a *record*.
 *
 * Kevin's model: the bracket records win/loss and nothing else; the score sheet is an
 * artifact kept like a paper sheet pulled off a pile — one per match, appended,
 * retrievable, with who saved it and when. This module is that artifact's shape: the
 * single thing `POST …/matches/{matchId}/result` puts in its `score` field, and the
 * reader the stack view uses to show what came back.
 *
 * The sheet is *not* where the race lives any more — the bracket carries the race
 * (`matches.raceTo`, resolved match ?? division ?? game default) and the scorer reads it
 * from there. The record still echoes the race as printed on the sheet (a paper sheet
 * shows the race), and `raceOrigin` says how the scorer got it.
 *
 * **Two fields named like this, meaning different things — keep them apart:**
 *   - the **match payload's** `raceFrom` is the *layer* that supplied the target:
 *     `match` | `division` | `default` (the server's `resolveRaceTo`;
 *     `internal/api/games.go`);
 *   - this **record's** `raceOrigin` is *how the scorer got the number*: `bracket` (read
 *     from the match payload — the normal path) | `local` (the game's own default, an
 *     offline tournament or a server that did not resolve one) | `override` (the recorder
 *     set its own target) | `unknown` (no race in the record at all).
 * The record's key was `raceFrom` in payloadVersion 1; v2 renamed it to `raceOrigin` for
 * exactly this reason, and `read()` still accepts the old key so a sheet already saved on
 * a device reads back correctly instead of showing "unknown".
 *
 * Two instruments produce the number, and the record says which:
 *   - `rack`  — a rack grid, marked ball by ball (15-Ball Rotation, Straight Pool 14.1);
 *   - `tally` — a games-won tally stepped against the race target (8/9/10-Ball, One
 *               Pocket, Bank Pool). The Android app's sheet is a tally in this sense.
 * That is `sheetKind`. `kind` is the sheet *body* the discipline calls for (`rack` /
 * `race`), so `Sheets.kind()` and this record cannot drift apart.
 *
 * Depends on `sheets.js` (window.Sheets / require("./sheets.js")) for the discipline's
 * definition; it has no other dependency and no DOM.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) { module.exports = factory(require("./sheets.js")); }
  else { root.SheetPayload = factory(root.Sheets); }
})(typeof window !== "undefined" ? window : globalThis, function (Sheets) {
  /**
   * Bumped when a reader of `payload_json` has to change to keep reading it.
   * 1 → 2: the record's race-origin key was renamed `raceFrom` → `raceOrigin` (it collided
   * with the match payload's `raceFrom`, which means a different thing). Readers accept
   * both keys, so a v1 sheet still reads.
   */
  const VERSION = 2;

  /** `kind`: the sheet body the discipline calls for. */
  const RACK = "rack";
  const RACE = "race";
  /** `sheetKind`: the instrument that produced the number. */
  const RACK_INSTRUMENT = "rack";
  const TALLY = "tally";

  /** The console's own app id, and the phone's (its payload predates this record). */
  const APP = "score-console";
  const ANDROID_APP = "score-android";

  /** Where the race printed on the sheet came from. */
  const FROM_BRACKET = "bracket";   // read from the match payload (the normal path)
  const FROM_LOCAL = "local";       // an offline tournament's own value
  const FROM_OVERRIDE = "override"; // the recorder set its own target, disagreeing
  const FROM_UNKNOWN = "unknown";

  function num(v) {
    if (v === null || v === undefined || v === "") return null;
    const n = parseInt(v, 10);
    return isNaN(n) ? null : n;
  }

  /** A side key ("A"/"B", "a"/"b", 0/1) folded to the record's lowercase spelling. */
  function finalsOf(sheet) {
    const f = sheet.finals || sheet;
    const a = num(f.a !== undefined ? f.a : f.finalA !== undefined ? f.finalA : f.home);
    const b = num(f.b !== undefined ? f.b : f.finalB !== undefined ? f.finalB : f.away);
    return { a: a === null ? 0 : a, b: b === null ? 0 : b };
  }

  /** One rack's per-side detail, with the two numbers the paper sheet adds up. */
  function rackOf(entry, fallbackRack) {
    const out = { rack: num(entry && entry.rack) || fallbackRack };
    ["a", "b"].forEach(function (side) {
      const from = entry && (entry[side] || entry[side.toUpperCase()]) || {};
      const balls = Array.isArray(from.balls) ? from.balls.slice() : [];
      const fouls = num(from.fouls) || 0;
      const made = balls.length;
      out[side] = { balls: balls, fouls: fouls, made: made, net: made - fouls };
    });
    return out;
  }

  /**
   * Build the record for one match result — the body of the result endpoint's `score`.
   *
   * input:
   *   game      the tournament's game id, in any spelling sheets.js resolves
   *   sheet     the sheet the scorer filled in — the console's own collected shape
   *             ({ racks:[{A:{balls,fouls},B:{…}}], finalA, finalB, winner, pAname, pBname })
   *   raceTo    the race the bracket carries for this match (number, or null if unknown)
   *   raceOrigin  how the scorer got that number (default "bracket")
   *   names     { a, b } player names, overriding the sheet's own
   *   app/appVersion  what produced the number
   *   winner    "A" | "B" | null (defaults to the sheet's own winner box)
   */
  function build(input) {
    input = input || {};
    const game = input.game;
    const id = Sheets.id(game);
    const spec = Sheets.spec(id);
    const isRack = Sheets.isRack(game);
    const sheet = input.sheet || {};
    const finals = finalsOf(sheet);
    const winner = input.winner !== undefined ? input.winner : (sheet.winner || null);
    const rec = {
      payloadVersion: VERSION,
      kind: Sheets.kind(game),                              // rack | race
      sheetKind: isRack ? RACK_INSTRUMENT : TALLY,          // the instrument
      discipline: id,
      measure: Sheets.measure(game),
      goals: isRack ? Sheets.goals(game) : [],              // a tally's goal is its race target
      raceTo: num(input.raceTo),
      raceOrigin: input.raceOrigin || FROM_BRACKET,
      finals: finals,
      winner: winner === "A" || winner === "B" ? winner : null,
      names: { a: name(input.names && input.names.a, sheet.pAname), b: name(input.names && input.names.b, sheet.pBname) },
      app: input.app || APP,
      appVersion: input.appVersion || ""
    };
    if (isRack) {
      const racks = Array.isArray(sheet.racks) ? sheet.racks : [];
      rec.racks = racks.map(function (r, i) { return rackOf(r, i + 1); });
      rec.racksPlayed = rec.racks.filter(function (r) {
        return r.a.made || r.b.made || r.a.fouls || r.b.fouls;
      }).length;
      rec.ballsPerRack = spec.ballsPerRack || 0;
    }
    return rec;
  }

  function name(v, fallback) {
    const s = v !== undefined && v !== null && String(v).trim() !== "" ? v : fallback;
    return s === undefined || s === null ? "" : String(s);
  }

  /**
   * Read whatever is in `payload_json` back into a view the stack can render — the
   * console's record, the Android app's older payload, or junk. Never throws: a reader
   * that dies on an unknown payload cannot show the director what was saved.
   *
   * opts.raceTo   the race the bracket carries now, to spot a recorder that overrode it
   */
  function read(raw, opts) {
    opts = opts || {};
    const p = (raw && typeof raw === "object") ? raw : {};
    const app = typeof p.app === "string" ? p.app : "";
    const discipline = typeof p.discipline === "string" ? p.discipline : "";
    const kind = p.kind === RACK || p.kind === RACE
      ? p.kind
      : (discipline ? Sheets.kind(discipline) : RACE);
    // The instrument: a record that names one is believed; otherwise a rack sheet is a
    // grid, and everything else — including the phone's plain tally — is a tally.
    const sheetKind = p.sheetKind === RACK_INSTRUMENT || p.sheetKind === TALLY
      ? p.sheetKind
      : (app === ANDROID_APP ? TALLY : (kind === RACK ? RACK_INSTRUMENT : TALLY));
    const raceTo = num(p.raceTo);
    const bracketRace = num(opts.raceTo);
    // `raceOrigin` is the record's own key (v2). A v1 sheet carries the same meaning under
    // `raceFrom` — the word the *match payload* uses for a different thing — so it is
    // accepted as the legacy spelling rather than read as a value we do not recognise.
    let raceOrigin = typeof p.raceOrigin === "string" ? p.raceOrigin
      : (typeof p.raceFrom === "string" ? p.raceFrom : "");
    if (raceOrigin !== FROM_BRACKET && raceOrigin !== FROM_LOCAL && raceOrigin !== FROM_OVERRIDE) {
      if (raceTo === null) raceOrigin = FROM_UNKNOWN;
      else if (bracketRace !== null) raceOrigin = raceTo === bracketRace ? FROM_BRACKET : FROM_OVERRIDE;
      else if (app === ANDROID_APP) raceOrigin = FROM_OVERRIDE; // hand-typed on the phone
      else raceOrigin = FROM_BRACKET;
    }
    return {
      payloadVersion: num(p.payloadVersion) || 0,
      kind: kind,
      sheetKind: sheetKind,
      discipline: discipline,
      measure: typeof p.measure === "string" ? p.measure : (discipline ? Sheets.measure(discipline) : ""),
      goals: Array.isArray(p.goals) ? p.goals.slice() : [],
      raceTo: raceTo,
      raceOrigin: raceOrigin,
      finals: finalsOf(p),
      winner: p.winner === "A" || p.winner === "B" ? p.winner : null,
      names: {
        a: name(p.names && p.names.a, p.home ? String(p.home) : ""),
        b: name(p.names && p.names.b, p.away ? String(p.away) : "")
      },
      racks: Array.isArray(p.racks) ? p.racks.map(function (r, i) { return rackOf(r, i + 1); }) : [],
      app: app,
      appVersion: typeof p.appVersion === "string" ? p.appVersion : ""
    };
  }

  /** What produced the number, in words. */
  function instrument(view) {
    if (view.sheetKind === RACK_INSTRUMENT) return "rack sheet";
    return view.app === ANDROID_APP ? "tally (score-android)" : "tally";
  }

  /** The record's own result line: "25–13 · winner A". */
  function summary(view) {
    const line = view.finals.a + "\u2013" + view.finals.b;
    if (view.winner) return line + " \u00b7 winner " + view.winner;
    return line + " \u00b7 no winner";
  }

  return {
    VERSION: VERSION,
    RACK: RACK,
    RACE: RACE,
    RACK_INSTRUMENT: RACK_INSTRUMENT,
    TALLY: TALLY,
    APP: APP,
    ANDROID_APP: ANDROID_APP,
    FROM_BRACKET: FROM_BRACKET,
    FROM_LOCAL: FROM_LOCAL,
    FROM_OVERRIDE: FROM_OVERRIDE,
    FROM_UNKNOWN: FROM_UNKNOWN,
    build: build,
    read: read,
    instrument: instrument,
    summary: summary
  };
});
