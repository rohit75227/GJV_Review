"""Small Databricks SQL Statement Execution API client (requests only).

Auth: a service principal (DATABRICKS_CLIENT_ID / DATABRICKS_CLIENT_SECRET, OAuth M2M)
or a token (DATABRICKS_TOKEN). Warehouse: DATABRICKS_WAREHOUSE_ID, or the last part of
DATABRICKS_HTTP_PATH (/sql/1.0/warehouses/<id>).
"""

import os
import threading
import time

import requests


class NotConfigured(Exception):
    pass


class QueryFailed(Exception):
    pass


_token = {"value": None, "exp": 0}
_lock = threading.Lock()
_session = requests.Session()


def _settings():
    host = os.environ.get("DATABRICKS_HOST", "").replace("https://", "").strip("/")
    wh = os.environ.get("DATABRICKS_WAREHOUSE_ID", "") or os.environ.get("DATABRICKS_HTTP_PATH", "").rstrip("/").split("/")[-1]
    token = os.environ.get("DATABRICKS_TOKEN", "")
    cid = os.environ.get("DATABRICKS_CLIENT_ID", "")
    secret = os.environ.get("DATABRICKS_CLIENT_SECRET", "")
    if not host or not wh or not (token or (cid and secret)):
        raise NotConfigured()
    return host, wh, token, cid, secret


def _bearer(host, token, cid, secret):
    if token:
        return token
    with _lock:
        if _token["value"] and time.time() < _token["exp"] - 120:
            return _token["value"]
        r = _session.post(f"https://{host}/oidc/v1/token", auth=(cid, secret),
                          data={"grant_type": "client_credentials", "scope": "all-apis"}, timeout=20)
        if r.status_code != 200:
            raise QueryFailed(f"Databricks sign-in for the service principal failed ({r.status_code}).")
        body = r.json()
        _token["value"] = body["access_token"]
        _token["exp"] = time.time() + int(body.get("expires_in", 3600))
        return _token["value"]


def _ptype(v):
    if isinstance(v, bool):
        return "BOOLEAN"
    if isinstance(v, int):
        return "INT"
    return "STRING"


INT_TYPES = {"BYTE", "SHORT", "INT", "LONG"}
FLOAT_TYPES = {"FLOAT", "DOUBLE", "DECIMAL"}


def _convert(cols, rows):
    out = []
    for r in rows or []:
        d = {}
        for (name, t), v in zip(cols, r):
            if v is None:
                d[name] = None
            elif t in INT_TYPES:
                d[name] = int(v)
            elif t in FLOAT_TYPES:
                d[name] = float(v)
            else:
                d[name] = v
        out.append(d)
    return out


def query(sql: str, params: dict, deadline_s: float = 38.0) -> list[dict]:
    """Run one statement and return rows as dicts. Raises QueryFailed on error or timeout."""
    host, wh, token, cid, secret = _settings()
    headers = {"Authorization": f"Bearer {_bearer(host, token, cid, secret)}"}
    base = f"https://{host}"
    t0 = time.time()
    body = {
        "warehouse_id": wh,
        "statement": sql,
        "parameters": [{"name": k, "value": None if v is None else str(v), "type": _ptype(v)} for k, v in params.items()],
        "wait_timeout": "30s",
        "on_wait_timeout": "CONTINUE",
        "disposition": "INLINE",
        "format": "JSON_ARRAY",
    }
    r = _session.post(f"{base}/api/2.0/sql/statements", json=body, headers=headers, timeout=40)
    if r.status_code != 200:
        raise QueryFailed(f"Databricks refused the query ({r.status_code}).")
    res = r.json()
    while res.get("status", {}).get("state") in ("PENDING", "RUNNING"):
        if time.time() - t0 > deadline_s:
            _session.post(f"{base}/api/2.0/sql/statements/{res['statement_id']}/cancel", headers=headers, timeout=10)
            raise QueryFailed("The query took too long. Narrow the dates or filters and try again.")
        time.sleep(1.0)
        res = _session.get(f"{base}/api/2.0/sql/statements/{res['statement_id']}", headers=headers, timeout=20).json()
    state = res.get("status", {}).get("state")
    if state != "SUCCEEDED":
        msg = res.get("status", {}).get("error", {}).get("message", state)
        raise QueryFailed(f"The query failed in Databricks: {msg[:300]}")
    cols = [(c["name"], c.get("type_name", "STRING")) for c in res["manifest"]["schema"]["columns"]]
    result = res.get("result", {}) or {}
    rows = _convert(cols, result.get("data_array"))
    link = result.get("next_chunk_internal_link")
    while link:
        chunk = _session.get(base + link, headers=headers, timeout=30).json()
        rows += _convert(cols, chunk.get("data_array"))
        link = chunk.get("next_chunk_internal_link")
    return rows
