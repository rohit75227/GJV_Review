// Minimal .xlsx writer: Office Open XML sheets in an uncompressed zip.
window.gjXlsx = (function () {
  const enc = new TextEncoder();
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(u8) { let c = 0xffffffff; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
  function zip(files) {
    const parts = [], central = []; let offset = 0;
    const now = new Date();
    const dtime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const ddate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    files.forEach((f) => {
      const name = enc.encode(f.name), data = typeof f.data === 'string' ? enc.encode(f.data) : f.data, crc = crc32(data);
      const h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
      h.setUint16(10, dtime, true); h.setUint16(12, ddate, true); h.setUint32(14, crc, true);
      h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
      parts.push(h.buffer, name, data);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
      c.setUint16(12, dtime, true); c.setUint16(14, ddate, true); c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true);
      c.setUint16(28, name.length, true); c.setUint32(42, offset, true);
      central.push(c.buffer, name);
      offset += 30 + name.length + data.length;
    });
    const csize = central.reduce((s, p) => s + p.byteLength, 0);
    const e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
    e.setUint32(12, csize, true); e.setUint32(16, offset, true);
    return new Blob([...parts, ...central, e.buffer]);
  }
  const esc = (s) => String(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  function colName(i) { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }
  const EPOCH = Date.UTC(1899, 11, 30);
  function serial(v) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v)); return m ? (Date.UTC(+m[1], +m[2] - 1, +m[3]) - EPOCH) / 86400000 : null; }
  // cols: [{label, key, type: 'text'|'int'|'money'|'num'|'date', width}]
  function sheetXml(cols, rows) {
    const out = [];
    const last = colName(cols.length - 1);
    out.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">');
    out.push('<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>');
    out.push('<cols>' + cols.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width || 14}" customWidth="1"/>`).join('') + '</cols><sheetData>');
    out.push('<row r="1">' + cols.map((c, i) => `<c r="${colName(i)}1" t="inlineStr" s="1"><is><t>${esc(c.label)}</t></is></c>`).join('') + '</row>');
    rows.forEach((r, ri) => {
      const rn = ri + 2; let x = `<row r="${rn}">`;
      cols.forEach((c, i) => {
        const v = r[c.key]; if (v == null || v === '') return;
        const ref = colName(i) + rn;
        if (c.type === 'date') { const d = serial(v); x += d == null ? `<c r="${ref}" t="inlineStr"><is><t>${esc(v)}</t></is></c>` : `<c r="${ref}" s="2"><v>${d}</v></c>`; }
        else if (c.type === 'money' || c.type === 'int' || c.type === 'num') { const n = +v; x += isFinite(n) ? `<c r="${ref}" s="${c.type === 'money' ? 3 : c.type === 'int' ? 4 : 0}"><v>${n}</v></c>` : `<c r="${ref}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`; }
        else x += `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
      });
      out.push(x + '</row>');
    });
    out.push('</sheetData>');
    if (rows.length) out.push(`<autoFilter ref="A1:${last}${rows.length + 1}"/>`);
    out.push('</worksheet>');
    return out.join('');
  }
  function workbook(sheets) {
    const files = [];
    files.push({ name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' + sheets.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') + '</Types>' });
    files.push({ name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' });
    files.push({ name: 'xl/workbook.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' + sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') + '</sheets>' + (function () { const d = sheets.map((s, i) => s.rows.length ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${esc(s.name)}'!$A$1:$${colName(s.cols.length - 1)}$${s.rows.length + 1}</definedName>` : '').join(''); return d ? '<definedNames>' + d + '</definedNames>' : ''; })() + '</workbook>' });
    files.push({ name: 'xl/_rels/workbook.xml.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') + `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` });
    files.push({ name: 'xl/styles.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="dd mmm yyyy"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE7EAF0"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>' });
    sheets.forEach((s, i) => files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s.cols, s.rows) }));
    return zip(files);
  }
  return { workbook };
})();

