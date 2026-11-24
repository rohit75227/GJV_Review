"""GJV Journal Register API (Azure Static Web Apps managed functions, Python v2 model).

Routes are served under /api/. Sign-in is enforced by staticwebapp.config.json.
"""

import datetime as dt
import json
import logging
import re
import threading
import time

import azure.functions as func

import queries
from databricks_client import NotConfigured, QueryFailed, query

app = func.FunctionApp(http_auth_level=func.AuthLevel.ANONYMOUS)

LEGAL_ENTITIES = {"HBUK", "HBDM", "HBDS", "HBUS", "HBFR", "HBFZ", "HBLL", "HBIN", "HBSG", "HBCB", "HBPN", "HBAQ", "HBBV", "KYEC", "HBIM"}
DATE_RE = re.compile(r"^20[2-9][0-9]-[01][0-9]-[0-3][0-9]$")
CREATOR_RE = re.compile(r"^[A-Za-z0-9._@ -]{0,40}$")
ACCT_RE = re.compile(r"^[A-Za-z0-9_.-]{0,30}$")
Q_RE = re.compile(r"^[\w ._/&#:,()-]{0,60}$", re.UNICODE)
JOURNAL_RE = re.compile(r"^[A-Za-z0-9_-]{0,40}$")
JOURNAL_SIZES = {100, 2000}
LINE_SIZES = {300, 4000}

_cache: dict = {}
_cache_lock = threading.Lock()
CACHE_SECONDS = 300


class BadRequest(Exception):
    pass


def _json(body, status=200):
    return func.HttpResponse(json.dumps(body, default=str), status_code=status, mimetype="application/json",
                             headers={"Cache-Control": "no-store"})


def _run(sql, params):
    key = (sql, tuple(sorted(params.items())))
    now = time.time()
    with _cache_lock:
        hit = _cache.get(key)
        if hit and now - hit[0] < CACHE_SECONDS:
            return hit[1]
    rows = query(sql, params)
    with _cache_lock:
        if len(_cache) > 300:
            _cache.clear()
        _cache[key] = (now, rows)
    return rows


def _filters(req: func.HttpRequest) -> dict:
    p = req.params
    f = {
        "d_from": p.get("from") or "2026-01-01",
        "d_to": p.get("to") or dt.date.today().isoformat(),
        "le": p.get("le", ""),
        "creator": p.get("creator", ""),
        "status": p.get("status", ""),
        "acct": p.get("acct", "").strip(),
        "q": p.get("q", "").strip(),
    }
    try:
        f["acctype"] = int(p.get("acctype", "-1"))
    except ValueError:
        raise BadRequest("acctype")
    bad = [n for n, ok in [
        ("from", DATE_RE.match(f["d_from"])), ("to", DATE_RE.match(f["d_to"])),
        ("le", not f["le"] or f["le"] in LEGAL_ENTITIES), ("creator", CREATOR_RE.match(f["creator"])),
        ("status", f["status"] in ("", "posted", "open")), ("acctype", f["acctype"] in (-1, 0, 1, 2, 5, 6)),
        ("acct", ACCT_RE.match(f["acct"])), ("q", Q_RE.match(f["q"]))] if not ok]
    if bad:
        raise BadRequest(", ".join(bad))
    return f


def _int(req, name, allowed=None, lo=0, hi=1000, default=0):
    try:
        v = int(req.params.get(name, default))
    except ValueError:
        raise BadRequest(name)
    if (allowed and v not in allowed) or (not allowed and not lo <= v <= hi):
        raise BadRequest(name)
    return v


def handler(fn):
    def wrapped(req: func.HttpRequest) -> func.HttpResponse:
        try:
            return _json(fn(req))
        except BadRequest as e:
            return _json({"error": f"Invalid filter: {e}"}, 400)
        except NotConfigured:
            return _json({"error": "The Databricks connection is not configured. An administrator needs to add DATABRICKS_HOST, DATABRICKS_WAREHOUSE_ID and a service principal in the Static Web App's environment variables."}, 503)
        except QueryFailed as e:
            logging.warning("query failed: %s", e)
            return _json({"error": str(e)}, 502)
        except Exception:  # noqa: BLE001
            logging.exception("unexpected error")
            return _json({"error": "Something went wrong on the server. Try again, and if it keeps happening check the app's logs."}, 500)
    wrapped.__name__ = fn.__name__
    return wrapped


@app.route(route="health", methods=["GET"])
def health(req: func.HttpRequest) -> func.HttpResponse:
    return _json({"status": "ok"})


@app.route(route="summary", methods=["GET"])
@handler
def summary(req):
    rows = _run(queries.SUMMARY, _filters(req))
    return rows[0] if rows else {}


@app.route(route="by-month", methods=["GET"])
@handler
def by_month(req):
    return _run(queries.BY_MONTH, _filters(req))


@app.route(route="by-entity", methods=["GET"])
@handler
def by_entity(req):
    return _run(queries.BY_ENTITY, _filters(req))


@app.route(route="by-creator", methods=["GET"])
@handler
def by_creator(req):
    return _run(queries.BY_CREATOR, _filters(req))


@app.route(route="by-currency", methods=["GET"])
@handler
def by_currency(req):
    return _run(queries.BY_CURRENCY, _filters(req))


@app.route(route="creators", methods=["GET"])
@handler
def creators(req):
    f = _filters(req)
    return [r["createdby"] for r in _run(queries.CREATORS, {"d_from": f["d_from"], "d_to": f["d_to"]})]


@app.route(route="journals", methods=["GET"])
@handler
def journals(req):
    f = _filters(req)
    page = _int(req, "page", hi=1000)
    size = _int(req, "size", allowed=JOURNAL_SIZES, default=100)
    rows = _run(queries.journals(size, page * size), f)
    total = rows[0]["total_journals"] if rows else 0
    for r in rows:
        r.pop("total_journals", None)
    return {"rows": rows, "total": total, "page": page, "page_size": size}


@app.route(route="lines", methods=["GET"])
@handler
def lines(req):
    f = _filters(req)
    page = _int(req, "page", hi=1000)
    size = _int(req, "size", allowed=LINE_SIZES, default=300)
    journal = req.params.get("journal", "")
    if not JOURNAL_RE.match(journal):
        raise BadRequest("journal")
    rows = _run(queries.lines(size, page * size, True), {**f, "journal": journal})
    return {"rows": rows, "page": page, "page_size": size}
