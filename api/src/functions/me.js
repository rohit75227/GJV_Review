/*
 * /api/me  -  what the signed-in caller may do, answered live.
 *
 * The page asks this once at startup, because the roles Static Web Apps puts in the
 * request header were minted at sign-in and can be hours old. This is read from the
 * access list as it stands right now, so the User access tab appears for somebody
 * promoted a minute ago and disappears for somebody demoted a minute ago, without
 * either of them signing out.
 *
 * It reveals nothing about anybody else: one answer, the caller's own, and only
 * after Easy Auth has established who they are. It needs no role of its own, because
 * "who am I and what may I see" has to be answerable by somebody the list has never
 * heard of - otherwise the page can only look broken at them rather than tell them
 * plainly that they have no access.
 */
'use strict';

const { app } = require('@azure/functions');
const { resolve } = require('../principal');

app.http('me', {
  methods: ['GET'],
  authLevel: 'anonymous',   // the platform's Easy Auth gate covers /api/*
  route: 'me',
  handler: async (request, context) => {
    const noStore = { 'Cache-Control': 'no-store' };
    const who = await resolve(request);

    if (!who.signedIn) {
      return {
        status: 200, headers: noStore,
        jsonBody: { signedIn: false, email: null, access: 'none', admin: false },
      };
    }

    context.log('me: %s access=%s admin=%s list=%s',
      who.email, who.active ? 'full' : 'none', who.admin, who.source);

    return {
      status: 200,
      headers: noStore,
      jsonBody: {
        signedIn: true,
        email: who.email,
        name: who.name || '',
        // listed separates "switched off" from "never added", which is the
        // difference between the two messages the 403 page can show.
        listed: who.listed,
        active: who.active,
        admin: who.admin,
        access: who.active ? 'full' : 'none',
        // Where the answer came from, so an admin can tell "my change is in effect"
        // from "my change is waiting for the deploy". See api/src/list.js.
        listSource: who.source,
        // Whether this admin is the hardcoded break-glass one. See
        // BREAK_GLASS_ADMINS in api/src/access.js.
        breakGlass: who.breakGlass === true,
      },
    };
  },
});
