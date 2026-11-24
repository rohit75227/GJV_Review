#!/usr/bin/env python3
"""
mcp_extract.py -- the route from Databricks to disk for the GJV Journal Register.

Adapted from hb-pulse-trial-balance/build/mcp_extract.py and built on the same rule:
Python decides everything, and a `claude -p` run is only a courier that carries each
statement to the claude.ai Databricks MCP connector and hands back the path of the saved
result. Every result is between ~50 KB and ~1.5 MB, so the harness writes it to a file;
the model never reads or retypes a row.

  plan      write build/sql/*.sql, RUNLIST.txt and manifest.json
  ingest    parse one saved tool result into build/raw.tmp/<artefact>.psv
  finish    check the set is complete, swap raw.tmp into place, write control.json
  verify    decide from the artefacts alone whether this run has a usable snapshot

Exit codes: 0 fine, 1 a real failure.
"""

import argparse
import datetime
import json
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import queries  # noqa: E402

SQLDIR = os.path.join(HERE, 'sql')
RAW = os.path.join(HERE, 'raw')
TMP = os.path.join(HERE, 'raw.tmp')
MANIFEST = os.path.join(SQLDIR, 'manifest.json')

EXIT_OK = 0
EXIT_FAIL = 1

TAGS = {'meta': ('S', 'C', 'J'), 'lines': ('L',)}


def die(msg, code=EXIT_FAIL):
    print('RESULT: FAILED - ' + msg)
    sys.exit(code)


def window(today=None):
    """[FIRST_DATE, first day of next month). Anchored on today, like the trial balance,
    so lines D365 carries dated to the end of this month are included."""
    today = today or datetime.date.today()
    y, m = today.year, today.month + 1
    if m == 13:
        y, m = y + 1, 1
    return queries.FIRST_DATE, datetime.date(y, m, 1).isoformat()


def _kind(name):
    if name.endswith('_meta'):
        return 'meta'
    if '_lines_b' in name:
        return 'lines'
    return None


def cmd_plan(_args):
    start, end = window()
    os.makedirs(SQLDIR, exist_ok=True)
    for f in os.listdir(SQLDIR):
        os.remove(os.path.join(SQLDIR, f))
    runlist = []

    def write(name, sql):
        path = os.path.join(SQLDIR, '%s.sql' % name)
        with open(path, 'w', encoding='utf-8') as fh:
            fh.write(sql + '\n')
        runlist.append((name, path))

    # Stamp + control totals + journal headers in one statement; see queries.sql_meta.
    write('01_meta', queries.sql_meta(start, end))
    for b in range(queries.LINE_BUCKETS):
        write('1%02d_lines_b%02d' % (b, b), queries.sql_lines(start, end, b))

    with open(os.path.join(SQLDIR, 'RUNLIST.txt'), 'w', encoding='utf-8') as fh:
        for name, path in runlist:
            fh.write('%s\t%s\n' % (name, os.path.relpath(path, os.path.dirname(HERE))))
    manifest = {
        'planned_at': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'start': start, 'end': end, 'buckets': queries.LINE_BUCKETS,
        'artefacts': [n for n, _ in runlist],
    }
    with open(MANIFEST, 'w', encoding='utf-8') as fh:
        json.dump(manifest, fh, indent=2)
    if os.path.isdir(TMP):
        shutil.rmtree(TMP)
    os.makedirs(TMP)
    print('planned %d statements for %s..%s' % (len(runlist), start, end))
    return EXIT_OK


def parse_result(payload, name):
    """The rows of one saved connector result, or die. Shared with build/ingest_local.py."""
    state = (payload.get('status') or {}).get('state')
    if state != 'SUCCEEDED':
        die('the statement for %s did not succeed (state=%r)' % (name, state))
    if payload.get('truncated') or (payload.get('manifest') or {}).get('truncated'):
        die('the result for %s was TRUNCATED by the connector; raise LINE_BUCKETS in '
            'build/queries.py and re-plan. Do not publish this run.' % name)
    # Two shapes for the same single-column result, as the trial balance found:
    # data_array with {"string_value"} cells, or data_typed_array with {"str"} cells.
    result = payload.get('result') or {}
    rows = []
    for r in (result.get('data_array') or result.get('data_typed_array') or []):
        vals = r.get('values') if isinstance(r, dict) else r
        if not vals:
            continue
        cell = vals[0]
        s = cell if isinstance(cell, str) else (cell.get('string_value') if cell.get('string_value') is not None else cell.get('str'))
        if s is not None:
            rows.append(s)
    total = payload.get('total_row_count')
    if total is not None and total != len(rows):
        die('%s: the manifest says %s rows and the payload carries %d. This is a partial '
            'result; do not publish it.' % (name, total, len(rows)))
    return rows


