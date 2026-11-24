/*
 * Who may read the GJV Journal Register (copied from the Consolidated Trial Balance).
 *
 * This is THE access boundary for the whole report, so it is kept separate from the
 * HTTP wiring and unit-tested directly. Static Web Apps calls GetRoles server-side
 * immediately after a successful Entra sign-in and then enforces whatever roles come
 * back on every route in site/staticwebapp.config.json.
 *
 * TWO ROLES:
 *
 *   reader    may load the page, the data files and the read-only API. Granted to
 *             anybody active on the list.
 *   tb_admin  may read and change the access list itself, through /api/users and the
 *             User access tab. Implies reader.
 *
 * There is deliberately no third role and no scoping. Spend Prism splits its readers
 * by department because its data has a department column; the trial balance is one
 * consolidated set of books across sixteen posting entities and there is no honest
 * line to draw inside it. So being on the list is the whole decision, and the only
 * other question is whether that person may also change the list.
 *
 * The rule is an explicit list of people, access/allowed_users.json. Being signed in
 * to the Huda Beauty tenant is deliberately NOT enough: the tenant holds ~1,189 B2B
 * guests, more than its 1,182 members, and a guest invited into a verified domain gets
 * a UPN that still ends @hudabeauty.com. So "authenticated", which is what this report
 * was gated on until today, handed every company's general ledger to a thousand
 * outsiders.
 *
 * It fails CLOSED everywhere: a missing, malformed or empty list grants nobody, and an
 * unexpected input grants nobody. Being locked out is recoverable in ninety seconds;
 * publishing the group's ledgers is not.
 */
'use strict';

const ROLE_READER = 'reader';
const ROLE_ADMIN = 'tb_admin';

const ROLES = ['viewer', 'admin'];

/* ------------------------------------------------------- the break-glass admin
 * Addresses that are ALWAYS an admin, whatever access/allowed_users.json says.
 *
 * The same device as Spend Prism's, and for the same reason: on 2026-09-08 a single
 * control there removed Shirish's own admin, and with it his only way of putting it
 * back. The access list can be emptied, corrupted, or have its last admin switched
 * off; this address survives all three.
 *
 * The trade is worth stating plainly: the address below holds admin permanently. It
 * CANNOT be revoked in the app, or by editing the access list, or by any means short
 * of a commit to this file and a deploy. It is a lock whose key is kept outside the
 * building, which is the point of one.
 *
 * Rules for changing this list: one line per person, only somebody who is answerable
 * for the whole report, and never as a shortcut for adding somebody to the access
 * list properly. Rohit is an admin on the list rather than here, because the list is
 * where an admin is supposed to be and two permanent keys is one more than the idea
 * can carry.
 *
 * It is still checked against the identity provider: a GitHub or X login matching
 * this address is refused like any other, because the check happens after the
 * provider test in recordFor().
 */
const BREAK_GLASS_ADMINS = [
  'shirish@hudabeauty.com',
];

/* The synthetic record for a break-glass address, or null. Deliberately does not
   consult the access list, which is the whole reason it exists: it has to work when
   the list is missing, empty, unparseable, or has had its last admin removed. */
function breakGlassRecord(email) {
  const key = String(email || '').trim().toLowerCase();
  if (!key) return null;
  if (BREAK_GLASS_ADMINS.indexOf(key) === -1) return null;
  return {
    email: key, name: '', role: 'admin', active: true,
    addedBy: 'hardcoded in api/src/access.js', addedAt: '', breakGlass: true,
  };
}

/* ------------------------------------------------------------------ parsing */

function normaliseRole(v) {
  if (v === undefined || v === null || String(v).trim() === '') return 'viewer';
  const r = String(v).trim().toLowerCase();
  if (ROLES.indexOf(r) === -1) {
    throw new Error('"role" must be "admin" or "viewer", got ' + JSON.stringify(v));
  }
  return r;
}

