/* roster.js — forgiving roster/participant text parser.
 * One player per line. Blank lines ignored. Within a line, comma-separated fields
 * (and whitespace inside the name field) are auto-classified:
 *   - email      → a token that looks like an address
 *   - phone      → 7, 10, or 11 digits, with or without ()-.+ spaces
 *   - fargo      → a bare 3-digit number, with or without parentheses, e.g. 512 or (512)
 *   - externalId → any other all-digits token
 *   - name       → everything left over (an embedded "(512)" fargo and an @email are
 *                  lifted out of the name field too)
 * Returns [{ name, email, phone, fargo, externalId }]. Testable standalone:
 *   node roster.test.js
 */
(function (root, factory) {
  var mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod; // node/tests
  root.Roster = mod; // browser global
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function classifyField(field, rec, nameParts) {
    var t = field.trim();
    if (!t) return;
    // email
    if (t.indexOf('@') >= 0 && EMAIL.test(t)) { rec.email = t; return; }
    // fargo: exactly 3 digits, bare or parenthesized
    var fm = t.match(/^\((\d{3})\)$/) || t.match(/^(\d{3})$/);
    if (fm) { rec.fargo = parseInt(fm[1], 10); return; }
    // phone: digit/punctuation only, 7 / 10 / 11 digits total
    if (/^[+()\d\s.\-]+$/.test(t)) {
      var d = t.replace(/\D/g, '');
      if (d.length === 7 || d.length === 10 || d.length === 11) { rec.phone = t; return; }
      if (/^\d+$/.test(t)) { rec.externalId = t; return; } // other bare number → external id
    }
    // name field — lift an embedded (512) fargo and any @email out of it
    var pf = t.match(/\((\d{3})\)/);
    if (pf) { rec.fargo = parseInt(pf[1], 10); t = t.replace(/\(\d{3}\)/, ' '); }
    t.split(/\s+/).forEach(function (w) {
      if (!w) return;
      if (w.indexOf('@') >= 0 && EMAIL.test(w)) { rec.email = w; return; }
      nameParts.push(w);
    });
  }

  function parseLine(line) {
    var rec = { name: '', email: '', phone: '', fargo: null, externalId: '' };
    var nameParts = [];
    String(line).split(',').forEach(function (f) { classifyField(f, rec, nameParts); });
    rec.name = nameParts.join(' ').replace(/\s+/g, ' ').trim();
    return rec;
  }

  function parse(text) {
    var out = [];
    String(text == null ? '' : text).split(/\r?\n/).forEach(function (line) {
      if (!line.trim()) return; // ignore blank lines
      var rec = parseLine(line);
      if (rec.name) out.push(rec); // a row with no name is skipped
    });
    return out;
  }

  return { parse: parse, parseLine: parseLine };
});
