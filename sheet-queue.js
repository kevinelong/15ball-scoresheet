/* The printed-sheet queue (decision 018).
 *
 * The bracket desk hands a paper sheet to each table as its match becomes ready, and the
 * sheet is pre-filled: whose match it is, the round, and the target it is played to. The
 * per-match lifecycle already lives on the match itself, in bracket.js — `sheetIssuedAt`,
 * `sheetIssueVersion`, `sheetPlayersSnapshot`, `sheetRaceTo`, with `isMatchReady`,
 * `sheetIsStale` and `markSheetIssued` as its primitives — and this module is the queue on
 * top of it: what is ready to print, what has been printed, what a later result made stale,
 * and the URL of the page that prints them.
 *
 * It is pure — no DOM, no storage, no clock of its own — so the bracket page, the print
 * page and `node sheet-queue.test.js` all run the same code.
 *
 * Sheet states:
 *   pending  both players are not known yet (a slot is empty, or is a BYE)
 *   ready    both players known, nothing printed for this match yet
 *   printed  printed, and the bracket still agrees with what was printed
 *   stale    printed, but the bracket moved under it: the paper copy is void, print again
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    // bracket.js installs itself on globalThis (it has no module exports of its own).
    require("./bracket.js");
    module.exports = factory(globalThis.BracketEngine);
  } else {
    root.SheetQueue = factory(root.BracketEngine);
  }
})(typeof window !== "undefined" ? window : globalThis, function (Engine) {
  /** How many printed sheets the queue page lists under "Recently printed". */
  const RECENT_LIMIT = 20;

  const PENDING = "pending";
  const READY = "ready";
  const PRINTED = "printed";
  const STALE = "stale";

  /** The two names on the match, or null when it is not a real pairing yet. */
  function names(match) {
    if (!match || !Array.isArray(match.slots)) return null;
    const a = match.slots[0], b = match.slots[1];
    if (!a || !b || a.isBye || b.isBye || !a.name || !b.name) return null;
    return [String(a.name), String(b.name)];
  }

  /** A match is ready for a sheet when both its players are concrete names. */
  function ready(match) { return names(match) !== null; }

  /** The target the sheets of this tournament are played to, or null when it names none. */
  function raceTo(t) {
    const n = t && t.raceTo;
    return typeof n === "number" && n > 0 ? n : null;
  }

  /**
   * The match's issued sheet as one record: `{at, version, snapshot, raceTo}`, or null when
   * this match has never had one. `at` is an ISO-8601 string (the stored field is the
   * millisecond number bracket.js writes); a stored ISO string is read back as it stands, so
   * a tournament saved by an older console still loads.
   */
  function issue(match) {
    if (!match || !match.sheetIssuedAt) return null;
    const ms = typeof match.sheetIssuedAt === "number" ? match.sheetIssuedAt : Date.parse(match.sheetIssuedAt);
    const snap = Array.isArray(match.sheetPlayersSnapshot) ? match.sheetPlayersSnapshot : [null, null];
    const version = parseInt(match.sheetIssueVersion, 10);
    return {
      at: new Date(isNaN(ms) ? 0 : ms).toISOString(),
      version: version > 0 ? version : 1,
      snapshot: [snap[0] == null ? null : String(snap[0]), snap[1] == null ? null : String(snap[1])],
      raceTo: typeof match.sheetRaceTo === "number" ? match.sheetRaceTo : null
    };
  }

  /** What the match's sheet is: pending | ready | printed | stale. */
  function state(match, t) {
    const rec = issue(match);
    const now = names(match);
    if (!rec) return now ? READY : PENDING;
    // A match whose pairing went away (an upstream winner was edited and its slot cleared)
    // cannot be printed again yet, but the sheet that was handed out is void all the same.
    if (!now) return STALE;
    if (Engine.sheetIsStale(match, raceTo(t))) return STALE;
    return PRINTED;
  }

  /** True when the sheet this match was printed with is out of date. */
  function stale(match, t) { return state(match, t) === STALE; }

  /**
   * Record that the match's sheet has been printed. Every issue is one version — v1 the
   * first, v2 the first reprint — which is the wording bracket.js's own `markSheetIssued`
   * gives the reprint banner. Pass an ISO-8601 `at` to pin the stamp in a test.
   */
  function mark(match, t, at) {
    if (!names(match)) return null;
    const ms = typeof at === "string" ? Date.parse(at) : at;
    Engine.markSheetIssued(match, typeof ms === "number" && !isNaN(ms) ? ms : undefined, raceTo(t));
    return issue(match);
  }

  /** The short round label the printed sheet's pill carries: "R1 · Match 1", "L2 · Match 3", "GF1". */
  function label(match) {
    const id = String((match && match.id) || "");
    const m = /^([WL])(\d+)M(\d+)$/.exec(id);
    if (m) return (m[1] === "W" ? "R" + m[2] : "L" + m[2]) + " \u00b7 Match " + m[3];
    const gf = /^GF(\d+)$/.exec(id);
    if (gf) return "GF" + gf[1];
    return id;
  }

  /** Every match of the tournament's bracket, in id order, with its sheet state. */
  function entries(t) {
    if (!t || !t.bracket || !t.bracket.matches) return [];
    return Object.keys(t.bracket.matches)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .map((id) => {
        const match = t.bracket.matches[id];
        return {
          matchId: id,
          match: match,
          bracket: match.bracket,
          round: match.round,
          label: label(match),
          names: names(match),
          issue: issue(match),
          state: state(match, t)
        };
      });
  }

  /** Round 1 of the winners bracket — the batch the desk prints when the bracket is built. */
  function roundOne(t) {
    return entries(t).filter((e) => e.bracket === "W" && e.round === 1);
  }

  /** Paper copies superseded by a reprint: every issue past each match's first. */
  function voided(t) {
    return entries(t).reduce((n, e) => n + (e.issue ? e.issue.version - 1 : 0), 0);
  }

  /** The queue page's sections, plus Round 1's batch and the voided count. */
  function queue(t) {
    const all = entries(t);
    return {
      ready: all.filter((e) => e.state === READY),
      reprints: all.filter((e) => e.state === STALE),
      printed: all.filter((e) => e.state === PRINTED)
        .sort((a, b) => b.issue.at.localeCompare(a.issue.at))
        .slice(0, RECENT_LIMIT),
      pending: all.filter((e) => e.state === PENDING),
      roundOne: all.filter((e) => e.bracket === "W" && e.round === 1 && e.state !== PENDING),
      voided: voided(t)
    };
  }

  /**
   * The sheets a print covers: one named match (even one already printed — a lost sheet is
   * reprinted by naming it), or a whole round of a bracket.
   */
  function selection(t, opts) {
    const o = opts || {};
    if (o.matchId) return entries(t).filter((e) => e.matchId === o.matchId && e.state !== PENDING);
    const bracket = o.bracket || "W";
    const round = o.round == null ? 1 : o.round;
    return entries(t).filter((e) => e.bracket === bracket && e.round === round && e.state !== PENDING);
  }

  /** The four fields that carry one issued sheet, copied between two match objects. */
  const FIELDS = ["sheetIssuedAt", "sheetIssueVersion", "sheetPlayersSnapshot", "sheetRaceTo"];

  /** Write an issue record back onto a match object (the inverse of `issue`). */
  function restore(match, rec) {
    if (!match || !rec) return;
    match.sheetIssuedAt = Date.parse(rec.at);
    match.sheetIssueVersion = rec.version;
    match.sheetPlayersSnapshot = rec.snapshot.slice();
    match.sheetRaceTo = typeof rec.raceTo === "number" ? rec.raceTo : null;
    return match;
  }

  /**
   * Merge the issue records another page wrote into this copy of the bracket — the newer
   * record wins, per match. The bracket page and the print page both write the one storage
   * key, so without this the next save on the bracket page would un-print every sheet the
   * desk had just printed from the queue page. Returns how many records were taken.
   */
  function adopt(matches, storedMatches) {
    if (!matches || !storedMatches) return 0;
    let taken = 0;
    Object.keys(matches).forEach((id) => {
      const mine = issue(matches[id]);
      const theirs = issue(storedMatches[id]);
      if (!theirs) return;
      if (!mine || theirs.at > mine.at) { restore(matches[id], theirs); taken++; }
    });
    return taken;
  }

  /** Carry the issue records across a rebuild, for the matches that still exist. */
  function carry(from, to) {
    if (!from || !to || !from.matches || !to.matches) return 0;
    let kept = 0;
    Object.keys(to.matches).forEach((id) => {
      const rec = issue(from.matches[id]);
      if (rec && !issue(to.matches[id])) { restore(to.matches[id], rec); kept++; }
    });
    return kept;
  }

  /**
   * The print page's URL for a tournament, optionally for one match or for the Round 1 batch.
   * That page holds the paper-style sheets and the queue's own live view.
   */
  function uri(t, opts) {
    const o = opts || {};
    let url = "print.html?t=" + encodeURIComponent(t && t.id ? t.id : "");
    if (o.matchId) url += "&m=" + encodeURIComponent(o.matchId);
    if (o.roundOne) url += "&round=1";
    return url;
  }

  return {
    RECENT_LIMIT: RECENT_LIMIT,
    FIELDS: FIELDS,
    PENDING: PENDING,
    READY: READY,
    PRINTED: PRINTED,
    STALE: STALE,
    names: names,
    ready: ready,
    raceTo: raceTo,
    issue: issue,
    state: state,
    stale: stale,
    mark: mark,
    label: label,
    entries: entries,
    roundOne: roundOne,
    voided: voided,
    queue: queue,
    selection: selection,
    restore: restore,
    adopt: adopt,
    carry: carry,
    uri: uri
  };
});
