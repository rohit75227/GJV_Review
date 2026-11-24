/*
 * GitHub Contents API helper: the repository is the database.
 *
 * The same helper Spend Prism uses, cut to the one file this app stores -
 * access/allowed_users.json - and with the same two lessons kept:
 *
 *   1. No per-save history snapshot. Git already keeps every version of the file,
 *      and writing a copy of the blob on every save is how one sibling checkout
 *      reached 458 MB.
 *   2. Real read-modify-write. A 409 means somebody else wrote first, so re-read
 *      and re-apply rather than letting it surface as a failed save.
 *
 * Env: GITHUB_TOKEN, GITHUB_REPO (owner/name), GITHUB_BRANCH.
 *
 * With no GITHUB_TOKEN every function here throws BEFORE making a network call, which
 * makes "not configured" an exact test rather than a guess at a 4xx. That is
 * deliberate and it degrades correctly: the User access tab reports that it cannot
 * save and stays readable, and role decisions fall back to the copy staged into the
 * function bundle at deploy time, so the site keeps working exactly as it did before
 * this feature. Any OTHER read failure still fails loudly.
 */
'use strict';

const LIST_PATH = 'access/allowed_users.json';
const MAX_ATTEMPTS = 6;
/* GitHub stops returning file content inline somewhere south of 1MB. This list is
   one line per person and will not approach it, but a loud failure beats a silent
   one the day something crosses an undocumented limit. */
const SAFE_SIZE_BYTES = 800 * 1024;

function repo() {
  const r = process.env.GITHUB_REPO;
  if (!r) throw new Error('GITHUB_REPO is not set');
  return r;
}

function branch() {
  return process.env.GITHUB_BRANCH || 'main';
}

function headers() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is not set');
  return {
    Authorization: 'Bearer ' + token,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'hb-gjv-review',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

function contentsUrl(path) {
  return 'https://api.github.com/repos/' + repo() + '/contents/' + path;
}

/* Read a file and return { text, value, sha }. A missing file gives text undefined
   rather than a guessed shape: it is on the caller to decide what missing means. */
async function readFile(path) {
  const url = contentsUrl(path) + '?ref=' + encodeURIComponent(branch());
  const res = await fetch(url, { headers: headers() });
  if (res.status === 404) return { text: undefined, value: undefined, sha: null };
  if (!res.ok) {
    throw new Error('GitHub read failed: ' + res.status + ' ' + (await res.text()));
  }
  const body = await res.json();
  const text = Buffer.from(body.content, 'base64').toString('utf8');
  let value;
  try {
    value = JSON.parse(text);
  } catch (e) {
    // Refuse rather than silently starting fresh, which would hide the existing
    // list behind an apparently empty one - and an empty list admits nobody.
    throw new Error(path + ' is not valid JSON');
  }
  return { text: text, value: value, sha: body.sha };
}

async function putFile(path, serialized, sha, message) {
  const byteLength = Buffer.byteLength(serialized, 'utf8');
  if (byteLength > SAFE_SIZE_BYTES) {
    throw new Error(path + ' would be ' + Math.round(byteLength / 1024) + 'KB, above the '
      + Math.round(SAFE_SIZE_BYTES / 1024) + 'KB safety margin kept under GitHub\'s '
      + 'Contents API inline-content limit.');
  }
  const res = await fetch(contentsUrl(path), {
    method: 'PUT',
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers()),
    body: JSON.stringify({
      message: message,
      content: Buffer.from(serialized, 'utf8').toString('base64'),
      branch: branch(),
      sha: sha || undefined,
    }),
  });
  if (res.status === 409 || res.status === 422) return { conflict: true };
  if (!res.ok) {
    throw new Error('GitHub write failed: ' + res.status + ' ' + (await res.text()));
  }
  const body = await res.json();
  return { conflict: false, sha: body.content && body.content.sha };
}

/* Apply `mutate` to the current value at `path` and commit it, retrying on a
   concurrent write rather than losing the change. `mutate(value)` returns the new
   value, or throws to abort. `serialize` turns that value into the file's text, so
   the caller keeps control of formatting - this file is read by people. */
async function mutateFile(path, mutate, serialize, message) {
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const current = await readFile(path);
    const next = mutate(current.value);
    const text = serialize(next);
    const commitMessage = typeof message === 'function' ? message(next) : message;
    const res = await putFile(path, text, current.sha, commitMessage);
    if (!res.conflict) return { value: next, sha: res.sha };
    lastError = new Error('Concurrent write; retrying');
    // Brief backoff with jitter, so two admins saving at once do not retry in
    // lockstep and collide again.
    await new Promise(function (r) { setTimeout(r, 120 * attempt + Math.random() * 100); });
  }
  throw lastError || new Error('Could not commit after several attempts');
}

module.exports = { LIST_PATH, readFile, putFile, mutateFile, repo, branch, headers };
