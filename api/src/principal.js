/*
 * Who is calling, and what the access list says about them.
 *
 * Static Web Apps puts the signed-in identity in the x-ms-client-principal header,
 * base64 JSON, on every request that got past the route rules. It is set by the
 * platform and cannot be forged by the browser, which is what makes it safe to
 * authorise on.
 *
 * Note the deliberate difference from GetRoles: that one is handed a body full of
 * Entra claims, so it can match on upn, preferred_username and email. This header
 * usually carries only userDetails. access.js identitiesFrom() reads both shapes, so
 * the same matching rule serves both - including a guest's mangled
 * name_domain#EXT#@hudabeauty.com UPN, which is reconstructed to their real address
 * before being compared against the list.
 *
 * EVERY function here re-resolves the caller against the LIVE list, on every single
 * request, and does not trust the roles in the header. Those are minted at sign-in
 * and Static Web Apps keeps them in the session for hours, so an admin demoted five
 * minutes ago still carries tb_admin in that header - and the one thing this feature
 * must not do is let them keep editing the list with it.
 */
'use strict';

const { recordFor, grantsAccess } = require('./access');
const { accessList } = require('./list');

function clientPrincipal(request) {
  const header = request.headers.get('x-ms-client-principal');
  if (!header) return null;
  try {
    return JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
  } catch (e) {
    return null;
  }
}

/* The caller's own address as the platform reports it, or null when nobody is
   signed in. Presentation and logging only; entitlement comes from resolve(). */
function principal(request) {
  const p = clientPrincipal(request);
  return (p && p.userDetails) || null;
}

/* What this caller is entitled to, decided fresh against the live list.

   Returns { signedIn, email, listed, active, admin, source, name, role, breakGlass }.

   Fails closed: an unparseable header, an address the list has never heard of and a
   switched-off record all come back with admin false and active false. */
async function resolve(request) {
  const cp = clientPrincipal(request);
  const email = (cp && cp.userDetails) || null;
  const { list, source } = await accessList();

  if (!email) {
    return { signedIn: false, email: null, listed: false, active: false,
             admin: false, source: source };
  }

  const rec = recordFor(cp, list);
  if (!rec) {
    return { signedIn: true, email: email, listed: false, active: false,
             admin: false, source: source };
  }
  if (!grantsAccess(rec)) {
    return { signedIn: true, email: email, listed: true, active: false,
             admin: false, source: source, name: rec.name, role: rec.role };
  }

  return {
    signedIn: true, email: email, listed: true, active: true,
    admin: rec.role === 'admin',
    source: source, name: rec.name, role: rec.role,
    // True when this admin comes from BREAK_GLASS_ADMINS rather than the list.
    // Reported so the tab can say so: an admin who cannot find themselves in the
    // list they are looking at should not have to wonder why they are let in.
    breakGlass: rec.breakGlass === true,
  };
}

module.exports = { clientPrincipal, principal, resolve };
