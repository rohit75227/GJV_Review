"""GJV Journal Register: API + static frontend in one process (Azure App Service)."""

import datetime as dt
import decimal
import io
import logging
import os
import re
import threading
import time
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

import queries

log = logging.getLogger("gjv")
logging.basicConfig(level=logging.INFO)

app = FastAPI(title="GJV Journal Register", docs_url=None, redoc_url=None)

DIST = Path(__file__).resolve().parent.parent / "frontend" / "dist"
LEGAL_ENTITIES = {"HBUK", "HBDM", "HBDS", "HBUS", "HBFR", "HBFZ", "HBLL", "HBIN", "HBSG", "HBCB", "HBPN", "HBAQ", "HBBV", "KYEC", "HBIM"}
DATE_RE = re.compile(r"^20[2-9][0-9]-[01][0-9]-[0-3][0-9]$")
CREATOR_RE = re.compile(r"^[A-Za-z0-9._@ -]{0,40}$")
ACCT_RE = re.compile(r"^[A-Za-z0-9_.-]{0,30}$")
Q_RE = re.compile(r"^[\w ._/&#:,()-]{0,60}$", re.UNICODE)
JOURNAL_RE = re.compile(r"^[A-Za-z0-9_-]{0,40}$")
JOURNAL_PAGE, LINE_PAGE, EXPORT_MAX_LINES = 100, 300, 200_000


# ---------------------------------------------------------------- Databricks

class NotConfigured(Exception):
    pass


def _connect():
    from databricks import sql  # imported lazily so /health never depends on it

    host = os.environ.get("DATABRICKS_HOST", "").replace("https://", "").strip("/")
    http_path = os.environ.get("DATABRICKS_HTTP_PATH", "")
    token = os.environ.get("DATABRICKS_TOKEN", "")
    client_id = os.environ.get("DATABRICKS_CLIENT_ID", "")
    client_secret = os.environ.get("DATABRICKS_CLIENT_SECRET", "")
    if not host or not http_path or not (token or (client_id and client_secret)):
        raise NotConfigured()
    if token:
        return sql.connect(server_hostname=host, http_path=http_path, access_token=token)
    from databricks.sdk.core import Config, oauth_service_principal

    cfg = Config(host=f"https://{host}", client_id=client_id, client_secret=client_secret)
    return sql.connect(server_hostname=host, http_path=http_path, credentials_provider=lambda: oauth_service_principal(cfg))


def _clean(v):
    if isinstance(v, decimal.Decimal):
        return float(v)
    if isinstance(v, (dt.date, dt.datetime)):
        return v.isoformat()
    return v


_cache: dict = {}
_cache_lock = threading.Lock()
CACHE_SECONDS = int(os.environ.get("QUERY_CACHE_SECONDS", "300"))


def run(sql_text: str, params: dict, cache: bool = True) -> list[dict]:
    key = (sql_text, tuple(sorted(params.items())))
    now = time.time()
    if cache:
        with _cache_lock:
            hit = _cache.get(key)
            if hit and now - hit[0] < CACHE_SECONDS:
                return hit[1]
    with _connect() as conn, conn.cursor() as cur:
        cur.execute(sql_text, params)
        cols = [c[0] for c in cur.description]
        rows = [{c: _clean(v) for c, v in zip(cols, r)} for r in cur.fetchall()]
    if cache:
        with _cache_lock:
            if len(_cache) > 500:
                _cache.clear()
            _cache[key] = (now, rows)
    return rows


def stream(sql_text: str, params: dict, batch: int = 5000):
    with _connect() as conn, conn.cursor() as cur:
        cur.execute(sql_text, params)
        cols = [c[0] for c in cur.description]
        while True:
            chunk = cur.fetchmany(batch)
            if not chunk:
                break
            for r in chunk:
                yield {c: _clean(v) for c, v in zip(cols, r)}


@app.exception_handler(NotConfigured)
async def _not_configured(_, __):
    return JSONResponse(status_code=503, content={"error": "The Databricks connection is not configured on this app. An administrator needs to set DATABRICKS_HOST, DATABRICKS_HTTP_PATH and a token or service principal."})


# ---------------------------------------------------------------- Filters

