// roster.test.js — unit tests for the forgiving roster parser. Run: node roster.test.js
const R = require('./roster.js');
let pass = 0, fail = 0;
function eq(got, want, msg) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; } else { fail++; console.error('FAIL', msg, '\n  got ', g, '\n  want', w); }
}

// blank lines ignored; plain names
eq(R.parse('Ann\n\n  \nBob\n').map(r => r.name), ['Ann', 'Bob'], 'blank lines ignored');

// full comma-delimited line, any order
eq(R.parseLine('Jane Doe, 512, 503-369-9277, jane@x.com'),
  { name: 'Jane Doe', email: 'jane@x.com', phone: '503-369-9277', fargo: 512, externalId: '' }, 'comma all fields');

// fields in a different order
eq(R.parseLine('700, bob@y.com, Bob Smith, (503) 369-9277'),
  { name: 'Bob Smith', email: 'bob@y.com', phone: '(503) 369-9277', fargo: 700, externalId: '' }, 'reordered fields');

// fargo embedded in the name, parenthesized, no commas
eq(R.parseLine('John Smith (487)'),
  { name: 'John Smith', email: '', phone: '', fargo: 487, externalId: '' }, 'embedded fargo');

// bare 3-digit fargo without parens
eq(R.parseLine('Kim Lee 512').fargo, null, 'space-separated 3-digit stays in name field'); // no comma → treated as name words
eq(R.parseLine('Kim Lee, 512').fargo, 512, 'comma 3-digit is fargo');

// phone shapes: 7 / 10 / 11 digits
eq(R.parseLine('A, 3699277').phone, '3699277', '7-digit phone');
eq(R.parseLine('A, 5033699277').phone, '5033699277', '10-digit phone');
eq(R.parseLine('A, 1-503-369-9277').phone, '1-503-369-9277', '11-digit phone w/ dashes');

// other-length number → external id
eq(R.parseLine('A, 12345').externalId, '12345', '5-digit external id');
eq(R.parseLine('A, 900001').externalId, '900001', '6-digit external id');

// name-only
eq(R.parseLine('Mystery Player'), { name: 'Mystery Player', email: '', phone: '', fargo: null, externalId: '' }, 'name only');

// email lifted out of an un-delimited name field
eq(R.parseLine('Sam Ray sam@z.io').email, 'sam@z.io', 'inline email');

// a row with no name is dropped
eq(R.parse('512, 503-369-9277').length, 0, 'nameless row dropped');

console.log(pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
