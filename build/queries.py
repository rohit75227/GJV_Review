"""
queries.py -- every statement the GJV Journal Register sends to Databricks.

Same transport as the Consolidated Trial Balance: each statement returns ONE string
column whose rows are pipe-separated and lead with a tag, so build/mcp_extract.py can
check that a result was filed under the right artefact before anything is built from it.

Scope: D365 general journals whose journal name is GJV, every legal entity, lines dated
1 January 2026 or later (FIRST_DATE). Nothing earlier is extracted.

Text fields are cleaned of the separator and of line breaks before they travel, so a
journal description containing '|' cannot shift every column after it.

Tags
  S   source stamp: newest SinkModifiedOn, highest recid, line count in scope
  C   control totals per (month, legal entity): lines, debit, credit
  J   one journal header: legal entity, journal, description, created by, posted, posted at
  L   one journal line (see LINE_FIELDS)
"""

D = 'hb_catalog.db_bronze_d365'
FIRST_DATE = '2026-01-01'

# How many stable hash buckets the line detail is split into. The connector truncates a
# result at 16,384 rows, so each bucket must stay under that. 24 buckets hold ~390,000
# lines before any one is at risk; 2026 to late November was ~65,000. build_data.py
# refuses a bucket over BUCKET_WARN rows so the day this needs raising is loud, not silent.
LINE_BUCKETS = 24
BUCKET_WARN = 15000

LINE_FIELDS = [
    'recid', 'le', 'journalnum', 'voucher', 'transdate', 'line',
    'acctype', 'account', 'account_name', 'gl_account',
    'offtype', 'offset_account', 'offset_name', 'offset_gl',
    'debit', 'credit', 'currency', 'exch_rate',
    'transaction_type', 'posting_type', 'posting_profile',
    'description', 'invoice', 'document',
]
JOURNAL_FIELDS = ['le', 'journalnum', 'description', 'createdby', 'posted', 'posted_at']
CONTROL_FIELDS = ['month', 'le', 'lines', 'debit', 'credit']


def _txt(expr):
    return "regexp_replace(coalesce(CAST(%s AS STRING), ''), '[|\\\\r\\\\n\\\\t]', ' ')" % expr


def _row(tag, exprs):
    return "concat_ws('|', '%s', %s) AS r" % (tag, ', '.join(_txt(e) for e in exprs))


def _scope(start, end, joins=''):
    """Every GJV line in [start, end). The one definition of what is in the report."""
    return f"""FROM {D}.ledgerjournaltrans t
JOIN {D}.ledgerjournaltable h
  ON lower(t.journalnum) = lower(h.journalnum) AND lower(t.dataareaid) = lower(h.dataareaid)
 AND coalesce(h.IsDelete, false) = false{joins}
WHERE h.journalname = 'GJV' AND coalesce(t.IsDelete, false) = false
  AND t.transdate >= DATE'{start}' AND t.transdate < DATE'{end}'"""


def sql_source_stamp(start, end):
    return f"""SELECT {_row('S', ['max(t.SinkModifiedOn)', 'max(t.recid)', 'count(*)'])}
{_scope(start, end)}"""


def sql_control(start, end):
    return f"""SELECT {_row('C', ["date_format(t.transdate, 'yyyy-MM')", 'upper(t.dataareaid)', 'count(*)',
                          'sum(coalesce(t.amountcurdebit, 0))', 'sum(coalesce(t.amountcurcredit, 0))'])}
{_scope(start, end)}
GROUP BY date_format(t.transdate, 'yyyy-MM'), upper(t.dataareaid)"""


def sql_journals(start, end):
    return f"""SELECT {_row('J', ['upper(t.dataareaid)', 't.journalnum', 'max(h.name)', 'max(h.createdby)',
                          'max(h.posted)',
                          "CASE WHEN max(h.posted) = 1 THEN date_format(max(h.posteddatetime), 'yyyy-MM-dd HH:mm') END"])}
{_scope(start, end)}
GROUP BY upper(t.dataareaid), t.journalnum"""


def sql_meta(start, end):
    """Stamp, control totals and journal headers in one statement. Folded together for
    the trial balance's reason: a small result comes back inline instead of as a file,
    and the courier has no file path to hand back. The headers alone are ~3,000 rows."""
    return '\nUNION ALL\n'.join([sql_source_stamp(start, end), sql_control(start, end), sql_journals(start, end)])


ACCOUNT_JOINS = f"""
LEFT JOIN {D}.dimensionattributevaluecombination ac ON ac.recid = t.ledgerdimension
LEFT JOIN {D}.dimensionattributevaluecombination oc ON oc.recid = t.offsetledgerdimension AND t.offsetledgerdimension <> 0"""


