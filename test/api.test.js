/*
 * Drives the three HTTP functions for real.
 *
 * test/access.test.js pins the DECISIONS; this pins the PLUMBING around them, which
 * is where the mistakes that matter are easy to make: an admin check on the wrong
 * side of a read, a stale role in the session header being trusted, a 403 that
 * returns the list in its body anyway.
 *
 * It runs the real handlers. @azure/functions' app.http() is stubbed to capture the
 * handler rather than register it, and api/src/github.js is stubbed with an in-memory
 * file so nothing here touches the network or the repository. Everything between
 * those two ends - principal.js, list.js, access.js, userstore.js - is the shipped
 * code.
 *
 * Needs api/node_modules (npm install --prefix api). Skips itself with a message
 * rather than failing when the module is absent.
 *
 * Run: node test/api.test.js
 */
'use strict';
const assert = require('assert');
const Module = require('module');
const path = require('path');
const fs = require('fs');

const API = path.join(__dirname, '..', 'api', 'src');

try {
  require(path.join(__dirname, '..', 'api', 'node_modules', '@azure', 'functions'));
} catch (e) {
  console.log('api tests SKIPPED: @azure/functions is not installed '
    + '(npm install --prefix api)');
  process.exit(0);
}

/* Named as a precondition rather than left to surface as a pile of empty lists,
   which is what a missing staging step actually looks like. */
if (!fs.existsSync(path.join(API, 'allowlist.json'))) {
  console.error('api tests CANNOT RUN: api/src/allowlist.json is not staged. '
    + 'Run ./build/stage_allowlist.sh first.');
  process.exit(1);
}

/* ---------------------------------------------------------------- the stubs */

const handlers = {};
const listFile = { value: null, text: null, sha: 'sha-1', writes: [], failWith: null };

function resetList(users) {
  listFile.value = { '//': ['a note that must survive'], users: users };
  listFile.text = JSON.stringify(listFile.value, null, 2);
  listFile.writes = [];
  listFile.failWith = null;
}

const githubStub = {
  LIST_PATH: 'access/allowed_users.json',
  async readFile() {
    if (listFile.failWith) throw new Error(listFile.failWith);
    return { text: listFile.text, value: JSON.parse(listFile.text), sha: listFile.sha };
  },
  async mutateFile(p, mutate, serialize, message) {
    if (listFile.failWith) throw new Error(listFile.failWith);
    const next = mutate(JSON.parse(listFile.text));
    listFile.text = serialize(next);
    listFile.value = next;
    listFile.writes.push(message);
    return { value: next };
  },
  async putFile() { throw new Error('not used'); },
  repo() { return 'HUD4BEAUTY/hb-pulse-trial-balance'; },
  branch() { return 'main'; },
  headers() { return {}; },
};

/* Intercept require() for the module that would reach the network, and for
   @azure/functions so app.http hands us the handler instead of registering it. */
const realLoad = Module._load;
Module._load = function (request, parent) {
  if (request === '@azure/functions') {
    return { app: { http(name, opts) { handlers[name] = opts.handler; } } };
  }
  if (parent && parent.filename && parent.filename.indexOf(API) === 0) {
    if (request === './github' || request === '../github') return githubStub;
  }
  return realLoad.apply(this, arguments);
};

require(path.join(API, 'functions', 'GetRoles.js'));
require(path.join(API, 'functions', 'me.js'));
require(path.join(API, 'functions', 'users.js'));
const { clearCache } = require(path.join(API, 'list.js'));

Module._load = realLoad;

/* ---------------------------------------------------------------- harness */

let failed = 0;
const results = [];
async function check(name, fn) {
  try { await fn(); results.push('  ok   ' + name); }
  catch (e) { failed++; results.push('  FAIL ' + name + '\n        ' + e.message); }
}

const ctx = { log() {} };

/* A request as the platform delivers it: the identity in a base64 header, which the
   browser cannot forge, plus whatever roles the session happens to carry. The roles
   are deliberately WRONG in several tests below, to prove nothing reads them. */
