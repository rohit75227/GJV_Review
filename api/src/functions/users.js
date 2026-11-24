/*
 * /api/users  -  who may open the GJV Journal Register
 *
 *   GET    /api/users          the list
 *   POST   /api/users          add a person
 *   PATCH  /api/users/{email}  change role, name or active
 *   DELETE /api/users/{email}  remove a person
 *
 * The list lives in access/allowed_users.json in this repository, written through the
 * GitHub Contents API. It is the same file an admin can still edit by hand on
 * github.com, and it means exactly the same thing either way.
 *
 * Every method is checked against the caller's own LIVE entitlement, resolved from
 * the list on this request rather than read out of the session header. The page hides
 * this tab from non-admins, but that is presentation; this is the part that actually
 * refuses, and it refuses the same way whether the call came from the page or from
 * curl with a stolen session.
 *
 * The rules being enforced live in api/src/userstore.js, where they are unit-tested
 * without a Functions host.
 *
 * Emails are matched and stored lower-cased. Azure hands back whatever casing the
 * directory holds, and nobody typing an address in here should have to match it.
 */
'use strict';

const { app } = require('@azure/functions');
const { resolve } = require('../principal');
const { normaliseRole } = require('../access');
const { LIST_PATH, readFile, mutateFile } = require('../github');
const { clearCache, accessList } = require('../list');
const store = require('../userstore');

/* A thrown validation message is the caller's fault and gets a 400 with the message
   shown to them; anything else is the store's fault and gets a generic 502. */
function badRequest(message, headers) {
  return { status: 400, headers: headers, jsonBody: { error: message } };
}

const NO_TOKEN = /GITHUB_TOKEN is not set|GITHUB_REPO is not set/;

