/* roster.js — forgiving roster/participant text parser.
 * One player per line. Blank lines ignored. A leading bullet/number ("- ", "1. ",
 * "2) ") is stripped. A spreadsheet-style header row (all header words) is skipped.
 * Field delimiter per line is auto-detected: TAB, else ';', else ','. Each field is
 * auto-classified:
 *   - email      → looks like an address
 *   - phone      → 7 / 10 / 11 digits, with or without ()-.+ spaces
 *   - fargo      → a bare 3-digit number, with or without parentheses (512 / (512))
 *   - externalId → any other all-digits field
 *   - name       → everything left over (an embedded "(512)" and @email are lifted out)
 * Options: { lastFirst: true } treats the first two name fields as Last, First.
 * Returns [{ name, email, phone, fargo, externalId }]. Test: node roster.test.js
 */
(function (root, factory) {
  var mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod; // node/tests
  root.Roster = mod; // browser global
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  var HEADER = { name: 1, names: 1, player: 1, players: 1, roster: 1, participant: 1, participants: 1,
    fargo: 1, rating: 1, rtg: 1, phone: 1, mobile: 1, cell: 1, email: 1, e: 1, mail: 1,
    id: 1, seed: 1, first: 1, last: 1, '#': 1, no: 1, num: 1 };

  function detectDelim(line) {
    if (line.indexOf('\t') >= 0) return '\t';
    if (line.indexOf(';') >= 0) return ';';
    return ',';
  }
  function stripBullet(line) { return line.replace(/^\s*(?:\d+[.)]|[-*•])\s+/, ''); }
  function isHeaderLine(line) {
    var toks = line.toLowerCase().split(/[\t;,\s]+/).filter(Boolean);
    if (!toks.length) return false;
    for (var i = 0; i < toks.length; i++) { if (!HEADER[toks[i]]) return false; }
    return true;
  }

  // classify one field; returns a name-field string, or null if it was an attribute.
  function classifyField(field, rec) {
    var t = field.trim();
    if (!t) return null;
    if (t.indexOf('@') >= 0 && EMAIL.test(t)) { rec.email = t; return null; }
    var fm = t.match(/^\((\d{3})\)$/) || t.match(/^(\d{3})$/);
    if (fm) { rec.fargo = parseInt(fm[1], 10); return null; }
    if (/^[+()\d\s.\-]+$/.test(t)) {
      var d = t.replace(/\D/g, '');
      if (d.length === 7 || d.length === 10 || d.length === 11) { rec.phone = t; return null; }
      if (/^\d+$/.test(t)) { rec.externalId = t; return null; }
    }
    // name field — lift an embedded (512) fargo and any @email out of it
    var pf = t.match(/\((\d{3})\)/);
    if (pf) { rec.fargo = parseInt(pf[1], 10); t = t.replace(/\(\d{3}\)/, ' '); }
    var words = [];
    t.split(/\s+/).forEach(function (w) {
      if (!w) return;
      if (w.indexOf('@') >= 0 && EMAIL.test(w)) { rec.email = w; return; }
      words.push(w);
    });
    var s = words.join(' ').trim();
    return s || null;
  }

  function parseLine(line, opts) {
    opts = opts || {};
    line = stripBullet(String(line));
    var rec = { name: '', email: '', phone: '', fargo: null, externalId: '' };
    var nameFields = [];
    line.split(detectDelim(line)).forEach(function (f) {
      var s = classifyField(f, rec);
      if (s) nameFields.push(s);
    });
    if (opts.lastFirst && nameFields.length >= 2) {
      nameFields = [nameFields[1], nameFields[0]].concat(nameFields.slice(2)); // Last, First → First Last
    }
    rec.name = nameFields.join(' ').replace(/\s+/g, ' ').trim();
    return rec;
  }

  function parse(text, opts) {
    var out = [], seenContent = false;
    String(text == null ? '' : text).split(/\r?\n/).forEach(function (line) {
      if (!line.trim()) return; // blank lines ignored
      if (!seenContent && isHeaderLine(stripBullet(line))) { seenContent = true; return; } // skip a header row
      seenContent = true;
      var rec = parseLine(line, opts);
      if (rec.name) out.push(rec); // rows with no name are skipped
    });
    return out;
  }

  return { parse: parse, parseLine: parseLine };
});
