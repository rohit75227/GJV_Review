# GJV Journal Register

Every Dynamics 365 general journal named **GJV**, across all legal entities, from 1 January
2026: who created it, debit and credit, posting type, transaction type, GL, customer and
vendor accounts. Filters for dates, legal entity, creator, status, account type, account
code and free text, and Export to Excel.

Built and run exactly like the Consolidated Trial Balance (`HUD4BEAUTY/hb-pulse-trial-balance`):
a static snapshot refreshed four times a day over the claude.ai Databricks connector, served
from an Azure Static Web App behind Entra sign-in and a named access list.

## What is here

```
build/queries.py           every statement sent to Databricks
build/mcp_extract.py       plan / ingest / finish / verify over the MCP connector
build/build_data.py        the extract -> site/data, gated on Databricks' control totals
build/assemble_site.py     shell + theme + report + access tab -> site/index.html
build/src/shell.html       Pulse Atlas topbar, masthead, tabs, footer (from the trial balance)
build/src/theme.css        Pulse Atlas stylesheet (from the trial balance, verbatim)
build/src/report.html/.js  the Journals tab: markup, styles, in-browser data layer, charts, export
build/src/access.html      the User access tab (from the trial balance)
build/src/403.html.static  the page a refused sign-in lands on
access/allowed_users.json  WHO MAY READ THIS REPORT (same list and rules as the trial balance)
api/                       GetRoles, me, users: the access functions (from the trial balance)
site/                      what Azure serves; site/data is the snapshot
test/render.mjs            renders the page against the real snapshot and checks the figures
refresh.sh                 the whole cycle
schedule.json              when the refresh runs (Dubai time)
systemd/                   the refresh timer and the hourly schedule sync (user units)
```

## How a refresh works

1. `mcp_extract.py plan` writes 25 statements: one with the source stamp, control totals and
   journal headers, and 24 stable hash buckets of line detail (~2,700 lines each in Nov 2026;
   the connector truncates at 16,384, and `build_data.py` refuses a bucket over 15,000).
2. One `claude -p` run carries them to the Databricks connector; every result is saved to a
   file and parsed by Python. The model never sees a row.
3. `mcp_extract.py finish` swaps the extract into `build/raw` (not committed); `verify` checks it.
4. `build_data.py` writes `site/data` only if every (month, legal entity) line count, debit and
   credit matches the totals Databricks computed separately, and the line total matches the stamp.
5. `assemble_site.py` rebuilds the page; `test/render.mjs` renders it and checks the figures.
6. If anything changed, the run commits to `main` and the GitHub workflow deploys it.

Any step that would put worse figures in front of a reader than the ones already live aborts.

## Who can see this

The same rules as the trial balance: Entra sign-in, then a named list in
`access/allowed_users.json` (viewer or admin). Admins manage it in the **User access** tab.
The data includes employee names (journal creators) and vendor names, some of them
individuals, so keep the list to people who need it and keep this repository private.

## One-time setup

**Static Web App** (`witty-grass-0c45f1510`, resource group `HB-GJV-REVIEW`, must be on the
**Standard** plan for custom Entra sign-in):

- Environment variables: `AZURE_CLIENT_ID` and `AZURE_CLIENT_SECRET` from the Entra app
  registration the trial balance uses. Add this redirect URI to that app registration:
  `https://witty-grass-0c45f1510.8.azurestaticapps.net/.auth/login/aad/callback`
- Optional, for saving access changes from the User access tab: `GITHUB_TOKEN` (contents
  write on this repository), `GITHUB_REPO` = `rohit75227/GJV_Review`, `GITHUB_BRANCH` = `main`.

**The build VM** (the one that refreshes the trial balance). Personal data is created here,
not committed from a development session: the access list is copied from the trial balance's
checkout, and the first refresh writes `site/data`.

```bash
git clone https://github.com/rohit75227/GJV_Review /home/azureuser/hb-gjv-register
cd /home/azureuser/hb-gjv-register && git checkout main && mkdir -p logs
cp /home/azureuser/hb-trial-balance/access/allowed_users.json access/allowed_users.json
git add access/allowed_users.json && git commit -m "Access list: same people as the trial balance" && git push origin main
./refresh.sh --no-publish     # extract, build, check; publishes nothing
./refresh.sh                  # first real refresh: commits site/data and deploys
cp systemd/user/hb-gjv-register* ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now hb-gjv-register.timer hb-gjv-register-schedule.timer
```

Until the access list and the first snapshot are on `main`, the deploy workflow stops at its
checks and the site keeps its previous version.

## Running it by hand

```bash
./refresh.sh --no-publish     # extract, build, verify, render; commit and push nothing
./refresh.sh                  # the whole thing
python3 build/build_data.py && python3 build/assemble_site.py && node test/render.mjs
```
