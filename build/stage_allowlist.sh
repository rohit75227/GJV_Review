#!/usr/bin/env bash
# Copy access/allowed_users.json into the function bundle as api/src/allowlist.json.
#
# The list has to travel with the api, because GetRoles reads it at sign-in and the
# function app cannot see the rest of the repository. Generated rather than committed so
# there is exactly one source of truth and the two can never drift apart. That is also
# why access/** triggers a deploy: the staged copy is only as current as the last one.
#
# It is validated here and not only trusted, because a list that fails to load grants
# NOBODY: that is the right way for it to fail, but it is a bad way to find out. A list
# with no active admin is refused too, because nobody could then manage access from
# inside the app and the file could only be repaired by hand.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
SRC="access/allowed_users.json"
DST="api/src/allowlist.json"

[ -f "$SRC" ] || { echo "stage_allowlist: $SRC is missing"; exit 1; }
cp "$SRC" "$DST"

node -e '
  const { parseAccessList } = require("./api/src/access.js");
  const fs = require("fs");
  const all = parseAccessList(fs.readFileSync("api/src/allowlist.json", "utf8"));
  const live = all.filter(u => u.active);
  if (!live.length) {
    console.error("stage_allowlist: the list is empty, that admits nobody");
    process.exit(1);
  }
  if (!live.some(u => u.role === "admin")) {
    console.error("stage_allowlist: the list names no active admin, so nobody could "
      + "manage access inside the app");
    process.exit(1);
  }
  console.log("staged " + live.length + " " + (live.length === 1 ? "person" : "people")
    + " into api/src/allowlist.json:");
  live.forEach(u => console.log("  - " + u.email.padEnd(40)
    + (u.role === "admin" ? "ADMIN, reads the report and manages access" : "reads the report")));
  const off = all.filter(u => !u.active);
  if (off.length) {
    console.log("switched off, admitted to nothing:");
    off.forEach(u => console.log("  - " + u.email));
  }
'
