"""SQL for the GJV Journal Register.

All filter values are bound as named parameters (:name). Page sizes and offsets are
integers validated in Python before they are placed in the text.
"""

D = "hb_catalog.db_bronze_d365"
MIN_DATE = "2026-01-01"  # data is only shown from 2026 onwards

BASE = f"""
FROM {D}.ledgerjournaltrans t
JOIN {D}.ledgerjournaltable h
  ON lower(t.journalnum) = lower(h.journalnum) AND lower(t.dataareaid) = lower(h.dataareaid)
 AND coalesce(h.IsDelete, false) = false
LEFT JOIN {D}.dimensionattributevaluecombination ac ON ac.recid = t.ledgerdimension
LEFT JOIN {D}.dimensionattributevaluecombination oc ON oc.recid = t.offsetledgerdimension AND t.offsetledgerdimension <> 0
WHERE h.journalname = 'GJV' AND coalesce(t.IsDelete, false) = false
  AND t.transdate >= greatest(CAST(:d_from AS DATE), DATE'{MIN_DATE}')
  AND t.transdate < date_add(CAST(:d_to AS DATE), 1)
  AND (:le = '' OR upper(t.dataareaid) = :le)
  AND (:creator = '' OR h.createdby = :creator)
  AND (:status = '' OR (:status = 'posted' AND h.posted = 1) OR (:status = 'open' AND coalesce(h.posted, 0) <> 1))
  AND (:acctype < 0 OR t.accounttype = :acctype OR t.offsetaccounttype = :acctype)
  AND (:acct = '' OR upper(split(ac.displayvalue, '-')[0]) = upper(:acct) OR upper(split(oc.displayvalue, '-')[0]) = upper(:acct))
  AND (:q = '' OR lower(concat_ws(' ', t.journalnum, t.voucher, h.name, t.txt)) LIKE concat('%', lower(:q), '%'))
"""

SUMMARY = f"""
SELECT count(DISTINCT upper(t.dataareaid), t.journalnum) journals,
       count(DISTINCT upper(t.dataareaid), t.voucher) vouchers,
       count(*) lines,
       count(DISTINCT h.createdby) creators,
       count(DISTINCT upper(t.dataareaid)) entities,
       count(DISTINCT CASE WHEN h.posted = 1 THEN concat(upper(t.dataareaid), t.journalnum) END) posted_journals,
       count(DISTINCT CASE WHEN coalesce(h.posted, 0) <> 1 THEN concat(upper(t.dataareaid), t.journalnum) END) open_journals,
       count_if(t.accounttype = 1 OR t.offsetaccounttype = 1) customer_lines,
       count_if(t.accounttype = 2 OR t.offsetaccounttype = 2) vendor_lines,
       count_if(t.accounttype = 6 OR t.offsetaccounttype = 6) bank_lines,
       CAST(min(t.transdate) AS DATE) first_date,
       CAST(max(t.transdate) AS DATE) last_date
{BASE}"""

BY_MONTH = f"""
SELECT date_format(t.transdate, 'yyyy-MM') month,
       count(DISTINCT upper(t.dataareaid), t.journalnum) journals, count(*) lines
{BASE}
GROUP BY 1 ORDER BY 1"""

BY_ENTITY = f"""
SELECT upper(t.dataareaid) le, count(DISTINCT t.journalnum) journals, count(*) lines,
       count(DISTINCT h.createdby) creators,
       count(DISTINCT CASE WHEN coalesce(h.posted, 0) <> 1 THEN t.journalnum END) open_journals
{BASE}
GROUP BY 1 ORDER BY journals DESC"""

BY_CREATOR = f"""
SELECT coalesce(nullif(h.createdby, ''), '(blank)') createdby,
       count(DISTINCT upper(t.dataareaid), t.journalnum) journals, count(*) lines,
       concat_ws(', ', array_sort(collect_set(upper(t.dataareaid)))) entities,
       count(DISTINCT CASE WHEN coalesce(h.posted, 0) <> 1 THEN concat(upper(t.dataareaid), t.journalnum) END) open_journals,
       CAST(max(t.transdate) AS DATE) last_date
{BASE}
GROUP BY 1 ORDER BY journals DESC"""

BY_CURRENCY = f"""
SELECT t.currencycode cur, count(*) lines,
       sum(coalesce(t.amountcurdebit, 0)) debit, sum(coalesce(t.amountcurcredit, 0)) credit
{BASE}
GROUP BY 1 ORDER BY lines DESC"""

CREATORS = f"""
SELECT DISTINCT h.createdby
FROM {D}.ledgerjournaltrans t
JOIN {D}.ledgerjournaltable h
  ON lower(t.journalnum) = lower(h.journalnum) AND lower(t.dataareaid) = lower(h.dataareaid)
 AND coalesce(h.IsDelete, false) = false
WHERE h.journalname = 'GJV' AND coalesce(t.IsDelete, false) = false AND coalesce(h.createdby, '') <> ''
  AND t.transdate >= greatest(CAST(:d_from AS DATE), DATE'{MIN_DATE}')
  AND t.transdate < date_add(CAST(:d_to AS DATE), 1)
ORDER BY 1"""


