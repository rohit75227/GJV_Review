/*
 * Where the access list is read from at request time.
 *
 * There are two copies of access/allowed_users.json and they exist for different
 * reasons:
 *
 *   LIVE     the file in the repository, read through the GitHub Contents API.
 *            Authoritative. This is what makes the User access tab feel like a
 *            settings page: an admin adds somebody and that person can sign in at
 *            once, instead of waiting for the deploy that the same commit triggers.
 *
 *   STAGED   the copy build/stage_allowlist.sh puts into the function bundle as
 *            api/src/allowlist.json, refreshed on every deploy. This is the fallback,
 *            and it is why the report keeps working with no GITHUB_TOKEN installed at
 *            all - which is how it runs until somebody mints one.
 *
 * The fallback can only ever be the state of the list at the last deploy, and every
 * write from the app commits to the same branch and so triggers one. So the two
 * converge within a few minutes and the fallback is never a *widening* of access
 * that somebody did not commit. It is still a real difference: if GitHub is
 * unreachable in the minutes after somebody is removed, they are refused by the live
 * list when it can be read and admitted by the staged one when it cannot, until the
 * deploy lands. Documented in README, 'Who can see this'.
 *
 * GetRoles is called by the platform once per sign-in, and /api/me on every page
 * load, so the live read is cached for a few seconds. A write clears the cache
 * outright, so the admin who just made a change never sees the stale copy.
 */
'use strict';

const { parseAccessList, loadAccessList } = require('./access');
const { LIST_PATH, readFile } = require('./github');

/* Short enough that a change in the User access tab is live almost immediately, long
   enough that a page load costs one GitHub round trip rather than three. */
const TTL_MS = 10000;

let cache = { at: 0, list: null, source: null };

function clearCache() { cache = { at: 0, list: null, source: null }; }

/* The list, and where it came from. `source` is reported by /api/me so an admin can
   see at a glance whether they are looking at the live file or at the deployed copy,
   which is the difference between "my change is in effect" and "my change is waiting
   for the deploy". */
async function accessList() {
  const now = Date.now();
  if (cache.list && (now - cache.at) < TTL_MS) {
    return { list: cache.list, source: cache.source };
  }
  try {
    const { text } = await readFile(LIST_PATH);
    if (text === undefined) throw new Error(LIST_PATH + ' does not exist on the branch');
    const list = parseAccessList(text);
    if (!list.length) throw new Error('the live list is empty, which would admit nobody');
    cache = { at: now, list: list, source: 'live' };
    return { list: list, source: 'live' };
  } catch (e) {
    // Not an error worth failing a page load over: the staged copy is a committed
    // list, not a guess. Logged at every read so a token that has expired shows up
    // in the function log rather than only in behaviour.
    console.warn('access list: falling back to the staged copy:', e && e.message);
    const list = loadAccessList();
    cache = { at: now, list: list, source: 'staged' };
    return { list: list, source: 'staged' };
  }
}

module.exports = { accessList, clearCache, TTL_MS };
