#!/usr/bin/env python3
"""
build_data.py -- build/raw (the extract) -> site/data (what the page reads).

  site/data/meta.json             stamp, months, entities, creators, totals
  site/data/journals.json         one row per journal header (columnar)
  site/data/lines/YYYY-MM.json    the month's lines, columnar, strings in a per-file table

THE CONTROL TOTALS ARE THE GATE. Databricks computes, in a separate statement, the line
count, debit and credit for every (month, legal entity). The lines extracted bucket by
bucket must add up to exactly those, and the line total must equal the source stamp's
count. If anything disagrees, nothing is written and the last good data stays live.

The build is deterministic: the same extract produces byte-identical files, so a refresh
where nothing moved commits nothing.
"""

import collections
import datetime
import glob
import json
import os
import shutil
import sys
from decimal import Decimal

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import queries  # noqa: E402

ROOT = os.path.dirname(HERE)
RAW = os.path.join(HERE, 'raw')
OUT = os.path.join(ROOT, 'site', 'data')
TMP = OUT + '.tmp'

ACCOUNT_TYPES = {0: 'Ledger', 1: 'Customer', 2: 'Vendor', 3: 'Project', 5: 'Fixed assets', 6: 'Bank',
                 12: 'Fixed asset', 13: 'Advance holder', 14: 'Deferrals', 15: 'Petty cash'}
NUMERIC = {'line', 'acctype', 'offtype', 'debit', 'credit', 'exch_rate'}
TOL = Decimal('0.005')


def fail(msg):
    print('BUILD REFUSED: ' + msg)
    sys.exit(1)


def num(s, kind):
    if s == '':
        return None
    if kind in ('line', 'acctype', 'offtype'):
        return int(float(s))
    return Decimal(s)