def cmd_ingest(args):
    name = args.artefact
    kind = _kind(name)
    if kind is None:
        die('unknown artefact %r; it is not in the plan' % name)
    if not os.path.exists(args.result):
        die('no result file at %s' % args.result)
    with open(args.result, 'r', encoding='utf-8') as fh:
        payload = json.load(fh)
    # Some harness versions save the tool result wrapped as [{"type":"text","text":"<json>"}].
    if isinstance(payload, list) and payload and isinstance(payload[0], dict) and 'text' in payload[0]:
        payload = json.loads(payload[0]['text'])
    rows = parse_result(payload, name)
    bad = [r for r in rows if r.split('|', 1)[0] not in TAGS[kind]]
    if bad:
        die('%s: %d row(s) carry a tag this artefact should not contain (first tag %r). The '
            'result was probably filed under the wrong artefact name.'
            % (name, len(bad), bad[0].split('|', 1)[0]))
    if not rows:
        die('%s came back empty. Every artefact in this plan has rows; an empty one means '
            'the query or the filters changed.' % name)
    os.makedirs(TMP, exist_ok=True)
    out = os.path.join(TMP, '%s.psv' % name)
    with open(out, 'w', encoding='utf-8') as fh:
        fh.write('\n'.join(rows) + '\n')
    print('ingested %s: %d rows -> %s' % (name, len(rows), os.path.relpath(out, HERE)))
    return EXIT_OK


def cmd_finish(_args):
    if not os.path.exists(MANIFEST):
        die('no plan on disk; run plan first')
    manifest = json.load(open(MANIFEST))
    missing = [n for n in manifest['artefacts'] if not os.path.exists(os.path.join(TMP, '%s.psv' % n))]
    if missing:
        die('the extract is incomplete; %d artefact(s) never arrived: %s' % (len(missing), ', '.join(missing)))
    counts = {}
    for n in manifest['artefacts']:
        with open(os.path.join(TMP, '%s.psv' % n), encoding='utf-8') as fh:
            counts[n] = sum(1 for _ in fh)
    stamp = ''
    with open(os.path.join(TMP, '01_meta.psv'), encoding='utf-8') as fh:
        for line in fh:
            if line.startswith('S|'):
                stamp = line.rstrip('\n')
                break
    if not stamp:
        die('the meta artefact carries no source stamp row')
    parts = stamp.split('|')
    control = {
        'extracted_at': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'source_sink_modified': parts[1] if len(parts) > 1 else '',
        'source_max_recid': parts[2] if len(parts) > 2 else '',
        'source_lines': parts[3] if len(parts) > 3 else '',
        'rows': counts,
        'window': {'start': manifest['start'], 'end': manifest['end'], 'buckets': manifest['buckets']},
    }
    old = RAW + '.prev'
    if os.path.isdir(old):
        shutil.rmtree(old)
    if os.path.isdir(RAW):
        os.rename(RAW, old)
    os.rename(TMP, RAW)
    with open(os.path.join(RAW, 'control.json'), 'w', encoding='utf-8') as fh:
        json.dump(control, fh, indent=2)
    print('extract complete: %d artefacts, %d rows, source at recid %s'
          % (len(counts), sum(counts.values()), control['source_max_recid']))
    return EXIT_OK


def cmd_verify(_args):
    cpath = os.path.join(RAW, 'control.json')
    if not os.path.exists(cpath):
        print('no control.json: this run produced no snapshot')
        return EXIT_FAIL
    control = json.load(open(cpath))
    if not os.path.exists(MANIFEST):
        print('no plan on disk to check the snapshot against')
        return EXIT_FAIL
    manifest = json.load(open(MANIFEST))
    missing = [n for n in manifest['artefacts'] if n not in control['rows']]
    if missing:
        print('snapshot is missing %s' % ', '.join(missing))
        return EXIT_FAIL
    if control['window']['end'] != manifest['end']:
        print('snapshot ends %s but the plan asked for %s' % (control['window']['end'], manifest['end']))
        return EXIT_FAIL
    print('snapshot verified: %s..%s, %d rows' % (control['window']['start'], control['window']['end'],
                                                  sum(control['rows'].values())))
    return EXIT_OK


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    sub = ap.add_subparsers(dest='cmd', required=True)
    sub.add_parser('plan')
    p = sub.add_parser('ingest')
    p.add_argument('--artefact', required=True)
    p.add_argument('--result', required=True)
    sub.add_parser('finish')
    sub.add_parser('verify')
    args = ap.parse_args()
    return {'plan': cmd_plan, 'ingest': cmd_ingest, 'finish': cmd_finish, 'verify': cmd_verify}[args.cmd](args)


if __name__ == '__main__':
    sys.exit(main())
