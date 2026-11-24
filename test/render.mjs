// render.mjs -- render the built page against the real snapshot and check its figures.
//
// Loads site/index.html in jsdom with the page's own scripts running, serves site/data/*
// as the Static Web App would, and asserts that the headline figures, the charts and the
// journal list come up and agree with an independent recount from the same data files.
// A page that throws, shows its error banner, or disagrees with the data fails the run.
//
// Needs jsdom and d3 (npm install --no-save jsdom@25 d3@7.8.5). Exit 0 pass, 1 fail.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = path.join(ROOT, 'site');

let JSDOM;
try { ({ JSDOM } = await import('jsdom')); } catch {
  ({ JSDOM } = await import('/home/azureuser/hb-shoot-calendar/node_modules/jsdom/lib/api.js'));
}
let d3src;
try { d3src = fs.readFileSync(path.join(path.dirname(require.resolve('d3')), '..', 'dist', 'd3.min.js'), 'utf8'); } catch {
  d3src = fs.readFileSync('/home/azureuser/hb-shoot-calendar/node_modules/d3/dist/d3.min.js', 'utf8');
}

let failures = 0;
const ok = (cond, msg) => { console.log((cond ? 'PASS  ' : 'FAIL  ') + msg); if (!cond) failures += 1; };

// ---- independent recount straight from the data files (default filters: 2026-01-01 .. today)
const meta = JSON.parse(fs.readFileSync(path.join(SITE, 'data/meta.json'), 'utf8'));
const today = new Date().toLocaleDateString('en-CA');
let lines = 0; const journals = new Set(); const creators = new Set(); const monthsWithLines = new Set();
const jr = JSON.parse(fs.readFileSync(path.join(SITE, 'data/journals.json'), 'utf8'));
const jf = Object.fromEntries(jr.fields.map((f, i) => [f, i]));
const createdBy = new Map(jr.rows.map((r) => [r[jf.le] + '|' + r[jf.journalnum], r[jf.createdby]]));
for (const m of meta.months) {
  const d = JSON.parse(fs.readFileSync(path.join(SITE, 'data/lines', m.key + '.json'), 'utf8'));
  const fi = Object.fromEntries(d.fields.map((f, i) => [f, i]));
  for (const r of d.rows) {
    const date = d.strings[r[fi.transdate]];
    if (date > today) continue;
    lines += 1;
    const k = d.strings[r[fi.le]] + '|' + d.strings[r[fi.journalnum]];
    journals.add(k); creators.add(createdBy.get(k)); monthsWithLines.add(date.slice(0, 7));
  }
}
const fmt = (n) => n.toLocaleString('en-US');

// ---- render
const errors = [];
const { VirtualConsole } = await import('jsdom').catch(() => import('/home/azureuser/hb-shoot-calendar/node_modules/jsdom/lib/api.js'));
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', (e) => errors.push(e.message));
const html = fs.readFileSync(path.join(SITE, 'index.html'), 'utf8')
  .replace(/<script src="https:\/\/cdnjs[^"]+"><\/script>/, '');
const dom = new JSDOM(html, {
  url: 'https://gjv.example.test/', runScripts: 'dangerously', pretendToBeVisual: true,
  virtualConsole,
  beforeParse(window) {
    window.TextEncoder = TextEncoder;
    window.eval(d3src);
    window.SVGElement.prototype.getComputedTextLength = function () { return (this.textContent || '').length * 7; };
    window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    window.fetch = async (url) => {
      const u = new URL(url, 'https://gjv.example.test/');
      const file = path.join(SITE, decodeURIComponent(u.pathname));
      if (u.pathname.startsWith('/data/') && file.startsWith(SITE) && fs.existsSync(file)) {
        const body = fs.readFileSync(file, 'utf8');
        return { ok: true, status: 200, json: async () => JSON.parse(body), text: async () => body, headers: new Map() };
      }
      return { ok: false, status: 404, json: async () => ({}), text: async () => '', headers: new Map() };
    };
  },
});
const { document } = dom.window;

const deadline = Date.now() + 60000;
while (Date.now() < deadline) {
  const rows = document.querySelectorAll('#t-journals tr.gj-click').length;
  const kpi = document.querySelector('.gj-kpis [data-k="journals"]')?.textContent;
  if (rows && kpi) break;
  await new Promise((r) => setTimeout(r, 200));
}
await new Promise((r) => setTimeout(r, 500));

const kpi = (k) => document.querySelector('.gj-kpis [data-k="' + k + '"]')?.textContent;
ok(errors.length === 0, 'no script errors' + (errors.length ? ': ' + errors[0] : ''));
ok(document.getElementById('page-error').hidden, 'the page shows no data error banner'
  + (document.getElementById('page-error').hidden ? '' : ': ' + document.getElementById('page-error').textContent));
ok(kpi('journals') === fmt(journals.size), `Journals tile ${kpi('journals')} = recount ${fmt(journals.size)}`);
ok(kpi('lines') === fmt(lines), `Lines tile ${kpi('lines')} = recount ${fmt(lines)}`);
ok(kpi('creators') === fmt(creators.size), `Created-by tile ${kpi('creators')} = recount ${fmt(creators.size)}`);
ok(document.getElementById('j-info').textContent.endsWith('of ' + fmt(journals.size)),
  'journal list pager counts every journal: ' + document.getElementById('j-info').textContent);
ok(document.querySelectorAll('#t-journals tr.gj-click').length === Math.min(100, journals.size), 'journal list shows its first page');
ok(document.querySelectorAll('#t-lines tr').length === Math.min(300, lines), 'line detail shows its first page');
ok(document.querySelectorAll('#chart-month rect.gj-bar').length === monthsWithLines.size,
  `month chart has a bar per month (${monthsWithLines.size})`);
ok(document.querySelectorAll('#chart-entity rect.gj-bar').length > 0, 'legal entity chart is drawn');
ok(document.querySelectorAll('#t-creators tr.gj-click').length === creators.size, 'who-created table lists every creator');
ok(!document.getElementById('panel-report').hidden, 'the Journals panel is showing');
ok(document.getElementById('tab-access').hidden, 'the User access tab stays hidden when /api/me does not say admin');

dom.window.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nall render checks passed');
process.exit(failures ? 1 : 0);