def dump(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as fh:
        json.dump(obj, fh, ensure_ascii=False, separators=(',', ':'), sort_keys=False)
        fh.write('\n')


def jnum(d):
    """Decimal -> the shortest JSON number that round-trips at two decimals' precision."""
    if d is None:
        return None
    q = d.quantize(Decimal('0.000001'))
    f = float(q)
    return int(f) if f == int(f) and abs(f) < 2 ** 53 else f


def main():
    cpath = os.path.join(RAW, 'control.json')
    if not os.path.exists(cpath):
        fail('no build/raw/control.json; run the extract first')
    control = json.load(open(cpath))

    stamp, ctrl, journals = None, {}, []
    with open(os.path.join(RAW, '01_meta.psv'), encoding='utf-8') as fh:
        for raw in fh:
            p = raw.rstrip('\n').split('|')
            if p[0] == 'S':
                stamp = {'sinkModified': p[1], 'maxRecid': p[2], 'lines': int(p[3])}
            elif p[0] == 'C':
                ctrl[(p[1], p[2])] = (int(p[3]), Decimal(p[4] or '0'), Decimal(p[5] or '0'))
            elif p[0] == 'J':
                journals.append(p[1:1 + len(queries.JOURNAL_FIELDS)])
    if not stamp:
        fail('the meta artefact has no stamp row')

    fields = queries.LINE_FIELDS
    by_month = collections.defaultdict(list)
    seen = set()
    files = sorted(glob.glob(os.path.join(RAW, '1*_lines_b*.psv')))
    if len(files) != queries.LINE_BUCKETS:
        fail('expected %d line buckets, found %d' % (queries.LINE_BUCKETS, len(files)))
    for f in files:
        n = 0
        with open(f, encoding='utf-8') as fh:
            for raw in fh:
                p = raw.rstrip('\n').split('|')
                if p[0] != 'L' or len(p) != len(fields) + 1:
                    fail('%s: a row has %d fields, expected %d' % (os.path.basename(f), len(p) - 1, len(fields)))
                rec = dict(zip(fields, p[1:]))
                if rec['recid'] in seen:
                    fail('line %s appears in two buckets' % rec['recid'])
                seen.add(rec['recid'])
                for k in NUMERIC:
                    rec[k] = num(rec[k], k)
                by_month[rec['transdate'][:7]].append(rec)
                n += 1
        if n > queries.BUCKET_WARN:
            fail('%s holds %d rows, close to the connector\'s 16,384 ceiling. Raise '
                 'LINE_BUCKETS in build/queries.py.' % (os.path.basename(f), n))

    # ---- the gate
    got = collections.defaultdict(lambda: [0, Decimal(0), Decimal(0)])
    for m, rows in by_month.items():
        for r in rows:
            g = got[(m, r['le'])]
            g[0] += 1
            g[1] += r['debit'] or 0
            g[2] += r['credit'] or 0
    problems = []
    for key in sorted(set(ctrl) | set(got)):
        want = ctrl.get(key, (0, Decimal(0), Decimal(0)))
        have = got.get(key, [0, Decimal(0), Decimal(0)])
        if want[0] != have[0] or abs(want[1] - have[1]) > TOL or abs(want[2] - have[2]) > TOL:
            problems.append('%s %s: Databricks %d lines Dr %s Cr %s, extract %d lines Dr %s Cr %s'
                            % (key[0], key[1], want[0], want[1], want[2], have[0], have[1], have[2]))
    total = sum(len(v) for v in by_month.values())
    if total != stamp['lines']:
        problems.append('extract holds %d lines, the source stamp counted %d' % (total, stamp['lines']))
    jkeys = {(j[0], j[1]) for j in journals}
    orphans = {(r['le'], r['journalnum']) for rows in by_month.values() for r in rows} - jkeys
    if orphans:
        problems.append('%d journal(s) have lines but no header, e.g. %s' % (len(orphans), sorted(orphans)[0]))
    if problems:
        fail('the extract does not match Databricks\' control totals:\n  ' + '\n  '.join(problems[:20]))

    # ---- write
    if os.path.isdir(TMP):
        shutil.rmtree(TMP)
    jfields = queries.JOURNAL_FIELDS
    jrows = sorted(([j[0], j[1], j[2], j[3], 1 if j[4] == '1' else 0, j[5]] for j in journals),
                   key=lambda r: (r[0], r[1]))
    dump(os.path.join(TMP, 'journals.json'), {'fields': jfields, 'rows': jrows})

    months = []
    for m in sorted(by_month):
        rows = sorted(by_month[m], key=lambda r: (r['transdate'], r['le'], r['journalnum'], r['line'] or 0, r['recid']))
        strings, index = [], {}

        def s(v):
            if v not in index:
                index[v] = len(strings)
                strings.append(v)
            return index[v]

        out = []
        for r in rows:
            out.append([jnum(r[k]) if k in NUMERIC and k not in ('line', 'acctype', 'offtype')
                        else (r[k] if k in NUMERIC else s(r[k])) for k in fields])
        dump(os.path.join(TMP, 'lines', m + '.json'), {'month': m, 'fields': fields, 'strings': strings, 'rows': out})
        months.append({'key': m, 'lines': len(rows),
                       'journals': len({(r['le'], r['journalnum']) for r in rows})})

    meta = {
        'generatedAt': control['extracted_at'],
        'source': {'table': 'hb_catalog.db_bronze_d365', 'journalName': 'GJV', 'firstDate': queries.FIRST_DATE,
                   'sinkModified': stamp['sinkModified'], 'maxRecid': stamp['maxRecid'], 'lines': stamp['lines']},
        'months': months,
        'entities': sorted({j[0] for j in journals}),
        'creators': sorted({j[3] for j in journals if j[3]}),
        'accountTypes': {str(k): v for k, v in ACCOUNT_TYPES.items()},
        'totals': {'journals': len(journals), 'lines': total},
    }
    dump(os.path.join(TMP, 'meta.json'), meta)

    old = OUT + '.prev'
    if os.path.isdir(old):
        shutil.rmtree(old)
    if os.path.isdir(OUT):
        os.rename(OUT, old)
    os.rename(TMP, OUT)
    shutil.rmtree(old, ignore_errors=True)
    size = sum(os.path.getsize(p) for p in glob.glob(os.path.join(OUT, '**', '*.json'), recursive=True))
    print('built site/data: %d journals, %d lines in %d months, %.1f MB; every month and entity matches '
          'Databricks\' control totals' % (len(journals), total, len(months), size / 1e6))
    return 0


if __name__ == '__main__':
    sys.exit(main())