app.http('users', {
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  authLevel: 'anonymous',   // the platform's Easy Auth gate covers /api/*
  route: 'users/{email?}',
  handler: async (request, context) => {
    const noStore = { 'Cache-Control': 'no-store' };
    const who = await resolve(request);

    if (!who.signedIn) {
      return { status: 401, headers: noStore, jsonBody: { error: 'Sign-in required.' } };
    }
    if (!who.admin) {
      context.log('users: refused %s for %s, not an admin', request.method, who.email);
      return {
        status: 403, headers: noStore,
        jsonBody: { error: 'Managing access needs the admin role.' },
      };
    }

    try {
      if (request.method === 'GET') {
        /* Reading must survive what writing cannot. With no GitHub token, or with
           GitHub unreachable, the tab still shows who has access - from the copy
           staged into this bundle - and says plainly that it cannot change it.
           Returning an error for a read instead would make a token that quietly
           expired look like the access list itself had broken. */
        let users;
        let writable = true;
        let notice = '';
        try {
          const { value } = await readFile(LIST_PATH);
          users = store.listUsers(value).map(store.publicUser);
        } catch (e) {
          writable = false;
          users = (await accessList()).list.map(store.publicUser);
          notice = NO_TOKEN.test(e.message || '')
            ? 'Changes cannot be saved from here yet: this report\'s GitHub token has '
              + 'not been installed. Access can still be changed in the repository, in '
              + 'access/allowed_users.json.'
            : 'Changes cannot be saved right now: the access list could not be reached. '
              + 'This is the list as it stood at the last deploy.';
        }
        return {
          status: 200, headers: noStore,
          jsonBody: {
            users: users,
            // Whether a change made here would take effect at once or wait for the
            // deploy, and whether it can be made at all. See api/src/list.js.
            listSource: writable ? who.source : 'staged',
            writable: writable,
            notice: notice,
          },
        };
      }

      let body = {};
      if (request.method === 'POST' || request.method === 'PATCH') {
        try {
          body = (await request.json()) || {};
        } catch (e) {
          return badRequest('Body must be JSON.', noStore);
        }
      }

      /* ------------------------------------------------------------------ add */
      if (request.method === 'POST') {
        const email = store.normEmail(body.email);
        if (!email || email.indexOf('@') <= 0 || email.charAt(email.length - 1) === '@') {
          return badRequest('A valid email address is required.', noStore);
        }

        let role;
        try {
          role = normaliseRole(body.role);
        } catch (e) {
          return badRequest(e.message, noStore);
        }

        const added = {
          email: email,
          name: body.name ? String(body.name).trim().slice(0, 120) : '',
          role: role,
          active: true,
          addedBy: who.email,
          addedAt: new Date().toISOString(),
        };

        await mutateFile(LIST_PATH, function (value) {
          const shape = store.shapeOf(value);
          if (shape.users.some(function (u) { return store.normEmail(u.email) === email; })) {
            const err = new Error('exists');
            err.conflict = 'That person is already on the list. Change their access instead.';
            throw err;
          }
          return shape.rebuild(shape.users.concat([added]));
        }, store.serialize, 'GJV journal register access granted to ' + email);

        clearCache();
        context.log('users: %s added %s as %s', who.email, email, role);
        return { status: 201, headers: noStore, jsonBody: store.publicUser(added) };
      }

      const target = store.normEmail(request.params.email);
      if (!target) {
        return badRequest('Which person? The email address is missing from the URL.', noStore);
      }

      /* --------------------------------------------------------------- change */
      if (request.method === 'PATCH') {
        // Read first so the change can be refused with a useful sentence. The write
        // below re-reads and re-applies anyway, so this costs a round trip and buys
        // a real error message.
        const current = await readFile(LIST_PATH);
        const before = store.listUsers(current.value)
          .filter(function (u) { return store.normEmail(u.email) === target; })[0];
        if (!before) {
          return {
            status: 404, headers: noStore,
            jsonBody: { error: 'That person is not on the list.' },
          };
        }

        const fields = {};
        try {
          if (body.role != null) fields.role = normaliseRole(body.role);
        } catch (e) {
          return badRequest(e.message, noStore);
        }
        if (body.name != null) fields.name = String(body.name).trim().slice(0, 120);
        if (body.active != null) {
          fields.active = body.active !== false && body.active !== 'false';
        }

        let updated = null;
        await mutateFile(LIST_PATH, function (value) {
          const shape = store.shapeOf(value);
          const i = shape.users.findIndex(function (u) {
            return store.normEmail(u.email) === target;
          });
          if (i === -1) {
            const err = new Error('not found');
            err.notFound = true;
            throw err;
          }
          const next = shape.users.slice();
          next[i] = Object.assign({}, next[i], fields,
            { updatedBy: who.email, updatedAt: new Date().toISOString() });

          const stranded = store.wouldStrandAccess(next);
          if (stranded) {
            const err = new Error('last admin');
            err.conflict = stranded;
            throw err;
          }
          updated = next[i];
          return shape.rebuild(next);
        }, store.serialize, 'GJV journal register access updated for ' + target);

        clearCache();
        context.log('users: %s updated %s', who.email, target);
        return { status: 200, headers: noStore, jsonBody: store.publicUser(updated) };
      }

      /* --------------------------------------------------------------- remove */
      if (request.method === 'DELETE') {
        await mutateFile(LIST_PATH, function (value) {
          const shape = store.shapeOf(value);
          const next = shape.users.filter(function (u) {
            return store.normEmail(u.email) !== target;
          });
          if (next.length === shape.users.length) {
            const err = new Error('not found');
            err.notFound = true;
            throw err;
          }
          const stranded = store.wouldStrandAccess(next);
          if (stranded) {
            const err = new Error('last admin');
            err.conflict = stranded;
            throw err;
          }
          return shape.rebuild(next);
        }, store.serialize, 'GJV journal register access removed for ' + target);

        clearCache();
        context.log('users: %s removed %s', who.email, target);
        return { status: 204, headers: noStore };
      }

      return { status: 405, headers: noStore, jsonBody: { error: 'Method not allowed.' } };
    } catch (err) {
      if (err.notFound) {
        return {
          status: 404, headers: noStore,
          jsonBody: { error: 'That person is not on the list.' },
        };
      }
      if (err.conflict) {
        return { status: 409, headers: noStore, jsonBody: { error: err.conflict } };
      }
      if (NO_TOKEN.test(err.message || '')) {
        context.log('users: %s', err.message);
        return {
          status: 503, headers: noStore,
          jsonBody: { error: 'This report cannot save access changes yet: its GitHub '
            + 'token has not been installed. Access can still be changed in the '
            + 'repository, in access/allowed_users.json.' },
        };
      }
      context.log('users: error %s', err && err.message);
      return {
        status: 502, headers: noStore,
        jsonBody: { error: 'Could not reach the access list.' },
      };
    }
  },
});