// ---------- data: static snapshot files written by build/build_data.py
window.gjData = (function () {
  'use strict';
  let meta = null, jindex = null, ready = null;
  const months = new Map();
  let lastKey = null, lastRows = null;

  async function getJSON(url) {
    const r = await fetch(url, { credentials: 'same-origin', cache: 'no-cache' });
    if (r.status === 401 || r.status === 403) throw new Error('Your sign-in has expired. Reload the page to sign in again.');
    if (!r.ok) throw new Error('Could not load ' + url + ' (' + r.status + ').');
    return r.json();
  }
  function init() {
    if (!ready) ready = Promise.all([getJSON('data/meta.json'), getJSON('data/journals.json')]).then(([m, j]) => {
      meta = m; jindex = new Map();
      const fi = Object.fromEntries(j.fields.map((f, i) => [f, i]));
      j.rows.forEach((r) => jindex.set(r[fi.le] + '|' + r[fi.journalnum], {
        description: r[fi.description], createdby: r[fi.createdby], posted: r[fi.posted] === 1, posted_at: r[fi.posted_at] }));
    });
    return ready;
  }
  function loadMonth(key) {
    if (!months.has(key)) {
      months.set(key, getJSON('data/lines/' + key + '.json').then((d) => {
        const F = d.fields, S = d.strings, NUM = new Set(['line', 'acctype', 'offtype', 'debit', 'credit', 'exch_rate']);
        return d.rows.map((r) => {
          const o = {};
          F.forEach((f, i) => { o[f] = NUM.has(f) ? r[i] : S[r[i]]; });
          const h = jindex.get(o.le + '|' + o.journalnum) || {};
          o.createdby = h.createdby || ''; o.jdesc = h.description || ''; o.posted = !!h.posted; o.posted_at = h.posted_at || '';
          o.debit = o.debit || 0; o.credit = o.credit || 0;
          return o;
        });
      }).catch((e) => { months.delete(key); throw e; }));
    }
    return months.get(key);
  }
  const head = (s) => String(s || '').split('-')[0].toUpperCase();

  async function filtered(f) {
    await init();
    const from = f.from > meta.source.firstDate ? f.from : meta.source.firstDate, to = f.to;
    const key = JSON.stringify([from, to, f.le, f.creator, f.status, f.acctype, f.acct, f.q]);
    if (key === lastKey) return lastRows;
    const wanted = meta.months.map((m) => m.key).filter((k) => k >= from.slice(0, 7) && k <= to.slice(0, 7));
    const all = (await Promise.all(wanted.map(loadMonth))).flat();
    const at = Number(f.acctype), acct = (f.acct || '').toUpperCase(), q = (f.q || '').toLowerCase();
    const rows = all.filter((r) => r.transdate >= from && r.transdate <= to
      && (!f.le || r.le === f.le)
      && (!f.creator || r.createdby === f.creator)
      && (!f.status || (f.status === 'posted' ? r.posted : !r.posted))
      && (at < 0 || r.acctype === at || r.offtype === at)
      && (!acct || head(r.account) === acct || head(r.offset_account) === acct)
      && (!q || (r.journalnum + ' ' + r.voucher + ' ' + r.jdesc + ' ' + r.description).toLowerCase().includes(q)));
    lastKey = key; lastRows = rows;
    return rows;
  }
  const uniq = (arr) => new Set(arr).size;
  const cmpDesc = (a, b) => (a < b ? 1 : a > b ? -1 : 0);

  function journalsOf(rows) {
    const g = new Map();
    rows.forEach((r) => {
      const k = r.le + '|' + r.journalnum;
      let j = g.get(k);
      if (!j) g.set(k, j = { le: r.le, journalnum: r.journalnum, description: r.jdesc, createdby: r.createdby,
        status: r.posted ? 'Posted' : 'Not posted', posted_at: r.posted ? r.posted_at : '', first_date: r.transdate, last_date: r.transdate,
        _v: new Set(), lines: 0, _c: new Set(), debit: 0, credit: 0 });
      if (r.transdate < j.first_date) j.first_date = r.transdate;
      if (r.transdate > j.last_date) j.last_date = r.transdate;
      j._v.add(r.voucher); j._c.add(r.currency); j.lines += 1; j.debit += r.debit; j.credit += r.credit;
    });
    return [...g.values()].map((j) => ({ ...j, vouchers: j._v.size, currencies: [...j._c].sort().join(', '), _v: undefined, _c: undefined }))
      .sort((a, b) => cmpDesc(a.last_date, b.last_date) || cmpDesc(a.journalnum, b.journalnum) || (a.le < b.le ? -1 : 1));
  }
  const TYPES = () => meta.accountTypes;

  async function query(path, f) {
    const rows = await filtered(f);
    const page = Number(f.page || 0), size = Number(f.size || (path === 'lines' ? 300 : 100));
    switch (path) {
      case 'summary': {
        if (!rows.length) return { journals: 0, vouchers: 0, lines: 0, creators: 0, entities: 0, posted_journals: 0, open_journals: 0, customer_lines: 0, vendor_lines: 0, bank_lines: 0, first_date: null, last_date: null };
        const js = new Map(); rows.forEach((r) => js.set(r.le + '|' + r.journalnum, r.posted));
        let first = rows[0].transdate, last = first;
        rows.forEach((r) => { if (r.transdate < first) first = r.transdate; if (r.transdate > last) last = r.transdate; });
        const has = (r, t) => r.acctype === t || r.offtype === t;
        return { journals: js.size, vouchers: uniq(rows.map((r) => r.le + '|' + r.voucher)), lines: rows.length,
          creators: uniq(rows.map((r) => r.createdby)), entities: uniq(rows.map((r) => r.le)),
          posted_journals: [...js.values()].filter(Boolean).length, open_journals: [...js.values()].filter((p) => !p).length,
          customer_lines: rows.filter((r) => has(r, 1)).length, vendor_lines: rows.filter((r) => has(r, 2)).length, bank_lines: rows.filter((r) => has(r, 6)).length,
          first_date: first, last_date: last };
      }
      case 'by-month': {
        const g = new Map();
        rows.forEach((r) => { const k = r.transdate.slice(0, 7); const m = g.get(k) || { month: k, _j: new Set(), lines: 0 }; m._j.add(r.le + '|' + r.journalnum); m.lines += 1; g.set(k, m); });
        return [...g.values()].sort((a, b) => (a.month < b.month ? -1 : 1)).map((m) => ({ month: m.month, journals: m._j.size, lines: m.lines }));
      }
      case 'by-entity': {
        const g = new Map();
        rows.forEach((r) => { const e = g.get(r.le) || { le: r.le, _j: new Set(), lines: 0, _c: new Set(), _o: new Set() }; e._j.add(r.journalnum); e.lines += 1; e._c.add(r.createdby); if (!r.posted) e._o.add(r.journalnum); g.set(r.le, e); });
        return [...g.values()].map((e) => ({ le: e.le, journals: e._j.size, lines: e.lines, creators: e._c.size, open_journals: e._o.size })).sort((a, b) => b.journals - a.journals);
      }
      case 'by-creator': {
        const g = new Map();
        rows.forEach((r) => { const k = r.createdby || '(blank)'; const c = g.get(k) || { createdby: k, _j: new Set(), lines: 0, _e: new Set(), _o: new Set(), last_date: '' }; const jk = r.le + '|' + r.journalnum; c._j.add(jk); c.lines += 1; c._e.add(r.le); if (!r.posted) c._o.add(jk); if (r.transdate > c.last_date) c.last_date = r.transdate; g.set(k, c); });
        return [...g.values()].map((c) => ({ createdby: c.createdby, journals: c._j.size, lines: c.lines, entities: [...c._e].sort().join(', '), open_journals: c._o.size, last_date: c.last_date })).sort((a, b) => b.journals - a.journals);
      }
      case 'by-currency': {
        const g = new Map();
        rows.forEach((r) => { const c = g.get(r.currency) || { cur: r.currency, lines: 0, debit: 0, credit: 0 }; c.lines += 1; c.debit += r.debit; c.credit += r.credit; g.set(r.currency, c); });
        return [...g.values()].sort((a, b) => b.lines - a.lines);
      }
      case 'creators': await init(); return meta.creators.slice();
      case 'journals': { const all = journalsOf(rows); return { rows: all.slice(page * size, page * size + size), total: all.length, page, page_size: size }; }
      case 'lines': {
        const t = TYPES();
        const sel = (f.journal ? rows.filter((r) => r.journalnum === f.journal) : rows.slice())
          .sort((a, b) => cmpDesc(a.transdate, b.transdate) || cmpDesc(a.journalnum, b.journalnum) || (a.line || 0) - (b.line || 0) || (a.recid < b.recid ? -1 : 1));
        return { page, page_size: size, rows: sel.slice(page * size, page * size + size).map((r) => ({
          recid: r.recid, le: r.le, journalnum: r.journalnum, voucher: r.voucher, transdate: r.transdate, line: r.line,
          account_type: t[r.acctype] || '', account: r.account, account_name: r.account_name, gl_account: r.gl_account,
          offset_type: r.offtype == null ? '' : (t[r.offtype] || ''), offset_account: r.offset_account, offset_name: r.offset_name, offset_gl: r.offset_gl,
          debit: r.debit, credit: r.credit, currency: r.currency, exch_rate: r.exch_rate, transaction_type: r.transaction_type,
          posting_type: r.posting_type, posting_profile: r.posting_profile, description: r.description, invoice: r.invoice, document: r.document,
          created_by: r.createdby, journal_description: r.jdesc, status: r.posted ? 'Posted' : 'Not posted' })) };
      }
      default: throw new Error('Unknown view ' + path);
    }
  }
  return { query, init, meta: () => meta };
})();
// GJV Journal Register frontend: reads filters, calls /api, draws KPIs, charts and tables.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const fmtInt = d3.format(',d'), fmtMoney = d3.format(',.2f'), fmtRate = d3.format(',.4~f');
  const parseDay = d3.utcParse('%Y-%m-%d'), parseMonth = d3.utcParse('%Y-%m');
  const fmtDate = (s) => { if (!s) return ''; const d = parseDay(String(s).slice(0, 10)); return d ? d3.utcFormat('%d %b %Y')(d) : String(s); };
  const today = d3.timeFormat('%Y-%m-%d')(new Date());
  const DEFAULTS = { from: '2026-01-01', to: today, le: '', creator: '', status: '', acctype: -1, acct: '', q: '' };
  const ACCT = /^[A-Za-z0-9_.-]{0,30}$/, Q = /^[\p{L}\p{N} ._/&#:,()-]{0,60}$/u;

  let filters = { ...DEFAULTS };
  let jpage = 0, lpage = 0, journal = '';
  let seq = 0;
  let lastMonth = null, lastEntity = null;

  const qs = (extra) => new URLSearchParams({ ...filters, ...(extra || {}) }).toString();
  async function api(path, extra) {
    return window.gjData.query(path, { ...filters, ...(extra || {}) });
  }

  // ---------- helpers
  function td(tr, text, cls) { const c = document.createElement('td'); c.textContent = text == null ? '' : String(text); if (cls) c.className = cls; tr.appendChild(c); return c; }
  function msgRow(tbody, cols, text) { const tr = document.createElement('tr'); const c = td(tr, text, 'gj-msg'); c.colSpan = cols; tbody.replaceChildren(tr); }
  function pill(cell, text) { const s = document.createElement('span'); s.className = 'gj-pill ' + (text === 'Posted' ? 'gj-ok' : 'gj-open'); s.textContent = text; cell.replaceChildren(s); }
  function note(el, text) { const p = document.createElement('p'); p.className = 'gj-note'; p.textContent = text; el.replaceChildren(p); }
  function tipFor(el) { const t = document.createElement('div'); t.className = 'gj-tip'; t.hidden = true; el.appendChild(t); return t; }
  function showTip(el, tip, ev, title, sub) {
    const b = document.createElement('b'); b.textContent = title; const s = document.createElement('small'); s.textContent = sub;
    tip.replaceChildren(b, s); tip.hidden = false;
    const r = el.getBoundingClientRect(); let x = ev.clientX - r.left + 12, y = ev.clientY - r.top - tip.offsetHeight - 8;
    if (x + tip.offsetWidth > r.width) x = Math.max(0, ev.clientX - r.left - tip.offsetWidth - 12);
    if (y < 0) y = ev.clientY - r.top + 14;
    tip.style.left = x + 'px'; tip.style.top = y + 'px';
  }
  function setFilters(patch) { filters = { ...filters, ...patch }; jpage = 0; lpage = 0; journal = ''; syncControls(); loadAll(); }

  // ---------- controls
  function syncControls() {
    const v = { 'f-from': filters.from, 'f-to': filters.to, 'f-le': filters.le, 'f-status': filters.status, 'f-acctype': String(filters.acctype), 'f-acct': filters.acct, 'f-q': filters.q, 'f-creator': filters.creator };
    Object.entries(v).forEach(([id, val]) => { const el = $(id); if (el && document.activeElement !== el) el.value = val; });
  }
  ['f-from', 'f-to'].forEach((id) => {
    $(id).addEventListener('change', (e) => { const el = e.target; if (el.value && el.validity.valid) setFilters(id === 'f-from' ? { from: el.value } : { to: el.value }); });
    $(id).addEventListener('blur', (e) => { e.target.value = id === 'f-from' ? filters.from : filters.to; });
  });
  $('f-le').addEventListener('change', (e) => setFilters({ le: e.target.value }));
  $('f-status').addEventListener('change', (e) => setFilters({ status: e.target.value }));
  $('f-acctype').addEventListener('change', (e) => setFilters({ acctype: Number(e.target.value) }));
  $('f-creator').addEventListener('change', (e) => setFilters({ creator: e.target.value }));
  function applyText() {
    const a = $('f-acct').value.trim(), q = $('f-q').value.trim();
    const okA = ACCT.test(a), okQ = Q.test(q) && !/['"\\`]/.test(q);
    $('f-acct').classList.toggle('gj-bad', !okA); $('f-q').classList.toggle('gj-bad', !okQ); $('f-hint').hidden = okA && okQ;
    if (okA && okQ && (a !== filters.acct || q !== filters.q)) setFilters({ acct: a, q });
  }
  $('filters').addEventListener('submit', (e) => { e.preventDefault(); applyText(); });
  ['f-acct', 'f-q'].forEach((id) => $(id).addEventListener('change', applyText));
  $('f-reset').addEventListener('click', () => { $('f-hint').hidden = true; ['f-acct', 'f-q'].forEach((id) => $(id).classList.remove('gj-bad')); setFilters({ ...DEFAULTS }); });
  $('j-prev').addEventListener('click', () => { jpage = Math.max(0, jpage - 1); loadJournals(); });
  $('j-next').addEventListener('click', () => { jpage += 1; loadJournals(); });
  $('l-prev').addEventListener('click', () => { lpage = Math.max(0, lpage - 1); loadLines(); });
  $('l-next').addEventListener('click', () => { lpage += 1; loadLines(); });
  $('l-clear').addEventListener('click', () => { journal = ''; lpage = 0; loadLines(); loadJournals(); });

  // ---------- export (built in the browser from paged API calls)
  const JCOLS = [
    { label: 'Journal', key: 'journalnum', width: 20 }, { label: 'Legal entity', key: 'le', width: 11 }, { label: 'Description', key: 'description', width: 50 },
    { label: 'Created by', key: 'createdby', width: 18 }, { label: 'Status', key: 'status', width: 12 }, { label: 'Posted at', key: 'posted_at', width: 17 },
    { label: 'First line date', key: 'first_date', type: 'date', width: 14 }, { label: 'Last line date', key: 'last_date', type: 'date', width: 14 },
    { label: 'Vouchers', key: 'vouchers', type: 'int', width: 10 }, { label: 'Lines', key: 'lines', type: 'int', width: 9 }, { label: 'Currencies', key: 'currencies', width: 14 },
    { label: 'Debit', key: 'debit', type: 'money', width: 18 }, { label: 'Credit', key: 'credit', type: 'money', width: 18 }];
  const LCOLS = [
    { label: 'Date', key: 'transdate', type: 'date', width: 12 }, { label: 'Journal', key: 'journalnum', width: 20 }, { label: 'Voucher', key: 'voucher', width: 18 },
    { label: 'Legal entity', key: 'le', width: 11 }, { label: 'Line', key: 'line', type: 'int', width: 7 },
    { label: 'Account type', key: 'account_type', width: 13 }, { label: 'Account', key: 'account', width: 28 }, { label: 'Main account', key: 'gl_account', width: 13 }, { label: 'Account name', key: 'account_name', width: 34 },
    { label: 'Offset type', key: 'offset_type', width: 12 }, { label: 'Offset account', key: 'offset_account', width: 28 }, { label: 'Offset main account', key: 'offset_gl', width: 13 }, { label: 'Offset name', key: 'offset_name', width: 34 },
    { label: 'Debit', key: 'debit', type: 'money', width: 16 }, { label: 'Credit', key: 'credit', type: 'money', width: 16 }, { label: 'Currency', key: 'currency', width: 9 },
    { label: 'Exchange rate', key: 'exch_rate', type: 'num', width: 12 }, { label: 'Transaction type', key: 'transaction_type', width: 18 }, { label: 'Posting type', key: 'posting_type', width: 20 },
    { label: 'Posting profile', key: 'posting_profile', width: 13 }, { label: 'Line text', key: 'description', width: 50 }, { label: 'Invoice', key: 'invoice', width: 14 },
    { label: 'Document', key: 'document', width: 14 }, { label: 'Created by', key: 'created_by', width: 18 }, { label: 'Status', key: 'status', width: 12 }, { label: 'Journal description', key: 'journal_description', width: 40 }];
  const MAX_LINES = 200000;
  $('x-export').addEventListener('click', async () => {
    const btn = $('x-export'), st = $('x-status'), f = { ...filters };
    const say = (t, tone) => { st.dataset.tone = tone || ''; st.textContent = t; };
    btn.disabled = true;
    try {
      let jrows = [], page = 0, total = 0;
      do {
        say(`Loading journals… ${fmtInt(jrows.length)}`);
        const r = await api('journals', { ...f, page, size: 2000 });
        total = r.total; jrows = jrows.concat(r.rows); page += 1;
        if (!r.rows.length) break;
      } while (jrows.length < total);
      let lrows = [], got = 0; page = 0;
      do {
        say(`Loading journal lines… ${fmtInt(lrows.length)}`);
        const r = await api('lines', { ...f, page, size: 4000 });
        got = r.rows.length; lrows = lrows.concat(r.rows); page += 1;
      } while (got === 4000 && lrows.length < MAX_LINES);
      const cut = got === 4000;
      say(`Building the workbook (${fmtInt(jrows.length)} journals, ${fmtInt(lrows.length)} lines)…`);
      await new Promise((r) => setTimeout(r, 30));
      const ACC = { '-1': 'Any account type', 0: 'Ledger (GL)', 1: 'Customer', 2: 'Vendor', 6: 'Bank', 5: 'Fixed assets' };
      const STATUS = { '': 'Posted and not posted', posted: 'Posted', open: 'Not posted' };
      const info = [['Report', 'GJV Journal Register (D365 general journals, journal name GJV)'], ['Exported at', d3.timeFormat('%Y-%m-%d %H:%M')(new Date())],
        ['From', f.from], ['To', f.to], ['Legal entity', f.le || 'All entities'], ['Created by', f.creator || 'Everyone'], ['Status', STATUS[f.status]],
        ['Account type', ACC[f.acctype]], ['Account code', f.acct || 'Any'], ['Search', f.q || 'None'],
        ['Journals exported', jrows.length], ['Lines exported', lrows.length],
        ['Note', 'Only lines dated 1 January 2026 or later are included. Amounts are in each line\'s transaction currency.']];
      if (cut) info.push(['Warning', `Lines stop at ${fmtInt(MAX_LINES)}. Narrow the filters and export again for the rest.`]);
      const blob = window.gjXlsx.workbook([
        { name: 'Summary', cols: [{ label: 'Item', key: 'k', width: 20 }, { label: 'Value', key: 'v', width: 90 }], rows: info.map(([k, v]) => ({ k, v: String(v) })) },
        { name: 'Journals', cols: JCOLS, rows: jrows }, { name: 'Lines', cols: LCOLS, rows: lrows }]);
      const name = `GJV journals ${f.from} to ${f.to}${f.le ? ' ' + f.le : ''}.xlsx`;
      const url = URL.createObjectURL(blob); const a = document.createElement('a');
      a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000);
      say(`Downloaded ${name}: ${fmtInt(jrows.length)} journals and ${fmtInt(lrows.length)} lines.` + (cut ? ' Some lines were left out; see the Summary sheet.' : ''), 'ok');
    } catch (e) { say('Export failed. ' + e.message, 'bad'); }
    finally { btn.disabled = false; }
  });

  // ---------- renderers
  function renderSummary(s) {
    document.querySelectorAll('[data-k]').forEach((el) => {
      const k = el.dataset.k, v = s ? s[k] : null;
      el.textContent = s == null ? '' : (k.endsWith('_date') ? (v ? fmtDate(v) : 'n/a') : fmtInt(+v || 0));
    });
  }
  function renderCreatorsOptions(names) {
    const sel = $('f-creator'); const cur = filters.creator;
    const list = names.slice(); if (cur && !list.includes(cur)) list.unshift(cur);
    sel.replaceChildren(new Option('Everyone', ''), ...list.map((n) => new Option(n, n))); sel.value = cur;
  }
  function renderMonth(rows) {
    const el = $('chart-month');
    if (!rows.length) return note(el, 'No journals match these filters.');
    el.replaceChildren();
    const data = rows.map((d) => ({ k: d.month, v: +d.journals, n: +d.lines }));
    const W = Math.max(260, el.clientWidth), H = 230;
    const y = d3.scaleLinear().domain([0, d3.max(data, (d) => d.v) || 1]).nice().range([H - 26, 20]);
    const svg = d3.select(el).append('svg').attr('width', '100%').attr('viewBox', `0 0 ${W} ${H}`).attr('role', 'img')
      .attr('aria-label', 'GJV journals per month: ' + data.map((d) => d.k + ' ' + d.v).join(', '));
    const gy = svg.append('g').attr('class', 'gj-grid').call(d3.axisLeft(y).ticks(4).tickFormat(d3.format('~s')));
    let ml = 8; gy.selectAll('text').each(function () { ml = Math.max(ml, this.getComputedTextLength() + 14); });
    gy.attr('transform', `translate(${ml},0)`).call(d3.axisLeft(y).ticks(4).tickFormat(d3.format('~s')).tickSize(-(W - ml - 6))).call((g) => g.select('.domain').remove());
    const x = d3.scaleBand().domain(data.map((d) => d.k)).range([ml, W - 6]).padding(0.25);
    const every = x.bandwidth() < 26 ? 2 : 1;
    svg.append('g').attr('class', 'gj-axis').attr('transform', `translate(0,${H - 26})`)
      .call(d3.axisBottom(x).tickSizeOuter(0).tickFormat((k, i) => (i % every ? '' : d3.utcFormat('%b')(parseMonth(k)))));
    const tip = tipFor(el);
    svg.append('g').selectAll('rect').data(data).join('rect').attr('class', 'gj-bar').attr('rx', 2)
      .attr('x', (d) => x(d.k)).attr('width', x.bandwidth()).attr('y', (d) => y(d.v)).attr('height', (d) => y(0) - y(d.v))
      .on('mousemove', (ev, d) => showTip(el, tip, ev, d3.utcFormat('%B %Y')(parseMonth(d.k)), `${fmtInt(d.v)} journals · ${fmtInt(d.n)} lines`))
      .on('mouseleave', () => { tip.hidden = true; })
      .on('click', (ev, d) => {
        const end = d3.utcFormat('%Y-%m-%d')(d3.utcDay.offset(d3.utcMonth.offset(parseMonth(d.k), 1), -1));
        setFilters({ from: d.k + '-01', to: end < today ? end : today });
      });
    if (x.bandwidth() >= 22) svg.append('g').selectAll('text').data(data).join('text').attr('class', 'gj-val').attr('text-anchor', 'middle')
      .attr('x', (d) => x(d.k) + x.bandwidth() / 2).attr('y', (d) => y(d.v) - 5).text((d) => fmtInt(d.v));
  }
  function renderEntity(rows) {
    const el = $('chart-entity');
    if (!rows.length) return note(el, 'No journals match these filters.');
    el.replaceChildren();
    const data = rows.map((d) => ({ k: d.le, v: +d.journals, n: +d.lines, c: +d.creators, o: +d.open_journals }));
    const W = Math.max(260, el.clientWidth), bh = 20, gap = 6, H = data.length * (bh + gap) + 8;
    const svg = d3.select(el).append('svg').attr('width', '100%').attr('viewBox', `0 0 ${W} ${H}`).attr('role', 'img')
      .attr('aria-label', 'GJV journals per legal entity: ' + data.map((d) => d.k + ' ' + d.v).join(', '));
    const labels = svg.append('g').selectAll('text').data(data).join('text').attr('class', 'gj-lbl').attr('x', 0).attr('y', (d, i) => i * (bh + gap) + bh / 2 + 4).text((d) => d.k);
    let ml = 0; labels.each(function () { ml = Math.max(ml, this.getComputedTextLength()); }); ml += 10;
    const vals = svg.append('g').selectAll('text').data(data).join('text').attr('class', 'gj-val').text((d) => fmtInt(d.v));
    let vr = 0; vals.each(function () { vr = Math.max(vr, this.getComputedTextLength()); }); vr += 8;
    const x = d3.scaleLinear().domain([0, d3.max(data, (d) => d.v) || 1]).range([ml, W - vr]);
    const tip = tipFor(el);
    svg.append('g').selectAll('rect').data(data).join('rect').attr('class', 'gj-bar').attr('rx', 2)
      .attr('x', ml).attr('y', (d, i) => i * (bh + gap)).attr('height', bh).attr('width', (d) => Math.max(1, x(d.v) - ml))
      .style('opacity', (d) => (filters.le && d.k !== filters.le ? 0.35 : 1))
      .on('mousemove', (ev, d) => showTip(el, tip, ev, d.k, `${fmtInt(d.v)} journals · ${fmtInt(d.n)} lines · ${d.c} creators · ${d.o} not posted`))
      .on('mouseleave', () => { tip.hidden = true; })
      .on('click', (ev, d) => setFilters({ le: filters.le === d.k ? '' : d.k }));
    vals.attr('x', (d) => x(d.v) + 6).attr('y', (d, i) => i * (bh + gap) + bh / 2 + 4);
  }
  function renderCreators(rows) {
    const tb = $('t-creators');
    if (!rows.length) return msgRow(tb, 6, 'No journals match these filters.');
    tb.replaceChildren(...rows.map((d) => {
      const tr = document.createElement('tr'); tr.className = 'gj-click' + (filters.creator === d.createdby ? ' gj-sel' : ''); tr.tabIndex = 0;
      td(tr, d.createdby); td(tr, fmtInt(d.journals), 'gj-r'); td(tr, fmtInt(d.lines), 'gj-r'); td(tr, fmtInt(d.open_journals), 'gj-r'); td(tr, d.entities); td(tr, fmtDate(d.last_date));
      const pick = () => { if (d.createdby !== '(blank)') setFilters({ creator: filters.creator === d.createdby ? '' : d.createdby }); };
      tr.addEventListener('click', pick); tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') pick(); });
      return tr;
    }));
  }
  function renderCurrency(rows) {
    const tb = $('t-currency');
    if (!rows.length) return msgRow(tb, 4, 'No lines match these filters.');
    tb.replaceChildren(...rows.map((d) => { const tr = document.createElement('tr'); td(tr, d.cur); td(tr, fmtInt(d.lines), 'gj-r'); td(tr, fmtMoney(d.debit), 'gj-r'); td(tr, fmtMoney(d.credit), 'gj-r gj-cr'); return tr; }));
  }

  // ---------- loaders
  function sectionError(fn, e) { try { fn(e); } catch (_) { /* keep page alive */ } }
  async function loadJournals() {
    const tb = $('t-journals'); msgRow(tb, 13, 'Loading journals…'); $('j-prev').disabled = $('j-next').disabled = true;
    try {
      const r = await api('journals', { page: jpage });
      $('j-info').textContent = r.total ? `Journals ${fmtInt(jpage * r.page_size + 1)} to ${fmtInt(jpage * r.page_size + r.rows.length)} of ${fmtInt(r.total)}` : 'No journals';
      $('j-prev').disabled = jpage <= 0; $('j-next').disabled = (jpage + 1) * r.page_size >= r.total;
      if (!r.rows.length) return msgRow(tb, 13, 'No journals match these filters. Widen the dates or clear a filter.');
      tb.replaceChildren(...r.rows.map((d) => {
        const tr = document.createElement('tr'); tr.className = 'gj-click' + (journal === d.journalnum ? ' gj-sel' : ''); tr.tabIndex = 0;
        td(tr, d.journalnum, 'gj-mono'); td(tr, d.le); td(tr, d.description, 'gj-wrap'); td(tr, d.createdby); pill(td(tr, ''), d.status); td(tr, d.posted_at || '');
        td(tr, fmtDate(d.first_date)); td(tr, fmtDate(d.last_date)); td(tr, fmtInt(d.vouchers), 'gj-r'); td(tr, fmtInt(d.lines), 'gj-r'); td(tr, d.currencies);
        td(tr, fmtMoney(d.debit), 'gj-r'); td(tr, fmtMoney(d.credit), 'gj-r gj-cr');
        const open = () => { journal = d.journalnum; lpage = 0; tb.querySelectorAll('tr').forEach((x) => x.classList.toggle('gj-sel', x === tr)); loadLines(); $('lines').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); };
        tr.addEventListener('click', open); tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
        return tr;
      }));
    } catch (e) { $('j-info').textContent = ''; msgRow(tb, 13, 'Journals did not load. ' + e.message); }
  }
  async function loadLines() {
    const tb = $('t-lines'); msgRow(tb, 26, 'Loading journal lines…'); $('l-prev').disabled = $('l-next').disabled = true;
    $('l-title').textContent = journal ? 'of journal ' + journal : 'matching the filters'; $('l-clear').hidden = !journal;
    try {
      const r = await api('lines', { page: lpage, journal });
      $('l-info').textContent = r.rows.length ? `Lines ${fmtInt(lpage * r.page_size + 1)} to ${fmtInt(lpage * r.page_size + r.rows.length)}` : 'No lines';
      $('l-prev').disabled = lpage <= 0; $('l-next').disabled = r.rows.length < r.page_size;
      if (!r.rows.length) return msgRow(tb, 26, 'No lines match these filters.');
      tb.replaceChildren(...r.rows.map((d) => {
        const tr = document.createElement('tr'); const dr = +d.debit, cr = +d.credit;
        td(tr, fmtDate(d.transdate)); td(tr, d.journalnum, 'gj-mono'); td(tr, d.voucher, 'gj-mono'); td(tr, d.le); td(tr, d.line, 'gj-r');
        td(tr, d.account_type); td(tr, d.account, 'gj-mono'); td(tr, d.gl_account, 'gj-mono'); td(tr, d.account_name);
        td(tr, d.offset_type); td(tr, d.offset_account, 'gj-mono'); td(tr, d.offset_gl, 'gj-mono'); td(tr, d.offset_name);
        td(tr, dr ? fmtMoney(dr) : '', 'gj-r'); td(tr, cr ? fmtMoney(cr) : '', 'gj-r gj-cr'); td(tr, d.currency); td(tr, d.exch_rate == null ? '' : fmtRate(d.exch_rate), 'gj-r');
        td(tr, d.transaction_type); td(tr, d.posting_type); td(tr, d.posting_profile); td(tr, d.description, 'gj-wrap'); td(tr, d.invoice); td(tr, d.document);
        td(tr, d.created_by); pill(td(tr, ''), d.status); td(tr, d.journal_description, 'gj-wrap');
        return tr;
      }));
    } catch (e) { $('l-info').textContent = ''; msgRow(tb, 26, 'Journal lines did not load. ' + e.message); }
  }
  async function loadAll() {
    const my = ++seq; const stale = () => my !== seq;
    $('page-error').hidden = true; renderSummary(null);
    note($('chart-month'), 'Loading monthly counts…'); note($('chart-entity'), 'Loading legal entities…');
    msgRow($('t-creators'), 6, 'Loading creators…'); msgRow($('t-currency'), 4, 'Loading currency totals…');
    const tasks = [
      api('summary').then((s) => !stale() && renderSummary(s)),
      api('by-month').then((r) => { if (!stale()) { lastMonth = r; renderMonth(r); } }).catch((e) => { if (!stale()) note($('chart-month'), 'Monthly counts did not load. ' + e.message); throw e; }),
      api('by-entity').then((r) => { if (!stale()) { lastEntity = r; renderEntity(r); } }).catch((e) => { if (!stale()) note($('chart-entity'), 'Legal entity counts did not load. ' + e.message); throw e; }),
      api('by-creator').then((r) => !stale() && renderCreators(r)).catch((e) => { if (!stale()) msgRow($('t-creators'), 6, 'Creators did not load. ' + e.message); throw e; }),
      api('by-currency').then((r) => !stale() && renderCurrency(r)).catch((e) => { if (!stale()) msgRow($('t-currency'), 4, 'Currency totals did not load. ' + e.message); throw e; }),
      api('creators').then((r) => !stale() && renderCreatorsOptions(r)).catch(() => {}),
      loadJournals(), loadLines()];
    const results = await Promise.allSettled(tasks);
    const failed = results.find((r) => r.status === 'rejected');
    if (failed && !stale()) { $('page-error').textContent = 'Some data did not load: ' + failed.reason.message; $('page-error').hidden = false; }
  }

  let lastW = 0;
  window.addEventListener('resize', () => { const w = $('chart-month').clientWidth; if (Math.abs(w - lastW) > 40) { lastW = w; if (lastMonth) renderMonth(lastMonth); if (lastEntity) renderEntity(lastEntity); } });
  syncControls();
  loadAll();
})();
