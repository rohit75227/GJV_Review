/*
 * The access boundary: who is let into the Consolidated Trial Balance, and with
 * which roles.
 *
 * This is the file that decides whether the group's general ledgers are visible to
 * one named list of people or to the ~1,189 B2B guests who also hold an
 * @hudabeauty.com UPN, so it is tested directly rather than through the HTTP layer.
 *
 * THE FIXTURE TRAP, inherited from Spend Prism and worth not repeating. Its "a listed
 * person" fixture was once shirish@hudabeauty.com, who is also the break-glass admin,
 * so five assertions - including "an empty list grants nobody" - quietly tested the
 * hardcode instead of the list and would have passed with the list ignored entirely.
 * Never use a BREAK_GLASS_ADMINS address as anything but the break-glass fixture.
 *
 * Run: node test/access.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const A = require('../api/src/access.js');

const ROOT = path.join(__dirname, '..');

let ran = 0;
let bad = 0;
function test(name, fn) {
  ran++;
  try {
    fn();
    console.log('PASS  ' + name);
  } catch (e) {
    bad++;
    console.log('FAIL  ' + name + '\n        ' + (e && e.message));
  }
}

/* A signed-in Entra caller, shaped the way Static Web Apps posts it to GetRoles. */
function aad(email, extra) {
  return Object.assign({
    identityProvider: 'aad',
    userId: 'x',
    userDetails: email,
    claims: [{ typ: 'preferred_username', val: email }],
  }, extra || {});
}

const LISTED = 'listed.person@hudabeauty.com';
const ADMIN = 'listed.admin@hudabeauty.com';
const OFF = 'switched.off@hudabeauty.com';

const LIST = A.parseAccessList(JSON.stringify({
  users: [
    { '//': 'a comment entry, which is prose and not a person' },
    { email: LISTED, name: 'A Viewer', role: 'viewer' },
    { email: ADMIN, name: 'An Admin', role: 'admin' },
    { email: OFF, name: 'Gone', role: 'viewer', active: false },
  ],
}));

/* ------------------------------------------------------------------ parsing */

test('the comment block is prose, not a person', function () {
  assert.strictEqual(LIST.length, 3);
  assert.deepStrictEqual(LIST.map(function (u) { return u.email; }),
    [LISTED, ADMIN, OFF]);
});

test('a missing role means viewer', function () {
  const l = A.parseAccessList(JSON.stringify({ users: [{ email: LISTED }] }));
  assert.strictEqual(l[0].role, 'viewer');
  assert.strictEqual(l[0].active, true);
});

test('a bare address in the file is a viewer', function () {
  const l = A.parseAccessList(JSON.stringify([LISTED]));
  assert.strictEqual(l[0].email, LISTED);
  assert.strictEqual(l[0].role, 'viewer');
});

test('addresses are lower-cased and matched case-insensitively', function () {
  const l = A.parseAccessList(JSON.stringify({ users: [{ email: 'Listed.Person@HudaBeauty.com' }] }));
  assert.strictEqual(l[0].email, LISTED);
  assert.ok(A.findRecord('LISTED.PERSON@hudabeauty.com', l));
});

test('an unknown role is refused rather than guessed', function () {
  assert.throws(function () {
    A.parseAccessList(JSON.stringify({ users: [{ email: LISTED, role: 'superuser' }] }));
  }, /admin.*viewer/i);
});

test('an entry with no email is refused', function () {
  assert.throws(function () {
    A.parseAccessList(JSON.stringify({ users: [{ name: 'Nobody' }] }));
  }, /no "email"/);
});

test('a file with no users key is refused', function () {
  assert.throws(function () { A.parseAccessList('{"people":[]}'); }, /no "users" key/);
});

test('the first entry for an address wins', function () {
  const l = A.parseAccessList(JSON.stringify({
    users: [{ email: LISTED, role: 'viewer' }, { email: LISTED, role: 'admin' }],
  }));
  assert.strictEqual(l.length, 1);
  assert.strictEqual(l[0].role, 'viewer');
});

