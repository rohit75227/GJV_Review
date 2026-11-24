#!/usr/bin/env bash
# refresh.sh -- the GJV Journal Register's whole cycle: Databricks -> data -> page -> GitHub -> Azure.
#
# Copied from hb-pulse-trial-balance/refresh.sh and run the same way, from the user timer
# hb-gjv-register.timer at the times in schedule.json (09:00, 12:00, 14:00, 17:00 Dubai).
#
# Exit codes:
#   0  published, or the figures had not moved and nothing needed publishing
#   0  no usable route to Databricks - THE LAST GOOD PAGE STAYS UP
#   >0 a real failure worth looking at
#
# The rule the whole script is arranged around: never replace a good page with a broken
# or an empty one. Every step that could produce a worse page than the one already live
# aborts instead of continuing.
#
# WHY A MODEL IS IN THE LOOP AT ALL. This box has no direct SQL route to the Databricks
# warehouse: the VM's managed identity mints a valid token and the workspace refuses it,
# and there is no service principal secret and no PAT. The claude.ai Databricks MCP
# connector can read it and works unattended. So one `claude -p` invocation per run acts
# as a courier for the statements, and nothing else: it is given no judgement to
# exercise, it never sees a figure, and build/mcp_extract.py verify decides from the
# files on disk whether the run was good, ignoring anything the model said.

set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD="$REPO/build"
PY="${TRIAL_BALANCE_PY:-$(command -v python3)}"
MCP_TIMEOUT_MIN="${MCP_TIMEOUT_MIN:-45}"
LOG_TS() { date -u +'%Y-%m-%dT%H:%M:%SZ'; }
say() { echo "[$(LOG_TS)] $*"; }

# --no-publish does everything except the commit and push: extract, build, verify,
# render. It is how a change to the queries or the page is exercised without putting
# anything in front of a reader.
NO_PUBLISH=0
for arg in "$@"; do
  case "$arg" in
    --no-publish) NO_PUBLISH=1 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

cd "$REPO" || exit 1

# Only one refresh may be in flight. Two at once would race over build/raw, over
# site/data and over the git index. A fire that finds the lock held does nothing, which
# is right: the run already going is the one that will publish.
LOCK="${XDG_RUNTIME_DIR:-/tmp}/hb-gjv-register.refresh.lock"
exec 9>"$LOCK" || exit 1
if ! flock -n 9; then
  say "another refresh is still in flight; this fire does nothing."
  exit 0
fi

say "GJV journal register refresh starting"

# ---------------------------------------------------------------- may we publish?
#
# This checkout is not the only thing that pushes to main: people commit here too, so it
# drifts behind between runs, and the publish step at the end pushes. Once main has
# moved, that push is rejected and the run leaves a commit stranded locally, which the
# NEXT run then trips over. Both conditions are checked before any work is done, because
# finding out at the end means having spent the extract for nothing.
if [ $NO_PUBLISH -eq 0 ]; then
  BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
  if [ "$BRANCH" != "main" ]; then
    say "NOT ON MAIN: this checkout is on '$BRANCH'. The publish step pushes HEAD to main,"
    say "             so from another branch it would push that branch's content to main."
    exit 1
  fi
  git fetch -q origin 2>/dev/null || say "WARN could not fetch origin; continuing"
  if ! git merge --ff-only origin/main >/dev/null 2>&1; then
    say "CANNOT FAST FORWARD onto origin/main. Someone has committed here and the two"
    say "                    histories have diverged. A person has to sort this out:"
    say "                    git -C $REPO status"
    exit 1
  fi
  if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main 2>/dev/null || echo none)" ]; then
    say "AHEAD OF MAIN: this checkout holds commit(s) not on origin/main, which is what a"
    say "               rejected push leaves behind. Push or reset before the next run:"
    say "               git -C $REPO push origin HEAD:main"
    exit 1
  fi
fi

# ---------------------------------------------------------------- extract
# The claude CLI is installed for the user, not on the system PATH a timer inherits.
export PATH="$HOME/.npm-global/bin:$PATH"

if ! command -v claude >/dev/null 2>&1; then
  say "the claude CLI is not on PATH, so there is no route to Databricks from this run."
  say "Site left as published."
  exit 0
fi

if ! "$PY" "$BUILD/mcp_extract.py" plan; then
  say "ERROR: could not generate the extract SQL. Site left as published."
  exit 1
fi

PROMPT="$(cat <<'EOPROMPT'
You are the transport for one step of the GJV Journal Register refresh. Do exactly
what is listed here and nothing else. Everything that needs judgement has already been
decided in Python; your job is to carry statements to the Databricks connector and file
paths back.

