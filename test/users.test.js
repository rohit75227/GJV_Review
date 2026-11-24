/*
 * The rules the User access tab has to obey, tested without a Functions host.
 *
 * The one that matters is the last-admin guard. Losing the last active admin means
 * nobody can open the tab, and the file could then only be repaired by editing it
 * by hand on github.com - which is exactly the thing this feature exists to stop
 * people having to do. It is counted AFTER the change, so it catches a demote and a
 * deactivate and not only a delete.
 *
 * Run: node test/users.test.js
 */
'use strict';

const assert = require('assert');
const store = require('../api/src/userstore.js');

let ran = 0;
let bad = 0;
function test(name, fn) {
  ran++;
  try { fn(); console.log('PASS  ' + name); }
  catch (e) { bad++; console.log('FAIL  ' + name + '\n        ' + (e && e.message)); }
}

const COMMENT = { '//': ['what this file is'] };
const ADMIN = { email: 'boss@hudabeauty.com', name: 'Boss', role: 'admin' };
const ADMIN2 = { email: 'other.boss@hudabeauty.com', role: 'admin' };
const VIEWER = { email: 'reader@hudabeauty.com', role: 'viewer' };

/* ------------------------------------------------------------- file shape */

test('the comment block survives a rewrite', function () {
  const file = { '//': ['prose'], users: [ADMIN] };
  const shape = store.shapeOf(file);
  const next = shape.rebuild(shape.users.concat([VIEWER]));
  assert.deepStrictEqual(next['//'], ['prose']);
  assert.strictEqual(next.users.length, 2);
});

test('a bare array file is handled as well as an object one', function () {
  const shape = store.shapeOf([ADMIN]);
  assert.deepStrictEqual(shape.rebuild([ADMIN, VIEWER]), [ADMIN, VIEWER]);
});

test('an unreadable file is refused rather than treated as empty', function () {
  // Appending to "nothing" would rewrite the whole access list on the strength of a
  // failed read, and the rewrite would be a list of one.
  assert.throws(function () { store.shapeOf(undefined); }, /could not be read/);
  assert.throws(function () { store.shapeOf('not a list'); }, /could not be read/);
});

test('a comment entry is never listed as a person', function () {
  const users = store.listUsers({ users: [COMMENT, ADMIN, VIEWER] });
  assert.strictEqual(users.length, 2);
});

test('the file is serialised readably, because people read it on github.com', function () {
  const text = store.serialize({ users: [VIEWER] });
  assert.ok(text.indexOf('\n  "users"') !== -1, 'not indented');
  assert.strictEqual(text.charAt(text.length - 1), '\n', 'no trailing newline');
});

/* -------------------------------------------------------- the last admin */

test('removing the last active admin is refused', function () {
  assert.ok(store.wouldStrandAccess([VIEWER]));
  assert.strictEqual(store.wouldStrandAccess([ADMIN, VIEWER]), null);
});

test('DEMOTING the last active admin is refused, not only removing them', function () {
  const demoted = Object.assign({}, ADMIN, { role: 'viewer' });
  assert.ok(store.wouldStrandAccess([demoted, VIEWER]));
});

test('SWITCHING OFF the last active admin is refused too', function () {
  const off = Object.assign({}, ADMIN, { active: false });
  assert.ok(store.wouldStrandAccess([off, VIEWER]));
});

test('with two admins, either one may go', function () {
  assert.strictEqual(store.wouldStrandAccess([ADMIN, ADMIN2, VIEWER]), null);
  assert.strictEqual(store.wouldStrandAccess([ADMIN2, VIEWER]), null);
});

test('a comment entry is not counted as an admin', function () {
  // A "//" block has no role, so it could never be read as one; asserted anyway,
  // because the guard counting a comment as an admin would disarm it silently.
  assert.ok(store.wouldStrandAccess([COMMENT, VIEWER]));
});

test('the refusal is a sentence somebody can act on', function () {
  const msg = store.wouldStrandAccess([VIEWER]);
  assert.ok(/no active admin/i.test(msg));
  assert.ok(/somebody else an admin first/i.test(msg));
});

/* --------------------------------------------------------- normalisation */

test('a hand-edited entry with no role reads as a viewer', function () {
  const u = store.publicUser({ email: 'Someone@HudaBeauty.com' });
  assert.deepStrictEqual(
    { email: u.email, role: u.role, active: u.active },
    { email: 'someone@hudabeauty.com', role: 'viewer', active: true });
});

test('active:false and the string "false" both mean switched off', function () {
  assert.strictEqual(store.publicUser({ email: 'a@b.com', active: false }).active, false);
  assert.strictEqual(store.publicUser({ email: 'a@b.com', active: 'false' }).active, false);
  assert.strictEqual(store.publicUser({ email: 'a@b.com' }).active, true);
});

test('role is matched whatever its casing', function () {
  assert.strictEqual(store.publicUser({ email: 'a@b.com', role: 'Admin' }).role, 'admin');
  assert.strictEqual(store.isAdminEntry({ role: ' ADMIN ' }), true);
});

test('the legacy "added" field is read as addedAt', function () {
  assert.strictEqual(store.publicUser({ email: 'a@b.com', added: '2026-09-03' }).addedAt,
    '2026-09-03');
});

console.log('\n' + (bad ? bad + ' of ' + ran + ' checks FAILED' : 'all ' + ran + ' checks passed'));
process.exit(bad ? 1 : 0);