function req(email, opts) {
  opts = opts || {};
  const principal = email ? Buffer.from(JSON.stringify({
    identityProvider: 'aad', userId: 'x', userDetails: email,
    userRoles: opts.roles || ['anonymous', 'authenticated'],
  })).toString('base64') : null;
  const headers = new Map();
  if (principal) headers.set('x-ms-client-principal', principal);
  return {
    method: opts.method || 'GET',
    params: opts.params || {},
    headers: { get: k => headers.get(String(k).toLowerCase()) || null },
    json: async () => (opts.body === undefined ? {} : opts.body),
  };
}

const call = (name, request) => handlers[name](request, ctx);
const body = res => (res.jsonBody !== undefined ? res.jsonBody : JSON.parse(res.body));

const ADMIN = { email: 'boss@hudabeauty.com', name: 'Boss', role: 'admin' };
const ADMIN2 = { email: 'second.boss@hudabeauty.com', name: 'Second', role: 'admin' };
const VIEWER = { email: 'reader@hudabeauty.com', name: 'Reader', role: 'viewer' };
const OFF = { email: 'gone@hudabeauty.com', role: 'viewer', active: false };
const STRANGER = 'nobody@hudabeauty.com';

function seed(users) { resetList(users || [ADMIN, ADMIN2, VIEWER, OFF]); clearCache(); }

/* Seed the list and then read it once, so api/src/list.js holds it in its ten second
   cache the way it would after any page load. That is what the three "GitHub has
   gone away" tests below need: a signed-in admin whose entitlement was resolved
   while the list was readable, meeting a failure on the NEXT call. Without the
   priming read they would only be testing that an unknown address is refused, which
   is the test immediately after them. */
async function prime() {
  seed();
  await call('me', req(ADMIN.email));
}