/* ------------------------------------------------------------------- roles */

test('a listed viewer gets reader and nothing else', function () {
  assert.deepStrictEqual(A.rolesFor(aad(LISTED), LIST), ['reader']);
});

test('a listed admin gets reader and tb_admin', function () {
  assert.deepStrictEqual(A.rolesFor(aad(ADMIN), LIST), ['reader', 'tb_admin']);
});

test('somebody switched off gets nothing', function () {
  assert.deepStrictEqual(A.rolesFor(aad(OFF), LIST), []);
});

test('an unlisted tenant account gets nothing', function () {
  assert.deepStrictEqual(A.rolesFor(aad('someone.else@hudabeauty.com'), LIST), []);
});

test('an empty list grants nobody', function () {
  assert.deepStrictEqual(A.rolesFor(aad(LISTED), []), []);
  assert.deepStrictEqual(A.rolesFor(aad(ADMIN), []), []);
});

test('a non-Entra provider is refused even when the address is listed', function () {
  const body = aad(ADMIN);
  body.identityProvider = 'github';
  assert.deepStrictEqual(A.rolesFor(body, LIST), []);
});

test('garbage in grants nothing rather than throwing', function () {
  assert.deepStrictEqual(A.rolesFor(null, LIST), []);
  assert.deepStrictEqual(A.rolesFor(aad(''), LIST), []);
  assert.deepStrictEqual(A.rolesFor({ identityProvider: 'aad' }, LIST), []);
});

test('a guest UPN is matched on the real address it was minted from', function () {
  const guest = A.parseAccessList(JSON.stringify({ users: [{ email: 'shazad@harrods.com' }] }));
  assert.deepStrictEqual(
    A.rolesFor(aad('shazad_harrods.com#EXT#@hudabeauty.com'), guest), ['reader']);
  // and admitting that one guest must not admit their domain
  assert.deepStrictEqual(
    A.rolesFor(aad('someone_harrods.com#EXT#@hudabeauty.com'), guest), []);
});