/* Parse the list file into records.

   Deliberately tolerant about the file's outer shape, because a human edits it in
   the GitHub web editor, but it throws rather than guessing: quietly reading zero
   people out of a file somebody thought they had edited is the dangerous failure.

   A plain string entry is accepted and means a viewer, which is what a bare address
   in a file like this has always meant. */
function parseAccessList(text) {
  const data = JSON.parse(text);
  let entries;
  if (Array.isArray(data)) {
    entries = data;
  } else if (data && typeof data === 'object') {
    entries = data.users;
    if (entries === undefined) throw new Error('no "users" key in the list file');
  } else {
    throw new Error('list file must be an object or an array');
  }
  if (!Array.isArray(entries)) throw new Error('"users" must be a list');

  const out = [];
  const seen = [];
  entries.forEach(function (e, i) {
    let email;
    let raw = {};
    if (typeof e === 'string') {
      email = e;
    } else if (e && typeof e === 'object') {
      /* The "//" block at the top of the file explains it to whoever opens it on
         github.com. An entry made only of "//" keys is prose, not a person. */
      const keys = Object.keys(e);
      if (keys.length && keys.every(function (k) { return k.indexOf('//') === 0; })) return;
      raw = e;
      email = e.email || e.mail || e.upn;
      if (!email) throw new Error('entry ' + (i + 1) + ' has no "email"');
    } else {
      throw new Error('entry ' + (i + 1) + ' is neither a string nor an object');
    }
    email = String(email).trim().toLowerCase();
    if (!email) return;
    if (email.indexOf('@') <= 0 || email.charAt(email.length - 1) === '@') {
      throw new Error('entry ' + (i + 1) + ' is not an email address: ' + email);
    }
    if (seen.indexOf(email) !== -1) return;     /* first entry wins */
    seen.push(email);

    let role;
    try {
      role = normaliseRole(raw.role);
    } catch (err) {
      throw new Error('entry ' + (i + 1) + ' (' + email + '): ' + err.message);
    }

    out.push({
      email: email,
      name: raw.name ? String(raw.name).trim() : '',
      role: role,
      active: raw.active !== false && raw.active !== 'false',
      addedBy: raw.addedBy ? String(raw.addedBy) : '',
      addedAt: raw.addedAt || raw.added || '',
    });
  });
  return out;
}

/* Every address the list admits, in the order written. Somebody switched off is not
   admitted, which is what `active: false` is for. */
function parseAllowlist(text) {
  return parseAccessList(text)
    .filter(function (u) { return u.active; })
    .map(function (u) { return u.email; });
}

/* ---------------------------------------------------------------- identities */

/* Every address the signed-in person could reasonably be listed under.
   A guest's UPN is mangled - shazad_harrods.com#EXT#@hudabeauty.com - and nobody would
   ever type that into the list, so their real address is reconstructed too. It only
   ever ADDS candidates to compare against an explicit list, so it cannot admit anyone
   who is not named on it. */
const GUEST_UPN = /^(.*)_([^_]+)#ext#@/i;

function identitiesFrom(body) {
  const b = body && typeof body === 'object' ? body : {};
  const claims = Array.isArray(b.claims) ? b.claims : [];

  function claimValue(names) {
    for (let n = 0; n < names.length; n++) {
      const want = names[n];
      for (let i = 0; i < claims.length; i++) {
        const c = claims[i];
        const t = String((c && c.typ) || '').toLowerCase();
        if (t === want || t.endsWith('/' + want) || t.endsWith('.' + want)) {
          if (c && c.val) return String(c.val);
        }
      }
    }
    return '';
  }

  const raw = [
    claimValue(['upn']),
    claimValue(['preferred_username']),
    claimValue(['email', 'emailaddress']),
    b.userDetails || ''
  ];

  const out = [];
  raw.forEach(function (v) {
    const id = String(v || '').trim().toLowerCase();
    if (!id || id.indexOf('@') <= 0) return;
    if (out.indexOf(id) === -1) out.push(id);
    const m = GUEST_UPN.exec(id);
    if (m) {
      const real = m[1] + '@' + m[2];
      if (out.indexOf(real) === -1) out.push(real);
    }
  });
  return out;
}