def sql_lines(start, end, bucket, buckets=LINE_BUCKETS):
    """One stable hash bucket of the line detail, with every name and label resolved.

    A hash bucket of the recid, not a row-number range: a range shifts when a line is
    added between two buckets' executions and silently drops or doubles rows. A line's
    bucket never changes.
    """
    return f"""WITH l AS (
  SELECT t.recid, upper(t.dataareaid) le, t.journalnum, t.voucher, CAST(t.transdate AS DATE) transdate, t.linenum,
         h.posted, t.accounttype, t.ledgerdimension, t.offsetaccounttype, t.offsetledgerdimension,
         ac.displayvalue acct, ac.mainaccount ma_id, oc.displayvalue oacct, oc.mainaccount oma_id,
         coalesce(t.amountcurdebit, 0) dr, coalesce(t.amountcurcredit, 0) cr, t.currencycode cur, t.exchrate,
         t.transactiontype, t.postingprofile, t.txt, t.invoice, t.documentnum,
         coalesce(nullif(t.company, ''), t.dataareaid) co, coalesce(nullif(t.offsetcompany, ''), t.dataareaid) oco
  {_scope(start, end, ACCOUNT_JOINS).replace(chr(10), chr(10) + '  ')}
    AND pmod(crc32(CAST(t.recid AS STRING)), {int(buckets)}) = {int(bucket)}
),
opt AS (
  SELECT lower(entityname) e, lower(optionsetname) o, option k, localizedlabel v
  FROM {D}.globaloptionsetmetadata
  WHERE lower(entityname) IN ('ledgerjournaltrans', 'generaljournalaccountentry')
),
pt AS (
  SELECT lower(e.subledgervoucherdataareaid) le, e.subledgervoucher v, a.ledgerdimension ld, min(a.postingtype) p
  FROM {D}.generaljournalentry e
  JOIN {D}.generaljournalaccountentry a ON a.generaljournalentry = e.recid AND coalesce(a.IsDelete, false) = false
  WHERE coalesce(e.IsDelete, false) = false
    AND e.accountingdate >= DATE'{start}' AND e.accountingdate < DATE'{end}'
    AND e.subledgervoucher IN (SELECT voucher FROM l)
  GROUP BY ALL
),
party AS (
  SELECT 1 at, lower(c.dataareaid) le, c.accountnum acc, d.name nm
  FROM {D}.custtable c JOIN {D}.dirpartytable d ON d.recid = c.party WHERE coalesce(c.IsDelete, false) = false
  UNION ALL
  SELECT 2, lower(v.dataareaid), v.accountnum, d.name
  FROM {D}.vendtable v JOIN {D}.dirpartytable d ON d.recid = v.party WHERE coalesce(v.IsDelete, false) = false
)
SELECT {_row('L', [
        'l.recid', 'l.le', 'l.journalnum', 'l.voucher', 'l.transdate', 'CAST(l.linenum AS INT)',
        'l.accounttype', 'l.acct', 'coalesce(pa.nm, ma.name)', 'ma.mainaccountid',
        'CASE WHEN l.oacct IS NOT NULL THEN l.offsetaccounttype END', 'l.oacct', 'coalesce(po.nm, oma.name)', 'oma.mainaccountid',
        'l.dr', 'l.cr', 'l.cur', 'CAST(l.exchrate AS DOUBLE)',
        'ott.v',
        "CASE WHEN l.posted = 1 THEN coalesce(opp.v, CASE l.accounttype WHEN 1 THEN 'Customer balance' WHEN 2 THEN 'Vendor balance' "
        "WHEN 6 THEN 'Bank' WHEN 5 THEN 'Fixed assets' ELSE 'Ledger journal' END) ELSE 'Not posted' END",
        'l.postingprofile', 'l.txt', 'l.invoice', 'l.documentnum'])}
FROM l
LEFT JOIN {D}.mainaccount ma ON ma.recid = l.ma_id AND l.accounttype = 0
LEFT JOIN {D}.mainaccount oma ON oma.recid = l.oma_id AND l.offsetaccounttype = 0
LEFT JOIN party pa ON pa.at = l.accounttype AND pa.le = lower(l.co) AND pa.acc = l.acct
LEFT JOIN party po ON po.at = l.offsetaccounttype AND po.le = lower(l.oco) AND po.acc = l.oacct
LEFT JOIN opt ott ON ott.e = 'ledgerjournaltrans' AND ott.o = 'transactiontype' AND ott.k = l.transactiontype
LEFT JOIN pt ON pt.le = lower(l.le) AND pt.v = l.voucher AND pt.ld = l.ledgerdimension
LEFT JOIN opt opp ON opp.e = 'generaljournalaccountentry' AND opp.o = 'postingtype' AND opp.k = pt.p"""