1. Read build/sql/RUNLIST.txt. It has one line per artefact: the artefact name and its
   statement file, separated by a tab. For each line, in order:
     a. Read the statement file.
     b. Run its contents, verbatim, through
        mcp__claude_ai_claude-databricks-connector__execute_sql_read_only.
        Change not one character of the SQL.
     c. Every result is between 50 KB and 1.5 MB, so the harness will refuse to inline
        it, save it to a file, and tell you the path. THAT IS EXPECTED AND IS NOT AN
        ERROR. Never read, open, jq, probe or summarise that file. Keeping those rows
        out of a model is the entire point of this design, and Python parses them next.
     d. Run: python3 build/mcp_extract.py ingest --artefact NAME --result THAT_PATH
     e. If ingest reports a problem, STOP and repeat its message word for word. Do not
        retry with altered SQL and do not edit any file.
   If the connector answers with a statement_id in a pending state instead of a result,
   poll it with poll_sql_result until it finishes, then carry on from (c).
2. When every artefact in RUNLIST.txt has been ingested, run:
   python3 build/mcp_extract.py finish
3. Report in at most three lines: how many artefacts you ingested, the total row count
   that finish printed, and the source record number it printed.

Send no email. Touch no git command. Edit no file other than through the ingest and
finish commands above. If anything fails, report it and stop: the last good page staying
up is a far better outcome than wrong figures going up today.
EOPROMPT
)"

ALLOWED="mcp__claude_ai_claude-databricks-connector__execute_sql_read_only"
ALLOWED="$ALLOWED,mcp__claude_ai_claude-databricks-connector__poll_sql_result"
ALLOWED="$ALLOWED,Read,Bash(python3 build/mcp_extract.py:*)"

say "launching the model to carry ${MCP_TIMEOUT_MIN}m of statements"
timeout "${MCP_TIMEOUT_MIN}m" claude -p "$PROMPT" --allowed-tools "$ALLOWED" 2>&1 \
  | sed 's/^/    /'
crc=${PIPESTATUS[0]}
if [ "$crc" = "124" ]; then
  say "the model run hit the ${MCP_TIMEOUT_MIN}m timeout."
elif [ "$crc" != "0" ]; then
  say "the model run exited $crc."
fi

# Whatever the model said, the artefacts decide.
if ! "$PY" "$BUILD/mcp_extract.py" verify; then
  say "ERROR: the extract did not produce a usable snapshot. Site left as published."
  exit 1
fi

# ---------------------------------------------------------------- build
# build_data.py asserts the extracted lines against control totals Databricks computed
# independently, and refuses to write anything if they disagree. A failure here means
# the page would show figures that do not add up, so it is fatal.
if ! "$PY" "$BUILD/build_data.py"; then
  say "ERROR: the data build failed its control totals. Site left as published."
  exit 1
fi

if ! "$PY" "$BUILD/assemble_site.py"; then
  say "ERROR: could not assemble the page. Site left as published."
  exit 1
fi

# ---------------------------------------------------------------- verify the page
# Renders the real page against the real data and asserts it comes up with figures that
# match the snapshot. Skipped only if node or jsdom
# is missing, and loudly.
# The probe asks node itself whether the test's two jsdom routes resolve, rather than
# checking for a node_modules directory: this repo has none of its own and borrows the
# copy in hb-shoot-calendar by absolute path, so a directory check here would skip the
# render test on every run and never say why.
JSDOM_OK=0
if command -v node >/dev/null 2>&1; then
  node --input-type=module -e "
    try { await import('jsdom'); } catch {
      await import('/home/azureuser/hb-shoot-calendar/node_modules/jsdom/lib/api.js');
    }" >/dev/null 2>&1 && JSDOM_OK=1
fi
if [ "$JSDOM_OK" = "1" ]; then
  if ! node "$REPO/test/render.mjs"; then
    say "ERROR: the built page did not render correctly. Nothing published."
    git checkout -- site 2>/dev/null
    exit 1
  fi
else
  say "WARN jsdom does not resolve, so the page was NOT render-tested this run. Fix it:"
  say "     the test wants either a local node_modules/jsdom or the borrowed copy at"
  say "     /home/azureuser/hb-shoot-calendar/node_modules/jsdom."
fi

# ---------------------------------------------------------------- publish
if [ $NO_PUBLISH -eq 1 ]; then
  say "--no-publish: the page is built and verified but nothing was committed or pushed."
  exit 0
fi

git add -A site >/dev/null 2>&1
if git diff --cached --quiet; then
  say "the figures have not moved since the last run; nothing to publish."
  exit 0
fi

STAMP="$("$PY" -c "import json;c=json.load(open('build/raw/control.json'));print(c['window']['end'], c['source_max_recid'])")"
git -c user.name="pulse" -c user.email="pulse@hudabeauty.com" \
  commit -q -m "Refresh GJV journal register: $STAMP" \
  -m "Automated refresh from hb_catalog.db_bronze_d365 over the Databricks MCP connector." \
  || { say "ERROR: the commit failed."; exit 1; }

if ! git push -q origin HEAD:main; then
  say "ERROR: the push was REJECTED. The commit is local; origin/main has moved."
  say "       Fix before the next fire, or every later run will refuse to start:"
  say "       git -C $REPO pull --rebase && git -C $REPO push origin HEAD:main"
  exit 1
fi

say "published $STAMP; Azure Static Web Apps will deploy it from the push."
exit 0