/* ------------------------------------------------------------------ decision */

/* The record for one signed-in address, or null. Case-insensitive, and a guest's
   real address counts as well as their mangled UPN. */
function findRecord(email, records) {
  const key = String(email || '').trim().toLowerCase();
  if (!key) return null;
  const list = records || [];
  for (let i = 0; i < list.length; i++) {
    if (list[i].email === key) return list[i];
  }
  const m = GUEST_UPN.exec(key);
  if (m) return findRecord(m[1] + '@' + m[2], list);
  return null;
}

/* The record for whoever the identity provider says is calling, or null.
   Only Entra counts: Static Web Apps ships GitHub and X/Twitter login routes, and
   those are 404'd in the route config as well, but a role source must never depend
   on that alone. */
function recordFor(body, records) {
  const b = body && typeof body === 'object' ? body : {};
  const provider = String(b.identityProvider || '').toLowerCase();
  if (provider !== '' && provider !== 'aad' && provider !== 'azureactivedirectory') {
    return null;
  }
  const ids = identitiesFrom(b);
  /* The break-glass admin is resolved FIRST and without reading the list, so it
     survives a list that is missing, empty, unparseable, or has had this person
     demoted out of it. See BREAK_GLASS_ADMINS above. */
  for (let i = 0; i < ids.length; i++) {
    const bg = breakGlassRecord(ids[i]);
    if (bg) return bg;
  }
  for (let i = 0; i < ids.length; i++) {
    const rec = findRecord(ids[i], records);
    if (rec) return rec;
  }
  return null;
}

/* Whether a record grants any access at all. */
function grantsAccess(rec) {
  if (!rec || rec.active === false) return false;
  return true;
}

/* A list that may be plain addresses read as records. */
function asRecords(list) {
  return (list || []).map(function (e) {
    if (typeof e !== 'string') return e;
    return {
      email: e.trim().toLowerCase(), name: '', role: 'viewer',
      active: true, addedBy: '', addedAt: '',
    };
  });
}

/* Returns the roles to grant. Fails CLOSED: anything unexpected yields none. */
function rolesFor(body, records) {
  try {
    /* No early return on an empty list. It still grants nobody - recordFor finds no
       record, so grantsAccess says no - but the break-glass admin has to survive
       exactly that case, and short-circuiting here would skip them. */
    const list = asRecords(records || loadAccessList());

    const rec = recordFor(body, list);
    if (!grantsAccess(rec)) return [];

    const roles = [ROLE_READER];
    if (rec.role === 'admin') roles.push(ROLE_ADMIN);
    return roles;
  } catch (e) {
    return [];
  }
}

/* ------------------------------------------------------------------- the file */

/* The list as deployed with the function bundle. Memoised: GetRoles is called on
   every sign-in and this copy cannot change without a redeploy.

   This is the FALLBACK copy. api/src/list.js prefers the live file in the
   repository, so a change made in the User access tab takes effect within seconds
   rather than waiting for the deploy that commit triggers; this one is what answers
   when GitHub cannot be reached or no token is installed. */
let _cache = null;

function loadAccessList() {
  if (_cache !== null) return _cache;
  try {
    // eslint-disable-next-line global-require
    const raw = require('./allowlist.json');
    _cache = parseAccessList(JSON.stringify(raw));
  } catch (e) {
    // No list means nobody gets in. Loud, because it is a deploy fault, not a user one.
    console.error('GetRoles: allowlist.json is missing or unreadable, granting nobody:',
      e && e.message);
    _cache = [];
  }
  return _cache;
}

function loadAllowed() {
  return loadAccessList().filter(function (u) { return u.active; })
    .map(function (u) { return u.email; });
}

module.exports = {
  ROLE_READER, ROLE_ADMIN, ROLES,
  BREAK_GLASS_ADMINS, breakGlassRecord,
  normaliseRole, parseAllowlist, parseAccessList, identitiesFrom, asRecords,
  findRecord, recordFor, grantsAccess, rolesFor,
  loadAccessList, loadAllowed,
};