test('the upn claim is read when userDetails is something else', function () {
  assert.deepStrictEqual(A.rolesFor({
    identityProvider: 'aad',
    userDetails: 'a-guid-not-an-address',
    claims: [{ typ: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn', val: ADMIN }],
  }, LIST), ['reader', 'tb_admin']);
});

/* ------------------------------------------------------------- break glass */

test('the break-glass admin is an admin with no list at all', function () {
  const bg = A.BREAK_GLASS_ADMINS[0];
  assert.deepStrictEqual(A.rolesFor(aad(bg), []), ['reader', 'tb_admin']);
});

test('the break-glass admin survives being demoted in the list', function () {
  const bg = A.BREAK_GLASS_ADMINS[0];
  const demoted = A.parseAccessList(JSON.stringify({
    users: [{ email: bg, role: 'viewer', active: false }],
  }));
  assert.deepStrictEqual(A.rolesFor(aad(bg), demoted), ['reader', 'tb_admin']);
});

test('the break-glass address from a GitHub login is still refused', function () {
  const body = aad(A.BREAK_GLASS_ADMINS[0]);
  body.identityProvider = 'github';
  assert.deepStrictEqual(A.rolesFor(body, []), []);
});

test('break glass is one named person, not a domain or a pattern', function () {
  assert.strictEqual(A.BREAK_GLASS_ADMINS.length, 1);
  A.BREAK_GLASS_ADMINS.forEach(function (a) {
    assert.ok(/^[^@*]+@hudabeauty\.com$/.test(a), a + ' is not one plain address');
  });
});

/* -------------------------------------------------------- the shipped list */

test('the committed access list parses and admits somebody', function () {
  const text = fs.readFileSync(path.join(ROOT, 'access/allowed_users.json'), 'utf8');
  const live = A.parseAccessList(text).filter(function (u) { return u.active; });
  assert.ok(live.length, 'the committed list admits nobody');
  assert.ok(live.some(function (u) { return u.role === 'admin'; }),
    'the committed list names no active admin, so nobody could manage access in the app');
});

test('the staged copy in the bundle is identical to the committed list', function () {
  const staged = path.join(ROOT, 'api/src/allowlist.json');
  if (!fs.existsSync(staged)) {
    // Generated by build/stage_allowlist.sh at deploy; skipping is honest, and the
    // deploy workflow stages before it runs the tests.
    console.log('      (skipped: api/src/allowlist.json has not been staged)');
    return;
  }
  assert.strictEqual(
    fs.readFileSync(staged, 'utf8'),
    fs.readFileSync(path.join(ROOT, 'access/allowed_users.json'), 'utf8'),
    'api/src/allowlist.json has drifted from access/allowed_users.json');
});

/* ------------------------------------------- the config the platform enforces */

test('every route names a role, and rolesSource exists to grant it', function () {
  const cfg = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'site/staticwebapp.config.json'), 'utf8'));
  // Naming a custom role in allowedRoles does nothing on its own: without
  // auth.rolesSource, Static Web Apps never calls the function, the role is held by
  // NOBODY, and every route requiring it refuses EVERYONE - which from outside is
  // indistinguishable from a working lockdown.
  assert.strictEqual(cfg.auth.rolesSource, '/api/GetRoles');
  const BUILTIN = { anonymous: 1, authenticated: 1 };
  const custom = {};
  cfg.routes.forEach(function (r) {
    (r.allowedRoles || []).forEach(function (n) { if (!BUILTIN[n]) custom[n] = 1; });
  });
  assert.deepStrictEqual(Object.keys(custom).sort(), ['reader', 'tb_admin']);

  const byRoute = {};
  cfg.routes.forEach(function (r) { if (!byRoute[r.route]) byRoute[r.route] = r; });

  // The report itself, and the data behind it, are reader-only.
  ['/', '/index.html', '/data/*', '/*'].forEach(function (p) {
    assert.deepStrictEqual(byRoute[p].allowedRoles, ['reader'], p + ' is not reader-only');
  });
  // The access list is admin-only, on both the collection and the item route.
  ['/api/users', '/api/users/*'].forEach(function (p) {
    assert.deepStrictEqual(byRoute[p].allowedRoles, ['tb_admin'], p + ' is not admin-only');
  });
  // A refused person has to be able to read the page that tells them so, and to
  // sign out and switch account.
  assert.ok(byRoute['/403.html'].allowedRoles.indexOf('anonymous') !== -1);
  assert.ok(byRoute['/.auth/*'].allowedRoles.indexOf('anonymous') !== -1);
  // Static Web Apps ships GitHub and X login routes that mint the same roles, and
  // they are 404'd ABOVE the rule that opens /.auth/*, because routes are
  // first-match-wins.
  const order = cfg.routes.map(function (r) { return r.route; });
  assert.ok(order.indexOf('/.auth/login/github') < order.indexOf('/.auth/*'));
  assert.ok(order.indexOf('/.auth/login/twitter') < order.indexOf('/.auth/*'));
  assert.strictEqual(byRoute['/.auth/login/github'].statusCode, 404);
  assert.strictEqual(byRoute['/.auth/login/twitter'].statusCode, 404);
  // A 403 must land on a page that explains itself, not on a bare platform error.
  assert.strictEqual(cfg.responseOverrides['403'].rewrite, '/403.html');
  // THE REGRESSION THIS FILE INHERITS: /data/* caught by navigationFallback turns a
  // missing period's 404 into index.html with a 200 on it, and the report reads that
  // as "every account opens at zero".
  assert.ok(cfg.navigationFallback.exclude.indexOf('/data/*') !== -1);
});

console.log('\n' + (bad ? bad + ' of ' + ran + ' checks FAILED' : 'all ' + ran + ' checks passed'));
process.exit(bad ? 1 : 0);
