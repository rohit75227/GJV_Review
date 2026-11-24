# GJV Journal Register

A web app listing every D365 general journal with journal name **GJV**, across all legal entities, from 1 January 2026 onwards. Data comes live from Databricks (`hb_catalog.db_bronze_d365`).

It shows:
- totals, journals by month and by legal entity, who created the journals, and debit/credit by currency
- a journal list (100 per page) and full line detail (300 per page): account and offset account with GL, customer and vendor names, debit, credit, currency, exchange rate, transaction type, posting type, posting profile, line text and created by
- filters: date range, legal entity, created by, posting status, account type, account code and free-text search
- **Export to Excel**: a workbook with Summary, Journals and Lines sheets for everything matching the filters (up to 200,000 lines)

## Layout

```
frontend/src/                 static page (index.html, assets/app.js, assets/xlsx.js, assets/styles.css)
frontend/staticwebapp.config.json  sign-in, roles and routing for Azure Static Web Apps
frontend/build.js             `npm run build` copies src/ and the config to dist/
api/function_app.py           Azure Functions (Python): /api/summary, /api/journals, /api/lines, ...
api/queries.py                SQL; filter values are bound as Databricks named parameters
api/databricks_client.py      Databricks SQL Statement Execution API client (requests only)
.github/workflows/azure-static-web-apps-witty-grass-0c45f1510.yml  deploys on every push (added by Azure)
```

Hosted on **Azure Static Web Apps**: the page is static, `/api/*` runs as the app's managed Python functions. Excel export is built in the browser from paged API calls, so no single request runs long.

## Azure setup

1. **Deployment**: the Static Web App is linked to this repo. Azure added `.github/workflows/azure-static-web-apps-witty-grass-0c45f1510.yml` and its token secret, and deploys every push to `claude/gjv-journal-register`.
2. **Environment variables** (Static Web App, *Settings > Environment variables*, Production):

| Name | Value |
|---|---|
| `DATABRICKS_HOST` | Workspace host, e.g. `adb-1234567890123456.7.azuredatabricks.net` |
| `DATABRICKS_WAREHOUSE_ID` | SQL warehouse ID (or `DATABRICKS_HTTP_PATH` = `/sql/1.0/warehouses/<id>`) |
| `DATABRICKS_CLIENT_ID` | Databricks service principal application ID |
| `DATABRICKS_CLIENT_SECRET` | Its OAuth secret |

   `DATABRICKS_TOKEN` can be used instead of the service principal. The identity needs `SELECT` on the tables in `api/queries.py` and `CAN USE` on the warehouse.
3. **Who can sign in**: every page and API call requires the role `gjv_reviewer`. Invite people under *Settings > Role management > Invite* with provider *Microsoft Entra ID* and role `gjv_reviewer`. Signed-in people without the role see a "no access" page.
4. **Deploy**: push to `claude/gjv-journal-register`.

Every signed-in user sees data through the one Databricks identity above. The data includes employee and vendor names.

## Run the API locally

```bash
cd frontend && npm run build
cd ../api && pip install -r requirements.txt && func start   # needs Azure Functions Core Tools
```