def filters(
    d_from: str = Query("2026-01-01", alias="from"),
    d_to: str = Query(None, alias="to"),
    le: str = "",
    creator: str = "",
    status: str = "",
    acctype: int = -1,
    acct: str = "",
    q: str = "",
) -> dict:
    d_to = d_to or dt.date.today().isoformat()
    bad = []
    if not DATE_RE.match(d_from):
        bad.append("from")
    if not DATE_RE.match(d_to):
        bad.append("to")
    if le and le not in LEGAL_ENTITIES:
        bad.append("le")
    if not CREATOR_RE.match(creator):
        bad.append("creator")
    if status not in ("", "posted", "open"):
        bad.append("status")
    if acctype not in (-1, 0, 1, 2, 5, 6):
        bad.append("acctype")
    if not ACCT_RE.match(acct):
        bad.append("acct")
    if not Q_RE.match(q):
        bad.append("q")
    if bad:
        raise HTTPException(status_code=400, detail="Invalid filter: " + ", ".join(bad))
    return {"d_from": d_from, "d_to": d_to, "le": le, "creator": creator, "status": status,
            "acctype": acctype, "acct": acct.strip(), "q": q.strip()}


# ---------------------------------------------------------------- Routes

@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/api/summary")
def summary(f: dict = Depends(filters)):
    rows = run(queries.SUMMARY, f)
    return rows[0] if rows else {}


@app.get("/api/by-month")
def by_month(f: dict = Depends(filters)):
    return run(queries.BY_MONTH, f)


@app.get("/api/by-entity")
def by_entity(f: dict = Depends(filters)):
    return run(queries.BY_ENTITY, f)


@app.get("/api/by-creator")
def by_creator(f: dict = Depends(filters)):
    return run(queries.BY_CREATOR, f)


@app.get("/api/by-currency")
def by_currency(f: dict = Depends(filters)):
    return run(queries.BY_CURRENCY, f)


@app.get("/api/creators")
def creators(f: dict = Depends(filters)):
    return [r["createdby"] for r in run(queries.CREATORS, {"d_from": f["d_from"], "d_to": f["d_to"]})]


@app.get("/api/journals")
def journals(page: int = Query(0, ge=0, le=1000), f: dict = Depends(filters)):
    rows = run(queries.journals(JOURNAL_PAGE, page * JOURNAL_PAGE), f)
    total = rows[0]["total_journals"] if rows else 0
    for r in rows:
        r.pop("total_journals", None)
    return {"rows": rows, "total": total, "page": page, "page_size": JOURNAL_PAGE}


@app.get("/api/lines")
def lines(page: int = Query(0, ge=0, le=1000), journal: str = "", f: dict = Depends(filters)):
    if not JOURNAL_RE.match(journal):
        raise HTTPException(status_code=400, detail="Invalid filter: journal")
    rows = run(queries.lines(LINE_PAGE, page * LINE_PAGE, True), {**f, "journal": journal})
    return {"rows": rows, "page": page, "page_size": LINE_PAGE}


JCOLS = [("Journal", "journalnum", "text", 20), ("Legal entity", "le", "text", 11), ("Description", "description", "text", 50),
         ("Created by", "createdby", "text", 18), ("Status", "status", "text", 12), ("Posted at", "posted_at", "text", 17),
         ("First line date", "first_date", "date", 14), ("Last line date", "last_date", "date", 14), ("Vouchers", "vouchers", "int", 10),
         ("Lines", "lines", "int", 9), ("Currencies", "currencies", "text", 14), ("Debit", "debit", "money", 18), ("Credit", "credit", "money", 18)]
LCOLS = [("Date", "transdate", "date", 12), ("Journal", "journalnum", "text", 20), ("Voucher", "voucher", "text", 18), ("Legal entity", "le", "text", 11),
         ("Line", "line", "int", 7), ("Account type", "account_type", "text", 13), ("Account", "account", "text", 28), ("Main account", "gl_account", "text", 13),
         ("Account name", "account_name", "text", 34), ("Offset type", "offset_type", "text", 12), ("Offset account", "offset_account", "text", 28),
         ("Offset main account", "offset_gl", "text", 13), ("Offset name", "offset_name", "text", 34), ("Debit", "debit", "money", 16),
         ("Credit", "credit", "money", 16), ("Currency", "currency", "text", 9), ("Exchange rate", "exch_rate", "num", 12),
         ("Transaction type", "transaction_type", "text", 18), ("Posting type", "posting_type", "text", 20), ("Posting profile", "posting_profile", "text", 13),
         ("Line text", "description", "text", 50), ("Invoice", "invoice", "text", 14), ("Document", "document", "text", 14),
         ("Created by", "created_by", "text", 18), ("Status", "status", "text", 12), ("Journal description", "journal_description", "text", 40)]