def journals(limit: int | None, offset: int) -> str:
    page = f"LIMIT {int(limit)} OFFSET {int(offset)}" if limit else ""
    return f"""
SELECT upper(t.dataareaid) le, t.journalnum, max(h.name) description, max(h.createdby) createdby,
       CASE WHEN max(h.posted) = 1 THEN 'Posted' ELSE 'Not posted' END status,
       CASE WHEN max(h.posted) = 1 THEN date_format(max(h.posteddatetime), 'yyyy-MM-dd HH:mm') END posted_at,
       CAST(min(t.transdate) AS DATE) first_date, CAST(max(t.transdate) AS DATE) last_date,
       count(DISTINCT t.voucher) vouchers, count(*) lines,
       concat_ws(', ', array_sort(collect_set(t.currencycode))) currencies,
       sum(coalesce(t.amountcurdebit, 0)) debit, sum(coalesce(t.amountcurcredit, 0)) credit,
       count(*) OVER () total_journals
{BASE}
GROUP BY 1, 2
ORDER BY last_date DESC, t.journalnum DESC, 1
{page}"""


def lines(limit: int | None, offset: int, by_journal: bool) -> str:
    page = f"LIMIT {int(limit)} OFFSET {int(offset)}" if limit else ""
    journal = "AND (:journal = '' OR t.journalnum = :journal)" if by_journal else ""
    return f"""
WITH l AS (
  SELECT t.recid, upper(t.dataareaid) le, t.journalnum, h.name jdesc, h.posted, h.createdby,
         CAST(t.transdate AS DATE) transdate, t.voucher, t.linenum,
         t.accounttype, t.ledgerdimension, t.offsetaccounttype, t.offsetledgerdimension,
         ac.displayvalue acct, ac.mainaccount ma_id, oc.displayvalue oacct, oc.mainaccount oma_id,
         coalesce(t.amountcurdebit, 0) dr, coalesce(t.amountcurcredit, 0) cr, t.currencycode cur, t.exchrate,
         t.transactiontype, t.postingprofile, t.txt, t.invoice, t.documentnum,
         coalesce(nullif(t.company, ''), t.dataareaid) co, coalesce(nullif(t.offsetcompany, ''), t.dataareaid) oco
  {BASE}
  {journal}
  ORDER BY t.transdate DESC, t.journalnum DESC, t.linenum, t.recid
  {page}
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
    AND e.accountingdate >= (SELECT min(transdate) FROM l) AND e.accountingdate <= (SELECT max(transdate) FROM l)
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
SELECT CAST(l.recid AS STRING) recid, l.le, l.journalnum, l.voucher, l.transdate, CAST(l.linenum AS INT) line,
       ota.v account_type, l.acct account, coalesce(pa.nm, ma.name) account_name, ma.mainaccountid gl_account,
       otb.v offset_type, l.oacct offset_account, coalesce(po.nm, oma.name) offset_name, oma.mainaccountid offset_gl,
       l.dr debit, l.cr credit, l.cur currency, CAST(l.exchrate AS DOUBLE) exch_rate,
       ott.v transaction_type,
       CASE WHEN l.posted = 1 THEN coalesce(opp.v, CASE l.accounttype WHEN 1 THEN 'Customer balance' WHEN 2 THEN 'Vendor balance'
            WHEN 6 THEN 'Bank' WHEN 5 THEN 'Fixed assets' ELSE 'Ledger journal' END) ELSE 'Not posted' END posting_type,
       l.postingprofile posting_profile, l.txt description, l.invoice, l.documentnum document,
       l.createdby created_by, l.jdesc journal_description,
       CASE WHEN l.posted = 1 THEN 'Posted' ELSE 'Not posted' END status
FROM l
LEFT JOIN {D}.mainaccount ma ON ma.recid = l.ma_id AND l.accounttype = 0
LEFT JOIN {D}.mainaccount oma ON oma.recid = l.oma_id AND l.offsetaccounttype = 0
LEFT JOIN party pa ON pa.at = l.accounttype AND pa.le = lower(l.co) AND pa.acc = l.acct
LEFT JOIN party po ON po.at = l.offsetaccounttype AND po.le = lower(l.oco) AND po.acc = l.oacct
LEFT JOIN opt ota ON ota.e = 'ledgerjournaltrans' AND ota.o = 'accounttype' AND ota.k = l.accounttype
LEFT JOIN opt otb ON otb.e = 'ledgerjournaltrans' AND otb.o = 'offsetaccounttype' AND otb.k = l.offsetaccounttype AND l.oacct IS NOT NULL
LEFT JOIN opt ott ON ott.e = 'ledgerjournaltrans' AND ott.o = 'transactiontype' AND ott.k = l.transactiontype
LEFT JOIN pt ON pt.le = lower(l.le) AND pt.v = l.voucher AND pt.ld = l.ledgerdimension
LEFT JOIN opt opp ON opp.e = 'generaljournalaccountentry' AND opp.o = 'postingtype' AND opp.k = pt.p
ORDER BY l.transdate DESC, l.journalnum DESC, l.linenum, l.recid"""
