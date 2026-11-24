/*
 * The rules the User access tab has to obey, kept out of the HTTP handler so
 * test/users.test.js can exercise them without a Functions host.
 *
 * There are two, and neither can be talked out of:
 *
 *   - The last active admin cannot be removed, demoted or switched off. Losing it
 *     means nobody can open this tab and there is no way back in through the app at
 *     all. The check counts admins AFTER the change, so it catches demote and
 *     deactivate, not only delete.
 *   - The "//" prose block at the top of access/allowed_users.json is not a person
 *     and is never rewritten away. It is what explains the file to whoever opens it
 *     on github.com.
 *
 * Spend Prism's third rule, that a viewer must hold at least one department, has no
 * counterpart here: the trial balance is not scoped, so a viewer is simply somebody
 * who reads the report and cannot change who else does.
 */
'use strict';

const { normaliseRole } = require('./access');

function normEmail(v) { return String(v || '').trim().toLowerCase(); }

function isCommentEntry(u) {
  const keys = Object.keys(u || {});
  return keys.length > 0 && keys.every(function (k) { return k.indexOf('//') === 0; });
}

function isAdminEntry(u) {
  return String((u && u.role) || '').trim().toLowerCase() === 'admin';
}

function isActiveEntry(u) {
  return u && u.active !== false && u.active !== 'false';
}

/* The users array out of whatever shape the file is in, and a way to put it back
   that keeps the rest of the file intact. */
function shapeOf(value) {
  if (Array.isArray(value)) {
    return { users: value.slice(), rebuild: function (users) { return users; } };
  }
  if (value && typeof value === 'object' && Array.isArray(value.users)) {
    return {
      users: value.users.slice(),
      rebuild: function (users) { return Object.assign({}, value, { users: users }); },
    };
  }
  // A missing or unreadable file is NOT treated as an empty list to append to: that
  // would rewrite the whole access list on the strength of a failed read.
  throw new Error('The access list could not be read, so it was not changed.');
}

/* Two spaces and a trailing newline: this file is read by people on github.com and
   is nowhere near any size limit, so it stays formatted. */
function serialize(value) { return JSON.stringify(value, null, 2) + '\n'; }

/* An error sentence when the list after the change would leave nobody able to
   administer access, or null when it is fine. */
function wouldStrandAccess(users) {
  const admins = (users || []).filter(function (u) {
    return !isCommentEntry(u) && isActiveEntry(u) && isAdminEntry(u);
  });
  return admins.length === 0
    ? 'That would leave no active admin, and nobody could then manage access from '
      + 'inside the app. Make somebody else an admin first.'
    : null;
}

/* One record as the User access tab sees it. Normalised, so the page never has to
   know that a hand-edited entry may have no role at all. */
function publicUser(u) {
  return {
    email: normEmail(u.email),
    name: u.name || '',
    role: isAdminEntry(u) ? 'admin' : 'viewer',
    active: isActiveEntry(u),
    addedBy: u.addedBy || '',
    addedAt: u.addedAt || u.added || '',
  };
}

function listUsers(value) {
  return shapeOf(value).users.filter(function (u) { return !isCommentEntry(u); });
}

module.exports = {
  normaliseRole, normEmail,
  isCommentEntry, isAdminEntry, isActiveEntry,
  shapeOf, serialize, wouldStrandAccess, publicUser, listUsers,
};
