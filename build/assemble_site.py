#!/usr/bin/env python3
"""
assemble_site.py -- build/src/* -> site/index.html and site/403.html.

The page is the Pulse Atlas shell from the Consolidated Trial Balance (shell.html and
theme.css, copied verbatim), retitled for the GJV Journal Register, with two panels:

  Journals      build/src/report.html + report.js   (reads site/data, see build_data.py)
  User access   build/src/access.html               (copied verbatim; admins only)

Every placeholder must be substituted and every piece of the access boundary must be
present, or the build stops rather than shipping a half-assembled page.
"""

import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC = os.path.join(HERE, 'src')
SITE = os.path.join(ROOT, 'site')


def die(msg):
    print('ASSEMBLY FAILED: ' + msg)
    sys.exit(1)


def read(name):
    with open(os.path.join(SRC, name), encoding='utf-8') as fh:
        return fh.read()


def swap(text, old, new, what):
    if old not in text:
        die('the shell no longer contains %s; update assemble_site.py' % what)
    return text.replace(old, new)


TABS = '''    <button type="button" data-view="report" class="active" role="tab" aria-selected="true">Journals</button>
    <!-- Shown only once /api/me says this account is an admin. Hidden in the markup
         rather than added by script so that a reader with no JavaScript, or a page
         whose /api/me call fails, never sees a tab that would refuse them. -->
    <button type="button" data-view="access" id="tab-access" class="tab-admin" role="tab" aria-selected="false" hidden>User access</button>'''

TAB_SWITCH = '''<script>
/* The two tabs. The User access panel shows and hides itself (access.html); this only
   marks the clicked tab and shows or hides the Journals panel. */
(function(){
  var nav = document.getElementById('view-tabs');
  var report = document.getElementById('panel-report');
  if (!nav) return;
  nav.addEventListener('click', function(e){
    var btn = e.target.closest('button[data-view]');
    if (!btn) return;
    nav.querySelectorAll('button[data-view]').forEach(function(b){
      var on = b === btn;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    if (report) report.hidden = btn.getAttribute('data-view') !== 'report';
  });
})();
</script>'''

STAMP = '''<script>
/* The provenance line in the topbar and at the foot of the page, read from the same
   snapshot the report reads. */
(function(){
  fetch('data/meta.json', { cache: 'no-cache', credentials: 'same-origin' })
    .then(function(r){ return r.ok ? r.json() : null; })
    .then(function(m){
      if (!m) return;
      var when = m.generatedAt ? new Date(m.generatedAt) : null;
      var dubai = when ? new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dubai', day: '2-digit',
        month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(when) : 'unknown';
      var meta = document.getElementById('topbar-meta');
      if (meta) meta.textContent = (m.months || []).length + ' months · refreshed ' + dubai + ' Dubai';
      var foot = document.getElementById('foot-stamp');
      if (foot){
        var src = m.source || {};
        foot.textContent = 'Snapshot ' + dubai + ' Dubai · ' + (src.lines ? src.lines.toLocaleString('en-US') + ' journal lines' : '')
          + (src.maxRecid ? ' · to record ' + src.maxRecid : '');
      }
    })
    .catch(function(){ /* the page is still usable without a timestamp */ });
})();
</script>'''


def main():
    shell = read('shell.html')
    theme = read('theme.css')
    report = read('report.html')
    script = read('report.js')
    access = read('access.html')

    out = shell
    out = swap(out, '<title>Consolidated Trial Balance</title>', '<title>GJV Journal Register</title>', 'the page title')
    out = re.sub(r'<h1>Consolidated <em>Trial Balance</em></h1>', '<h1>GJV <em>Journal Register</em></h1>', out)
    out = re.sub(r'<p class="dek">.*?</p>',
                 '<p class="dek"><strong>Every general journal (GJV) across all legal entities, from 2026.</strong> '
                 'Who created it, debit and credit, posting and transaction type, GL, customer and vendor accounts, '
                 'straight from Dynamics 365 and refreshed four times a day.</p>', out, count=1, flags=re.S)
    out = re.sub(r'<div class="view-tabs-in">.*?</div>\s*</nav>',
                 '<div class="view-tabs-in">\n' + TABS + '\n  </div>\n</nav>', out, count=1, flags=re.S)
    out = re.sub(r'<footer class="pagefoot">.*?</footer>', '''<footer class="pagefoot">
  <div class="wrap">
    <p><strong>GJV Journal Register</strong> &middot; a Pulse business app, built and run by AI and Automation.</p>
    <p>Source: <code>hb_catalog.db_bronze_d365</code> in Databricks, read from the Dynamics 365 ledger journal header and lines. Journal name GJV, every legal entity, lines dated 1 January 2026 or later.</p>
    <p class="foot-mono" id="foot-stamp">&nbsp;</p>
  </div>
</footer>''', out, count=1, flags=re.S)
    # The trial balance's own scripts after the footer (SheetJS, its provenance block, the
    # usage tag) are replaced wholesale: this page builds its own .xlsx and has no /api/presence.
    tail = out.index('</footer>') + len('</footer>')
    out = out[:tail] + '\n\n<script src="https://cdnjs.cloudflare.com/ajax/libs/d3/7.8.5/d3.min.js"></script>\n<script>\n//REPORT_SCRIPT\n</script>\n' + TAB_SWITCH + '\n' + STAMP + '\n</body>\n</html>\n'

    out = swap(out, '<!--RECON-->\n', '', 'the recon placeholder')
    out = swap(out, '<!--REPORT-->', report, 'the report placeholder')
    out = swap(out, '<!--ACCESS-->', access, 'the access placeholder')
    out = swap(out, '/*THEME*/', theme, 'the theme placeholder')
    out = swap(out, '//REPORT_SCRIPT', script, 'the script placeholder')

    for mark in ('<!--REPORT-->', '<!--RECON-->', '<!--ACCESS-->', '/*THEME*/', '//REPORT_SCRIPT'):
        if mark in out:
            die('the assembled page still carries the %s placeholder' % mark)
    if '--pink:#F20A82' not in out:
        die('the assembled page does not carry the Pulse Atlas palette')
    for needle, what in (('id="tab-access"', 'the User access tab button'),
                         ('id="panel-access"', 'the User access panel'),
                         ('id="panel-report"', 'the Journals panel'),
                         ("fetch('/api/me'", 'the live entitlement check that reveals the tab'),
                         ('window.gjData', 'the snapshot data layer'),
                         ('window.gjXlsx', 'the Excel writer'),
                         ('ajax/libs/d3/7.8.5/d3.min.js', 'd3, which draws the charts')):
        if needle not in out:
            die('the assembled page is missing %s (%s)' % (what, needle))

    os.makedirs(SITE, exist_ok=True)
    with open(os.path.join(SITE, 'index.html'), 'w', encoding='utf-8') as fh:
        fh.write(out)
    with open(os.path.join(SITE, '403.html'), 'w', encoding='utf-8') as fh:
        fh.write(read('403.html.static'))
    print('assembled site/index.html (%d bytes) and site/403.html' % len(out))
    return 0


if __name__ == '__main__':
    sys.exit(main())