(async function main() {
  /* ------------------------------------------------------------------ /api/me */
  seed();

  await check('me: a viewer reads the report and is not an admin', async () => {
    const b = body(await call('me', req(VIEWER.email)));
    assert.strictEqual(b.access, 'full');
    assert.strictEqual(b.admin, false);
    assert.strictEqual(b.listed, true);
  });

  await check('me: an admin is an admin', async () => {
    const b = body(await call('me', req(ADMIN.email)));
    assert.strictEqual(b.access, 'full');
    assert.strictEqual(b.admin, true);
  });

  await check('me: somebody switched off is listed but has no access', async () => {
    const b = body(await call('me', req(OFF.email)));
    assert.strictEqual(b.access, 'none');
    assert.strictEqual(b.listed, true);
    assert.strictEqual(b.active, false);
  });

  await check('me: somebody never added is not listed and has no access', async () => {
    const b = body(await call('me', req(STRANGER)));
    assert.strictEqual(b.access, 'none');
    assert.strictEqual(b.listed, false);
  });

  await check('me: nobody signed in is told so rather than erroring', async () => {
    const b = body(await call('me', req(null)));
    assert.strictEqual(b.signedIn, false);
    assert.strictEqual(b.admin, false);
  });

  await check('me: it says where the answer came from', async () => {
    assert.strictEqual(body(await call('me', req(VIEWER.email))).listSource, 'live');
  });

  /* THE POINT OF /api/me. Roles are minted at sign-in and live in the session for
     hours; the answer must come from the list as it stands now. */
  await check('me: a stale tb_admin role in the session is ignored', async () => {
    const b = body(await call('me', req(VIEWER.email, { roles: ['reader', 'tb_admin'] })));
    assert.strictEqual(b.admin, false);
  });

  /* ------------------------------------------------------------ /api/GetRoles */

  await check('GetRoles: grants reader to a viewer and tb_admin to an admin', async () => {
    const viewer = body(await call('GetRoles', { json: async () => ({
      identityProvider: 'aad', userDetails: VIEWER.email }) }));
    assert.deepStrictEqual(viewer.roles, ['reader']);
    const admin = body(await call('GetRoles', { json: async () => ({
      identityProvider: 'aad', userDetails: ADMIN.email }) }));
    assert.deepStrictEqual(admin.roles, ['reader', 'tb_admin']);
  });

  await check('GetRoles: grants nothing to somebody not on the list', async () => {
    const r = body(await call('GetRoles', { json: async () => ({
      identityProvider: 'aad', userDetails: STRANGER }) }));
    assert.deepStrictEqual(r.roles, []);
  });

  await check('GetRoles: an unreadable body grants nothing rather than throwing', async () => {
    const r = body(await call('GetRoles', { json: async () => { throw new Error('nope'); } }));
    assert.deepStrictEqual(r.roles, []);
  });

  /* --------------------------------------------------------------- /api/users */

  await check('users: a viewer is refused, and gets no list in the body', async () => {
    seed();
    const r = await call('users', req(VIEWER.email));
    assert.strictEqual(r.status, 403);
    assert.ok(!body(r).users, 'a refusal returned the access list anyway');
  });

  await check('users: a viewer with a stale admin role in the session is still refused',
    async () => {
      seed();
      const r = await call('users', req(VIEWER.email, { roles: ['reader', 'tb_admin'] }));
      assert.strictEqual(r.status, 403);
    });

  await check('users: nobody signed in gets 401, not 403', async () => {
    const r = await call('users', req(null));
    assert.strictEqual(r.status, 401);
  });

  await check('users: an admin reads the list', async () => {
    seed();
    const b = body(await call('users', req(ADMIN.email)));
    assert.strictEqual(b.users.length, 4);
    assert.strictEqual(b.writable, true);
    assert.ok(b.users.every(u => u.email && u.role), 'a record came back unnormalised');
  });

  await check('users: adding somebody writes them as an active viewer', async () => {
    seed();
    const r = await call('users', req(ADMIN.email, {
      method: 'POST', body: { email: 'New.Person@HudaBeauty.com', name: 'New Person' } }));
    assert.strictEqual(r.status, 201);
    const added = body(r);
    assert.strictEqual(added.email, 'new.person@hudabeauty.com');
    assert.strictEqual(added.role, 'viewer');
    assert.strictEqual(added.active, true);
    assert.strictEqual(listFile.value.users.length, 5);
    assert.strictEqual(listFile.value.users[4].addedBy, ADMIN.email);
    assert.deepStrictEqual(listFile.value['//'], ['a note that must survive']);
  });

  await check('users: adding somebody as an admin is one call', async () => {
    seed();
    const b = body(await call('users', req(ADMIN.email, {
      method: 'POST', body: { email: 'boss3@hudabeauty.com', role: 'admin' } })));
    assert.strictEqual(b.role, 'admin');
  });

  await check('users: adding a bad address is refused with a sentence', async () => {
    seed();
    const r = await call('users', req(ADMIN.email, {
      method: 'POST', body: { email: 'not-an-address' } }));
    assert.strictEqual(r.status, 400);
    assert.ok(/valid email/i.test(body(r).error));
    assert.strictEqual(listFile.writes.length, 0, 'a refused add wrote to the file');
  });

  await check('users: adding somebody already listed is a 409, not a duplicate', async () => {
    seed();
    const r = await call('users', req(ADMIN.email, {
      method: 'POST', body: { email: VIEWER.email } }));
    assert.strictEqual(r.status, 409);
    assert.strictEqual(listFile.value.users.length, 4);
  });

  await check('users: an unknown role is refused before anything is written', async () => {
    seed();
    const r = await call('users', req(ADMIN.email, {
      method: 'POST', body: { email: 'x@hudabeauty.com', role: 'superuser' } }));
    assert.strictEqual(r.status, 400);
    assert.strictEqual(listFile.writes.length, 0);
  });

  await check('users: promoting and demoting are PATCHes on the role alone', async () => {
    seed();
    const up = body(await call('users', req(ADMIN.email, {
      method: 'PATCH', params: { email: VIEWER.email }, body: { role: 'admin' } })));
    assert.strictEqual(up.role, 'admin');
    const down = body(await call('users', req(ADMIN.email, {
      method: 'PATCH', params: { email: VIEWER.email }, body: { role: 'viewer' } })));
    assert.strictEqual(down.role, 'viewer');
  });

  await check('users: switching somebody off keeps the record', async () => {
    seed();
    const b = body(await call('users', req(ADMIN.email, {
      method: 'PATCH', params: { email: VIEWER.email }, body: { active: false } })));
    assert.strictEqual(b.active, false);
    assert.strictEqual(listFile.value.users.length, 4);
  });

  await check('users: a PATCH records who made it and when', async () => {
    seed();
    await call('users', req(ADMIN.email, {
      method: 'PATCH', params: { email: VIEWER.email }, body: { name: 'Renamed' } }));
    const row = listFile.value.users.filter(u => u.email === VIEWER.email)[0];
    assert.strictEqual(row.updatedBy, ADMIN.email);
    assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(row.updatedAt));
  });

  await check('users: patching somebody not on the list is a 404', async () => {
    seed();
    const r = await call('users', req(ADMIN.email, {
      method: 'PATCH', params: { email: STRANGER }, body: { role: 'admin' } }));
    assert.strictEqual(r.status, 404);
  });

  await check('users: removing somebody removes exactly them', async () => {
    seed();
    const r = await call('users', req(ADMIN.email, {
      method: 'DELETE', params: { email: VIEWER.email } }));
    assert.strictEqual(r.status, 204);
    assert.strictEqual(listFile.value.users.length, 3);
    assert.ok(!listFile.value.users.some(u => u.email === VIEWER.email));
  });

  /* THE GUARD. Three ways to reach the same stranding, all refused after the change
     is applied rather than before it. */
  await check('users: the last admin cannot be removed', async () => {
    seed([ADMIN, VIEWER]);
    const r = await call('users', req(ADMIN.email, {
      method: 'DELETE', params: { email: ADMIN.email } }));
    assert.strictEqual(r.status, 409);
    assert.strictEqual(listFile.value.users.length, 2);
  });

  await check('users: the last admin cannot be DEMOTED', async () => {
    seed([ADMIN, VIEWER]);
    const r = await call('users', req(ADMIN.email, {
      method: 'PATCH', params: { email: ADMIN.email }, body: { role: 'viewer' } }));
    assert.strictEqual(r.status, 409);
    assert.ok(/no active admin/i.test(body(r).error));
  });

  await check('users: the last admin cannot be SWITCHED OFF', async () => {
    seed([ADMIN, VIEWER]);
    const r = await call('users', req(ADMIN.email, {
      method: 'PATCH', params: { email: ADMIN.email }, body: { active: false } }));
    assert.strictEqual(r.status, 409);
  });

  await check('users: with two admins, one of them may go', async () => {
    seed([ADMIN, ADMIN2, VIEWER]);
    const r = await call('users', req(ADMIN.email, {
      method: 'DELETE', params: { email: ADMIN2.email } }));
    assert.strictEqual(r.status, 204);
  });

  /* ------------------------------------------- degrading without a GitHub token */

  await check('users: with no token the list still READS, flagged read-only', async () => {
    await prime();
    listFile.failWith = 'GITHUB_TOKEN is not set';
    const b = body(await call('users', req(ADMIN.email)));
    assert.ok(b.users.length, 'the tab was given nothing to show');
    assert.strictEqual(b.writable, false);
    assert.ok(/token has not been installed/i.test(b.notice));
    assert.strictEqual(b.listSource, 'staged');
  });

  await check('users: with no token a WRITE is a clear 503, not a bare 502', async () => {
    await prime();
    listFile.failWith = 'GITHUB_TOKEN is not set';
    const r = await call('users', req(ADMIN.email, {
      method: 'POST', body: { email: 'x@hudabeauty.com' } }));
    assert.strictEqual(r.status, 503);
    assert.ok(/token has not been installed/i.test(body(r).error));
  });

  await check('users: any OTHER read failure is still a loud failure', async () => {
    await prime();
    listFile.failWith = 'GitHub read failed: 500 boom';
    const b = body(await call('users', req(ADMIN.email)));
    assert.strictEqual(b.writable, false);
    assert.ok(/could not be reached/i.test(b.notice), 'an outage read as "not set up"');
  });

  /* The list is unreadable AND the session says admin. The staged bundle copy is
     what answers, and it must not admit somebody the committed list does not. */
  await check('users: a stranger is refused even when the live list is unreadable',
    async () => {
      seed();
      clearCache();
      listFile.failWith = 'GitHub read failed: 500 boom';
      const r = await call('users', req(STRANGER, { roles: ['reader', 'tb_admin'] }));
      assert.strictEqual(r.status, 403);
    });

  console.log(results.join('\n'));
  console.log('\n' + (failed ? failed + ' check(s) FAILED' : 'all checks passed'));
  process.exit(failed ? 1 : 0);
})();
