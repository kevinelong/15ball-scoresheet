/* The printed-sheet queue page (decision 018).
 *
 * Opens from the bracket page as print.html?t=<tournamentId>, optionally &m=<matchId> for
 * one match or &round=1 for the Round 1 batch. One document does both jobs:
 *
 *   - the live queue: what is ready to print, what a later result has made stale
 *     ("REPRINT - v2"), and what has been printed and is now superseded;
 *   - the paper sheets themselves, in the paper sheet's visual language (docs/
 *     _scoresheet_draw.py), one per printed page.
 *
 * The queue itself is SheetQueue's: staleness, labels and the Round 1 batch are computed
 * there, not here. This page is the view, the storage round-trip and the print.
 *
 * Printing records the sheet before the dialog opens (so the queue is right whichever way
 * the desk leaves it) and writes the records back into the stored document with a re-read,
 * replace-the-sheet-fields, write-the-same-document cycle: the bracket page owns that
 * document too, so this page must never save a bracket it has been holding since load.
 */
(function () {
  "use strict";

  const STORAGE_KEY = "fifteenBall.app.v3";

  // ---------- small helpers ----------

  const $ = (sel, root) => (root || document).querySelector(sel);

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
  }

  /** A stored ISO stamp, shown the way the desk reads a clock; junk is shown as it is. */
  function when(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return d.toLocaleString();
  }

  /** One query parameter. `t` is required; `m` and `round` narrow what the page prints. */
  function param(name) {
    const q = (window.location && window.location.search) || "";
    const m = new RegExp("[?&]" + name + "=([^&]*)").exec(q);
    if (!m) return null;
    try { return decodeURIComponent(m[1].replace(/\+/g, " ")); } catch (e) { return m[1]; }
  }

  const WANT = { t: param("t"), m: param("m"), round: param("round") };

  // ---------- per-discipline wording ----------
  //
  // Keyed by the canonical id sheets.js resolves to. The header name is the console's own
  // (app.js GAMES), the steps are the paper sheet's HOW TO SCORE strip, and the rules are
  // the same summary the paper sheet carries -- shortened to fit the strip, ASCII only.

  const DISCIPLINE = {
    "15ball_rotation": {
      name: "15-Ball Rotation",
      rulesTitle: "15-BALL ROTATION RULES SUMMARY",
      howto: [
        "Fill NAME; check the goal (25 rec / 50 pro).",
        "MARK each ball's circle as it drops (mandatory).",
        "RECONCILE every rack: 15 marks total, no dupes.",
        "RACK TOTAL = marks - FOULS. Tally optional.",
        "GAME SUBTOTAL = last SUBTOTAL + RACK TOTAL.",
        "First to the goal wins. Check WINNER; both sign."
      ],
      rules: [
        "BALL IN HAND every inning. No safeties - the incoming player places the cue ball anywhere.",
        "Rack: 1 at the apex on the foot spot, 8 in the centre, the rest random.",
        "Hit the lowest ball first, then CALL ball and pocket. An uncalled make is spotted.",
        "Fouls (one point, the score can go negative): scratch, no rail, wrong ball first, ball off the table.",
        "First to the goal wins."
      ]
    },
    "straight_14_1": {
      name: "Straight Pool (14.1 Continuous)",
      rulesTitle: "14.1 STRAIGHT POOL RULES SUMMARY",
      howto: [
        "Fill NAME; check the goal (75 rec / 100 pro).",
        "MARK each ball's circle as it drops (mandatory).",
        "RECONCILE every rack: 14 marks, no dupes, then re-rack.",
        "RACK TOTAL = marks - FOULS.",
        "RUNNING TOTAL = last TOTAL + RACK TOTAL.",
        "First to the goal wins. Check WINNER; both sign."
      ],
      rules: [
        "EVERY ball is one point; a foul costs one point, so the score can go negative.",
        "Continuous: the total carries rack to rack - the first to the goal wins.",
        "14 balls down and the rack is re-racked; the 15th ball stays as the break ball.",
        "Call the ball and pocket. A miss is not a foul: the inning just ends.",
        "Fouls: scratch, no rail, ball off the table. A breaking foul costs two."
      ]
    },
    "8ball": {
      name: "8-Ball",
      rulesTitle: "8-BALL RULES SUMMARY",
      howto: [
        "Fill NAME; note the race target.",
        "Tick one box for each game won.",
        "First to the race target wins. Check WINNER; both sign."
      ],
      rules: [
        "Rack: 8 in the centre, a solid and a stripe in the back corners.",
        "Break; the table stays open on the break.",
        "Take solids or stripes on the first legal ball made, then call the pocket on the 8.",
        "Fouls give ball in hand.",
        "Pocket the 8 after clearing your group to win the game."
      ]
    },
    "9ball": {
      name: "9-Ball",
      rulesTitle: "9-BALL RULES SUMMARY",
      howto: [
        "Fill NAME; note the race target.",
        "Tick one box for each game won.",
        "First to the race target wins. Check WINNER; both sign."
      ],
      rules: [
        "Rack: 1 at the apex, 9 in the centre, the rest random.",
        "Hit the lowest ball first; any ball pocketed counts, called or not.",
        "Fouls give ball in hand.",
        "The 9 on a legal shot wins the game."
      ]
    },
    "10ball": {
      name: "10-Ball",
      rulesTitle: "10-BALL RULES SUMMARY",
      howto: [
        "Fill NAME; note the race target.",
        "Tick one box for each game won.",
        "First to the race target wins. Check WINNER; both sign."
      ],
      rules: [
        "Rack: 1 at the apex, 10 in the centre.",
        "Call the ball and the pocket on every shot.",
        "Fouls give ball in hand.",
        "Legally pocket the 10 to win the game."
      ]
    },
    "one_pocket": {
      name: "One Pocket",
      rulesTitle: "ONE POCKET RULES SUMMARY",
      howto: [
        "Fill NAME; note the race target.",
        "Tick one box for each game won.",
        "First to the race target wins. Check WINNER; both sign."
      ],
      rules: [
        "Each player has one pocket; eight balls in it wins the game.",
        "A scratch or a foul on your own pocket owes the spot (one ball).",
        "Three consecutive fouls lose the game.",
        "Ball in hand behind the head string after a scratch."
      ]
    },
    "bank_pool": {
      name: "Bank Pool",
      rulesTitle: "BANK POOL RULES SUMMARY",
      howto: [
        "Fill NAME; note the race target.",
        "Tick one box for each game won.",
        "First to the race target wins. Check WINNER; both sign."
      ],
      rules: [
        "Every ball must be banked; a ball must hit a rail on the way to the pocket.",
        "A pocketed ball that was not banked spots and owes one.",
        "Scratch or foul gives ball in hand; a scratch also owes the spot.",
        "Call the ball and pocket on every shot."
      ]
    }
  };

  // The race a wins-measured discipline is usually played to, used only when the
  // tournament itself names no target: the tally is drawn to its target, so the sheet
  // cannot be printed without one.
  const RACE_DEFAULT = { "8ball": 7, "9ball": 7, "10ball": 7, "one_pocket": 3, "bank_pool": 5 };

  const DEFAULT_DISCIPLINE = "15ball_rotation";

  function discipline(game) {
    const canon = window.Sheets ? window.Sheets.id(game) : DEFAULT_DISCIPLINE;
    return DISCIPLINE[canon] || DISCIPLINE[DEFAULT_DISCIPLINE];
  }

  // ---------- storage ----------

  // What the last read found, for the message the page shows when it found nothing.
  let readResult = { ok: false, why: "start" };
  let doc = null;
  let t = null;

  /** localStorage, or null when the browser refuses it (private mode, disabled). */
  function rawStorage() {
    try { return window.localStorage || null; } catch (e) { return null; }
  }

  /** Read and parse the app document. Never throws: the page always has something to say. */
  function read() {
    const ls = rawStorage();
    if (!ls) return { ok: false, why: "no-storage" };
    let raw = null;
    try { raw = ls.getItem(STORAGE_KEY); } catch (e) { return { ok: false, why: "no-storage" }; }
    if (!raw) return { ok: false, why: "empty" };
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch (e) { return { ok: false, why: "junk" }; }
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.tournaments)) {
      return { ok: false, why: "junk" };
    }
    return { ok: true, doc: parsed };
  }

  function findTournament(d, id) {
    if (!d || !id) return null;
    const hit = d.tournaments.filter((x) => x && x.id === id);
    return hit.length ? hit[0] : null;
  }

  /** Re-read storage and re-render everything. The one entry point for "show me now". */
  function refresh() {
    readResult = read();
    doc = readResult.ok ? readResult.doc : null;
    t = doc ? findTournament(doc, WANT.t) : null;
    render();
  }

  // ---------- what a print covers ----------

  /**
   * The states that are waiting for paper: never printed, or printed and now stale.
   * A printed sheet whose pairing went away (an upstream winner was edited, and the slot
   * that refills from it is empty again) is stale too, but there is nothing to print for it
   * until both players are back: the desk must not hand out a sheet with no names on it.
   */
  function needsSheet(e) {
    if (!e.names) return false;
    return e.state === window.SheetQueue.READY || e.state === window.SheetQueue.STALE;
  }

  /**
   * 018's Round 1 batch: the Round 1 sheets the desk has not printed yet. The batch is
   * drawn from the ones that need paper rather than from every Round 1 match, because every
   * issue is a new version now (bracket.js): reprinting a sheet that is still current would
   * void good paper and stamp it REPRINT. A current sheet is still reprintable one at a
   * time, from "Recently printed".
   */
  function roundOneNeeding() {
    if (!t || !window.SheetQueue) return [];
    return window.SheetQueue.queue(t).roundOne
      .filter((e) => e.names && e.state !== window.SheetQueue.PRINTED);
  }

  /** The entries this page is printing: one match, the Round 1 batch, or all that need one. */
  function selection() {
    if (!t || !window.SheetQueue) return [];
    if (WANT.m) return window.SheetQueue.selection(t, { matchId: WANT.m }).filter((e) => e.names);
    if (WANT.round === "1") return roundOneNeeding();
    return window.SheetQueue.entries(t).filter(needsSheet);
  }

  // ---------- notices ----------

  function showNotice(html) {
    const n = $("#notice");
    n.innerHTML = html;
    n.hidden = false;
  }

  function hideNotice() { $("#notice").hidden = true; }

  /** The plain message for whatever stopped the page: no storage, no id, no match. */
  function defaultNotice() {
    const back = '<p><a href="index.html">&larr; Back to the bracket</a></p>';
    if (!WANT.t) {
      return "<h2>No tournament selected</h2>" +
        "<p>This page prints one tournament's sheets. The URL's <code>t</code> field " +
        "(the tournament id) is required, e.g. <code>print.html?t=&lt;tournament id&gt;</code>. " +
        "The bracket page links here with it filled in.</p>" + back;
    }
    if (readResult.why === "empty") {
      return "<h2>Nothing saved on this device yet</h2>" +
        "<p>There is no tournament in this browser's storage. This console has no server " +
        "link, so a tournament lives only in the browser it was built in.</p>" + back;
    }
    if (readResult.why === "junk" || readResult.why === "no-storage") {
      return "<h2>The saved console data could not be read</h2>" +
        "<p>This browser's stored data is missing or not in the shape this console writes " +
        "(<code>fifteenBall.app.v3</code>). Nothing has been changed; the bracket page will " +
        "say the same thing.</p>" + back;
    }
    return "<h2>Tournament not found</h2>" +
      "<p>No tournament with the id <code>" + esc(WANT.t) + "</code> is saved in this " +
      "browser. Open the bracket page and follow its print link, which carries the id.</p>" + back;
  }

  // ---------- render ----------

  function render() {
    // The sheet modules first: without them there is no state to name and nothing to draw,
    // and the toolbar's counts come from them too.
    if (!window.SheetQueue || !window.Sheets) {
      $("#tournamentName").textContent = "Print queue";
      $("#printSelected").disabled = true;
      $("#printSelected").textContent = "Print";
      $("#printRoundOne").hidden = true;
      showNotice("<h2>The sheet modules did not load</h2>" +
        "<p>print.html loads bracket.js, sheets.js and sheet-queue.js before print.js; the " +
        "page cannot name a state or draw a sheet without them.</p>" +
        '<p><a href="index.html">&larr; Back to the bracket</a></p>');
      $("#queue").innerHTML = "";
      $("#sheets").innerHTML = "";
      return;
    }
    renderToolbar();
    if (!t) {
      showNotice(defaultNotice());
      $("#queue").innerHTML = "";
      $("#sheets").innerHTML = "";
      return;
    }
    // A named match that is not in this bracket is worth saying: the desk followed a stale
    // link and would otherwise be looking at an empty page with a working queue.
    if (WANT.m) {
      const found = window.SheetQueue.entries(t).filter((e) => e.matchId === WANT.m);
      if (!found.length) {
        showNotice("<h2>Match not found</h2>" +
          "<p>No match <code>" + esc(WANT.m) + "</code> is in this tournament's bracket.</p>" +
          '<p><a href="index.html">&larr; Back to the bracket</a></p>');
        $("#queue").innerHTML = "";
        $("#sheets").innerHTML = "";
        return;
      }
    }
    hideNotice();
    renderQueue(window.SheetQueue.queue(t));
    renderSheets(selection());
  }

  function renderToolbar() {
    $("#tournamentName").textContent = t ? (t.name || "Tournament") : "Print queue";
    const sel = t ? selection() : [];
    const btn = $("#printSelected");
    btn.disabled = sel.length === 0;
    // A "Print" action that always holds what it will print: the count is the sheets.
    btn.innerHTML = "Print" + (sel.length ? ' <span class="pill">' + sel.length + "</span>" : "");
    btn.title = sel.length
      ? "Print " + sel.length + " sheet" + (sel.length === 1 ? "" : "s")
      : "Nothing to print: no ready, stale or named match";

    // The Round 1 batch control: how many Round 1 sheets still need printing, hidden once
    // none do. It prints exactly those (see roundOneNeeding).
    const count = t ? roundOneNeeding().length : 0;
    const r1 = $("#printRoundOne");
    r1.hidden = count === 0;
    r1.innerHTML = "Print all Round 1 sheets" + (count ? ' <span class="pill">' + count + "</span>" : "");
    r1.title = "Print the Round 1 sheets that still need paper (" + count + ")";
  }

  function renderQueue(q) {
    const box = $("#queue");
    const need = q.ready.concat(q.reprints)
      .sort((a, b) => a.matchId.localeCompare(b.matchId, undefined, { numeric: true }));
    const printable = need.filter((e) => e.names).length;
    const parts = [];

    parts.push('<section class="qsec"><h2>Ready to print <span class="pill">' + printable + "</span></h2>");
    if (need.length) {
      parts.push('<ul class="qlist">' + need.map(readyRowHtml).join("") + "</ul>");
    } else {
      parts.push('<p class="qnone">Nothing is waiting for paper.' +
        (q.pending.length
          ? " " + q.pending.length + " match" + (q.pending.length === 1 ? "" : "es") +
            " still need both players."
          : "") + "</p>");
    }
    parts.push("</section>");

    // Collapsed by default: the desk reads this page for what to print, and the audit trail
    // is only needed when something looks wrong. The voided count is on the summary line
    // because that is the number the desk checks after a reprint.
    parts.push('<details class="qsec"><summary>Recently printed ' +
      '<span class="pill">' + q.printed.length + "</span> " +
      '<span class="pill voided" title="Paper copies superseded by a reprint">' +
      q.voided + " voided</span></summary>");
    parts.push('<p class="qnote">A reprint supersedes the paper copy it replaces: those ' +
      "superseded copies are the voided count. Every issue is a version - v1 the first, v2 " +
      "the first reprint. The last " + window.SheetQueue.RECENT_LIMIT + " are listed here.</p>");
    if (q.printed.length) {
      parts.push('<ul class="qlist">' + q.printed.map(printedRowHtml).join("") + "</ul>");
    } else {
      parts.push('<p class="qnote">No sheets printed from this console yet.</p>');
    }
    parts.push("</details>");

    box.innerHTML = parts.join("");
  }

  /** The version a print made now will carry: one past the last issue. */
  function nextVersion(e) {
    return e.issue ? e.issue.version + 1 : 1;
  }

  function readyRowHtml(e) {
    const stale = e.state === window.SheetQueue.STALE;
    // A stale sheet whose pairing is not set again yet is void paper with nothing to
    // reprint: it is listed (the desk's copy is out of date) but it has no print control.
    if (!e.names) {
      return '<li class="qlrow blocked">' +
        '<div class="qlmain">pairing not set</div>' +
        '<div class="qlmeta">' + esc(e.label) +
          ' <span class="qlflag">waiting on both players - nothing to print yet</span></div>' +
        "</li>";
    }
    const pair = "<strong>" + esc(e.names[0]) + "</strong> vs <strong>" + esc(e.names[1]) + "</strong>";
    return '<li class="qlrow' + (stale ? " stale" : "") + '">' +
      '<div class="qlmain">' + pair + "</div>" +
      '<div class="qlmeta">' + esc(e.label) +
        (stale
          ? ' <span class="qlflag">Reprint - will print as v' + nextVersion(e) + "</span>"
          : "") +
      "</div>" +
      '<button type="button" class="qprint' + (stale ? " stale" : "") +
        '" data-match="' + esc(e.matchId) + '">' +
        (stale ? "Reprint (v" + nextVersion(e) + ")" : "Print sheet") + "</button>" +
      "</li>";
  }

  function printedRowHtml(e) {
    const who = e.issue && e.issue.snapshot
      ? e.issue.snapshot[0] + " vs " + e.issue.snapshot[1]
      : (e.names ? e.names[0] + " vs " + e.names[1] : "pairing not set");
    return '<li class="qlrow printed">' +
      '<div class="qlmain">' + esc(who) + "</div>" +
      '<div class="qlmeta">' + esc(e.label) +
        ' <span class="qlflag">next copy prints as v' + nextVersion(e) + "</span>" +
      "</div>" +
      '<div class="qlwhen">' + esc(when(e.issue && e.issue.at)) + "</div>" +
      '<span class="qlver">v' + (e.issue ? e.issue.version : 1) + "</span>" +
      '<button type="button" class="qprint" data-match="' + esc(e.matchId) + '" ' +
        'title="Print this match again (next copy prints as v' + nextVersion(e) + ')">' +
        "Print another copy (v" + nextVersion(e) + ")</button>" +
      "</li>";
  }

  // ---------- the sheets ----------

  function renderSheets(entries) {
    const box = $("#sheets");
    if (!t || !entries || !entries.length) { box.innerHTML = ""; return; }
    box.innerHTML = entries.map(sheetHtml).join("");
  }

  /** One whole paper sheet, for one bracket match. */
  function sheetHtml(e) {
    const spec = window.Sheets.spec(t.game);
    const disc = discipline(t.game);
    const balls = spec.measure === window.Sheets.BALLS;
    const names = e.names || ["", ""];
    const issue = window.SheetQueue.issue(e.match);
    return '<article class="psheet ' + (balls ? "ps-balls" : "ps-race") + '">' +
      reprintBanner(issue) +
      headerHtml(disc, e.label, names) +
      howToHtml(disc) +
      rulesHtml(disc) +
      playersHtml(names, balls, e.matchId) +
      (balls ? rackBody(spec) : tallyBody()) +
      winBlock(names) +
      '<div class="psbrand">ColumbiaCueClub.com</div>' +
      "</article>";
  }

  /** 018's stamp: this paper replaces an earlier copy of the same sheet. */
  function reprintBanner(issue) {
    if (!issue || issue.version <= 1) return "";
    return '<div class="psreprint">REPRINT - v' + issue.version + " - " + esc(issue.at) + "</div>";
  }

  function headerHtml(disc, label, names) {
    // The table number is a blank to write on. 018 asks for a pre-filled "Table {N}", but
    // the console has no table-assignment data: the tournament's tables[] is the room's list
    // of tables, not which match is on which. A wrong table number on the paper is worse
    // than a blank one, so the desk writes it in.
    return '<header class="pshead">' +
      '<div class="pstitle">' + esc(t.name || "Tournament") + "</div>" +
      '<div class="psgame">' + esc(disc.name) + "</div>" +
      '<div class="pspill">Table ________ &nbsp;&middot;&nbsp; ' + esc(label) +
        " &nbsp;&middot;&nbsp; " + esc(names[0]) + " vs " + esc(names[1]) + "</div>" +
      "</header>";
  }

  function howToHtml(disc) {
    return '<section class="pshowto">' +
      '<div class="pshowtot">HOW TO SCORE</div>' +
      "<ol>" + disc.howto.map((s) => "<li>" + esc(s) + "</li>").join("") + "</ol>" +
      '<div class="pshowtonote">Required at Columbia Cue Club tournaments. ' +
      "Mark the opponent's balls as a courtesy.</div>" +
      "</section>";
  }

  function rulesHtml(disc) {
    return '<section class="psrules">' +
      '<div class="psrulest">' + esc(disc.rulesTitle) + "</div>" +
      "<ul>" + disc.rules.map((s) => "<li>" + esc(s) + "</li>").join("") + "</ul>" +
      "</section>";
  }

  function playersHtml(names, balls, matchId) {
    return '<section class="psplayers">' +
      playerCard("A", names[0], balls, matchId) +
      playerCard("B", names[1], balls, matchId) +
      "</section>";
  }

  function playerCard(side, name, balls, matchId) {
    let goal;
    if (balls) {
      // The goal preset the tournament is played to, when it is one of the discipline's
      // own; the discipline's first preset otherwise. The OTHER box is for anything else.
      const goals = window.Sheets.goals(t.game);
      const live = window.SheetQueue.raceTo(t);
      const checked = (live != null && goals.indexOf(live) >= 0) ? live : goals[0];
      goal = '<div class="psgoal"><div class="psgoalt">PLAYER ' + side + " GOAL</div>" +
        '<div class="psgoals">' +
        goals.map((g) => goalRadio("g" + side + "-" + matchId, String(g), String(g), g === checked)).join("") +
        goalRadio("g" + side + "-" + matchId, "other", "OTHER", false) +
        "</div></div>";
    } else {
      // A race is not a goal box: the target is the tally's, printed with the tally.
      goal = '<div class="psgoal"><div class="psgoalt">RACE TO</div>' +
        '<div class="psracetarget">' + targetRace() + "</div></div>";
    }
    return '<div class="pcard"><div class="psline">PLAYER ' + side + ": <strong>" +
      esc(name) + "</strong></div>" + goal + "</div>";
  }

  function goalRadio(name, value, label, checked) {
    return "<label" + (value === "other" ? ' class="other"' : "") + ">" +
      '<input type="radio" name="' + esc(name) + '" value="' + esc(value) + '"' +
      (checked ? " checked" : "") + " /><span>" + esc(label) + "</span>" +
      (value === "other" ? '<i class="psotherbox"></i>' : "") + "</label>";
  }

  /** The tournament's race target, or the discipline's usual one when it names none. */
  function targetRace() {
    const live = window.SheetQueue.raceTo(t);
    if (live) return live;
    return RACE_DEFAULT[window.Sheets.id(t.game)] || 7;
  }

  /** The rack grid: one row per rack, the discipline's own columns, a FINAL row. */
  function rackBody(spec) {
    const rows = [];
    for (let r = 1; r <= spec.racks; r++) {
      // Both players mark the same ball numbers, so a rack carries the same grid twice:
      // one for PLAYER A, one for PLAYER B, as on the paper sheet.
      rows.push('<div class="psrack">' +
        '<div class="psrackn">' + r + "</div>" +
        sideHtml(spec) +
        sideHtml(spec) +
        "</div>");
    }
    const finalLabel = esc(spec.finalLabel || "FINAL");
    const finals =
      '<div class="psfinals">' +
        '<div class="psfinalcell"><span class="psfinalt">' + finalLabel + "</span>" +
          '<span class="psside">PLAYER A</span><i class="psblank"></i></div>' +
        '<div class="psfinalcell"><span class="psfinalt">' + finalLabel + "</span>" +
          '<span class="psside">PLAYER B</span><i class="psblank"></i></div>' +
      "</div>";
    return '<section class="psracks">' +
      '<div class="psrackhdr"><div class="psrackn">RACK</div>' +
        '<div class="psside">PLAYER A</div><div class="psside">PLAYER B</div></div>' +
      rows.join("") + finals +
      "</section>";
  }

  /** One side of one rack: the discipline's mark circles, then its columns to write in. */
  function sideHtml(spec) {
    let circles = "";
    for (let n = 1; n <= spec.ballsPerRack; n++) {
      const stripe = spec.ballFaces && n >= 9;
      circles += '<span class="psball' + (stripe ? " stripe" : "") + '">' + n + "</span>";
    }
    const stats = (spec.columns || []).map((c) =>
      '<label class="psstat"><span>' + esc(c) + '</span><i class="psblank"></i></label>'
    ).join("");
    return '<div class="psside"><div class="psballs">' + circles + "</div>" +
      '<div class="psstats">' + stats + "</div></div>";
  }

  /** The games-won body: a tally per side, drawn to the race target. */
  function tallyBody() {
    const race = targetRace();
    let boxes = "";
    for (let i = 1; i <= race; i++) boxes += '<i class="psgame">' + i + "</i>";
    const row = (side) => '<div class="pstallyrow"><span class="psnm">PLAYER ' + side +
      '</span><div class="psgames">' + boxes + "</div></div>";
    return '<section class="pstally">' +
      '<div class="pstallyhdr">RACE TO ' + race + " GAMES</div>" +
      row("A") + row("B") +
      "</section>";
  }

  function winBlock(names) {
    return '<section class="pswin">' +
      '<div class="pswinner">WINNER: <i class="psblank"></i></div>' +
      '<div class="pssigs"><span class="pssigt">SIGNATURES:</span>' +
        '<span class="pssig"><i></i> ' + esc(names[0]) + "</span>" +
        '<span class="pssig"><i></i> ' + esc(names[1]) + "</span>" +
      "</div></section>";
  }

  // ---------- printing ----------

  /**
   * Write the issue records of the sheets just printed back into the stored document.
   * Re-reads the key first and replaces only those matches' sheet fields, then writes the
   * same document back: the bracket page writes this key too and may have changed anything
   * else since this page loaded, so nothing else here is ours to write.
   */
  function writeBack(entries) {
    const r = read();
    if (!r.ok) return false;
    const stored = findTournament(r.doc, WANT.t);
    if (!stored || !stored.bracket || !stored.bracket.matches) return false;
    let wrote = 0;
    entries.forEach((e) => {
      const target = stored.bracket.matches[e.matchId];
      const rec = window.SheetQueue.issue(e.match);
      if (!target || !rec) return;
      window.SheetQueue.restore(target, rec);
      wrote++;
    });
    if (!wrote) return false;
    const ls = rawStorage();
    if (!ls) return false;
    try { ls.setItem(STORAGE_KEY, JSON.stringify(r.doc)); } catch (err) { return false; }
    return true;
  }

  /** Print these entries: record, persist, draw the sheets as issued, print, re-render. */
  function printEntries(entries) {
    if (!t || !entries || !entries.length) return;
    // (a) Record first, before the dialog: whichever way the desk leaves it, the queue and
    //     the bracket already know these sheets went out.
    entries.forEach((e) => { window.SheetQueue.mark(e.match, t); });
    // (b) Persist just those records.
    const persisted = writeBack(entries);
    // Draw the sheets from the records just made, so the paper carries this issue's version
    // and stamp - bracket.js makes every issue a new version, so a reprint says REPRINT.
    renderSheets(entries);
    // (c) Paper.
    if (typeof window.print === "function") window.print();
    // After printing, the queue is the page again. If the records could not be written back,
    // re-render from this copy rather than re-reading storage, or the marks would vanish.
    if (persisted) refresh(); else render();
  }

  function onQueueClick(ev) {
    const btn = ev.target && ev.target.closest ? ev.target.closest("button[data-match]") : null;
    if (!btn || !t) return;
    const hit = window.SheetQueue.entries(t)
      .filter((e) => e.matchId === btn.getAttribute("data-match"));
    if (!hit.length || hit[0].state === window.SheetQueue.PENDING || !hit[0].names) return;
    printEntries(hit);
  }

  // ---------- another tab wrote the console's document ----------

  function onStorage(ev) {
    if (ev && ev.key && ev.key !== STORAGE_KEY) return;
    // The bracket page saving a result changes the names that flow into a downstream match,
    // which makes its sheet a reprint here - without a reload.
    refresh();
  }

  // ---------- boot ----------

  function boot() {
    $("#printSelected").addEventListener("click", () => { printEntries(selection()); });
    $("#printRoundOne").addEventListener("click", () => { printEntries(roundOneNeeding()); });
    $("#queue").addEventListener("click", onQueueClick);
    window.addEventListener("storage", onStorage);
    refresh();
  }

  boot();
})();