ILLEGAL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")


def _sheet(wb, title, cols, rows):
    from openpyxl.cell import WriteOnlyCell
    from openpyxl.styles import Font, PatternFill
    from openpyxl.utils import get_column_letter

    ws = wb.create_sheet(title)
    ws.freeze_panes = "A2"
    for i, (_, _, _, w) in enumerate(cols, 1):
        ws.column_dimensions[get_column_letter(i)].width = w
    head = []
    for label, *_ in cols:
        c = WriteOnlyCell(ws, value=label)
        c.font = Font(bold=True)
        c.fill = PatternFill("solid", fgColor="E7EAF0")
        head.append(c)
    ws.append(head)
    n = 0
    for r in rows:
        out = []
        for _, key, kind, _ in cols:
            v = r.get(key)
            if v is None or v == "":
                out.append(None)
                continue
            if kind == "date":
                c = WriteOnlyCell(ws, value=dt.date.fromisoformat(str(v)[:10]))
                c.number_format = "dd mmm yyyy"
            elif kind in ("money", "int", "num"):
                c = WriteOnlyCell(ws, value=float(v) if kind != "int" else int(v))
                c.number_format = {"money": "#,##0.00", "int": "#,##0", "num": "General"}[kind]
            else:
                c = WriteOnlyCell(ws, value=ILLEGAL.sub("", str(v)))
            out.append(c)
        ws.append(out)
        n += 1
    ws.auto_filter.ref = f"A1:{get_column_letter(len(cols))}{n + 1}"
    return n


@app.get("/api/export")
def export(f: dict = Depends(filters)):
    from openpyxl import Workbook

    wb = Workbook(write_only=True)
    summary_ws = wb.create_sheet("Summary")
    jrows = run(queries.journals(None, 0), f, cache=False)
    for r in jrows:
        r.pop("total_journals", None)
    nj = _sheet(wb, "Journals", JCOLS, jrows)

    def capped():
        for i, r in enumerate(stream(queries.lines(None, 0, False), f)):
            if i >= EXPORT_MAX_LINES:
                capped.cut = True
                return
            yield r
    capped.cut = False
    nl = _sheet(wb, "Lines", LCOLS, capped())

    acc = {-1: "Any account type", 0: "Ledger (GL)", 1: "Customer", 2: "Vendor", 6: "Bank", 5: "Fixed assets"}
    info = [("Report", "GJV Journal Register (D365 general journals, journal name GJV)"),
            ("Exported at (UTC)", dt.datetime.utcnow().strftime("%Y-%m-%d %H:%M")),
            ("From", f["d_from"]), ("To", f["d_to"]), ("Legal entity", f["le"] or "All entities"),
            ("Created by", f["creator"] or "Everyone"),
            ("Status", {"": "Posted and not posted", "posted": "Posted", "open": "Not posted"}[f["status"]]),
            ("Account type", acc[f["acctype"]]), ("Account code", f["acct"] or "Any"), ("Search", f["q"] or "None"),
            ("Journals exported", nj), ("Lines exported", nl),
            ("Note", "Only lines dated 1 January 2026 or later are included. Amounts are in each line's transaction currency.")]
    if capped.cut:
        info.append(("Warning", f"Lines stop at {EXPORT_MAX_LINES:,}. Narrow the filters and export again for the rest."))
    summary_ws.column_dimensions["A"].width = 20
    summary_ws.column_dimensions["B"].width = 90
    summary_ws.append(["Item", "Value"])
    for k, v in info:
        summary_ws.append([k, str(v)])

    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    name = f"GJV journals {f['d_from']} to {f['d_to']}{(' ' + f['le']) if f['le'] else ''}.xlsx"
    return StreamingResponse(buf, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                             headers={"Content-Disposition": f'attachment; filename="{name}"'})


# ---------------------------------------------------------------- Frontend

if (DIST / "assets").is_dir():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")


@app.get("/{path:path}", include_in_schema=False)
def spa(path: str):
    if path.startswith("api/"):
        raise HTTPException(status_code=404)
    target = (DIST / path).resolve()
    if path and target.is_file() and DIST.resolve() in target.parents:
        return FileResponse(target)
    index = DIST / "index.html"
    if not index.is_file():
        return JSONResponse(status_code=503, content={"error": "Frontend not built. Run npm run build in frontend/."})
    return FileResponse(index)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8000")))
