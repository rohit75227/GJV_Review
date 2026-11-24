# GJV Journal Register

A web app listing every D365 general journal with journal name **GJV**, across all legal entities, from 1 January 2026 onwards. Data comes live from Databricks (`hb_catalog.db_bronze_d365`).

It shows:
- totals, journals by month and by legal entity, who created the journals, and debit/credit by currency
- a journal list (100 per page) and full line detail (300 per page): account and offset account with GL, customer and vendor names, debit, credit, currency, exchange rate, transaction type, posting type, posting profile, line text and created by
- filters: date range, legal entity, created by, posting status, account type, account code and free-text search
- **Export to Excel**: a workbook with Summary, Journals and Lines sheets for everything matching the filters (up to 200,000 lines)

## Layout

```
backend/app.py          FastAPI: /health, /api/*, and serves frontend/dist
backend/queries.py      SQL; filter values are bound as parameters
backend/requirements.txt
requirements.txt        one-line shim to backend/requirements.txt
frontend/src/           static page (index.html, assets/app.js, assets/styles.css)
frontend/build.js       `npm run build` copies src/ to dist/
```

One process serves both the API and the page. The app reads `PORT` and binds `0.0.0.0`. `GET /health` returns 200 with no database call.

## Configuration (App Settings)

| Setting | Value |
|---|---|
| `DATABRICKS_HOST` | Workspace host, e.g. `adb-1234567890123456.7.azuredatabricks.net` |
| `DATABRICKS_HTTP_PATH` | SQL warehouse HTTP path, e.g. `/sql/1.0/warehouses/abc123` |
| `DATABRICKS_CLIENT_ID` and `DATABRICKS_CLIENT_SECRET` | Databricks service principal (preferred) |
| `DATABRICKS_TOKEN` | Personal access token, only if a service principal isn't available |
| `QUERY_CACHE_SECONDS` | Optional, default 300 |

The identity needs `SELECT` on the tables used in `backend/queries.py` and `CAN USE` on the warehouse. Every signed-in user sees data through this one identity, so gate the app behind Microsoft Entra sign-in. The data includes employee and vendor names.

Without these settings the page loads and `/api/*` returns 503 with a message saying what is missing.

## Run locally

```bash
cd frontend && npm run build && cd ..
pip install -r requirements.txt
cd backend && PORT=8000 uvicorn app:app --host 0.0.0.0 --port 8000
```

## Deploying to Azure App Service

This repo holds the application only. The Azure infrastructure (Bicep, `infra/deploy.sh`, `infra/setup-github-oidc.sh`, `infra/setup-entra-auth.sh`), `deploy.config` and the GitHub Actions deploy workflow come from the organisation template `HUD4BEAUTY/auto_deployment_setup_demo` and still need to be added before the first deployment.
