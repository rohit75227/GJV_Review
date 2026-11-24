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
    const res = await fetch(`/api/${path}?${qs(extra)}`, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    if (res.status === 401 || res.status === 403) throw new Error('Your sign-in has expired. Reload the page to sign in again.');
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || body.detail || `The server answered ${res.status}.`);
    return body;
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

  // ---------- export
  $('x-export').addEventListener('click', async () => {
    const btn = $('x-export'), st = $('x-status');
    btn.disabled = true; st.dataset.tone = ''; st.textContent = 'Building the Excel file. A full year can take a minute or two.';
    try {
      const res = await fetch(`/api/export?${qs()}`, { credentials: 'same-origin' });
      if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b.error || b.detail || `The server answered ${res.status}.`); }
      const blob = await res.blob();
      const cd = res.headers.get('Content-Disposition') || '';
      const name = (/filename="([^"]+)"/.exec(cd) || [])[1] || 'GJV journals.xlsx';
      const url = URL.createObjectURL(blob); const a = document.createElement('a');
      a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000);
      st.dataset.tone = 'ok'; st.textContent = `Downloaded ${name}.`;
    } catch (e) { st.dataset.tone = 'bad'; st.textContent = 'Export failed. ' + e.message; }
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
