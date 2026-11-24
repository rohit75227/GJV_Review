/*
 * GetRoles -- Static Web Apps calls this server-side straight after a successful Entra
 * sign-in, and enforces whatever roles come back on every route. It is a real access
 * boundary, not a cosmetic check.
 *
 *   reader    the page, the data files and the read-only API. Anybody active on the
 *             access list.
 *   tb_admin  /api/users, the access list itself. Implies reader.
 *
 * Somebody who signs in and is NOT on the list gets no role, which means the route
 * rules refuse them and responseOverrides rewrites that to /403.html - a page that
 * explains they do not have access and offers to switch account or request it. That
 * is the whole reason the rule lives here rather than at Entra: Entra can refuse the
 * token, but then the person only ever sees Microsoft's AADSTS50105 error and never
 * reaches anything we can word ourselves.
 *
 * Roles minted here live in the session for hours, so they are the SLOW half of the
 * gate: /api/users re-reads the live list on every request. See api/src/principal.js.
 */
'use strict';
const { app } = require('@azure/functions');
const { rolesFor } = require('../access');
const { accessList } = require('../list');

app.http('GetRoles', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'GetRoles',
  handler: async (request, context) => {
    let body = {};
    try { body = await request.json(); } catch (e) { body = {}; }

    // Prefer the live list so somebody added a minute ago can sign straight in,
    // rather than waiting for the deploy their record triggered. accessList() falls
    // back to the copy staged into this bundle, so a missing token or an unreachable
    // GitHub costs nothing here.
    let list = null;
    let source = 'bundle';
    try {
      const resolved = await accessList();
      list = resolved.list;
      source = resolved.source;
    } catch (e) {
      context.log('GetRoles: could not resolve the access list (%s); using the bundle',
        e && e.message);
    }

    const roles = rolesFor(body, list);
    context.log('GetRoles: provider=%s list=%s granted=%s',
      (body && body.identityProvider) || '(none)', source,
      roles.length ? roles.join(',') : 'none');
    return { status: 200, jsonBody: { roles: roles } };
  }
});
