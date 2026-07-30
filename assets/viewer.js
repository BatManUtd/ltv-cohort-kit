'use strict';
/*
 * ltv-cohort-kit — viewer.js
 * UI wiring for index.html. Everything runs locally in this page:
 * no fetch, no XHR, no analytics, no external assets of any kind.
 */
(function () {
  const K = window.LTVKit;
  const $ = function (id) { return document.getElementById(id); };
  const state = {
    records: null,       // parsed orders CSV (array of arrays incl header)
    parseWarnings: [],
    fileName: '',
    lastResult: null     // {stats, cohortResult, ltvResult}
  };

  const FIELDS = [
    { key: 'orderId', label: 'Order ID', required: true, guess: [/^name$/i, /order.?(id|number|name|#)/i, /^order$/i, /^id$/i] },
    { key: 'customerId', label: 'Customer (email or ID)', required: true, guess: [/^email$/i, /customer.?email/i, /customer.?id/i, /customer/i, /email/i] },
    { key: 'date', label: 'Order date', required: true, guess: [/^created.?at$/i, /order.?date/i, /^date/i, /created/i, /paid.?at/i] },
    { key: 'total', label: 'Order total', required: true, guess: [/^total$/i, /order.?total/i, /^amount$/i, /total/i] },
    { key: 'refund', label: 'Refunded amount (optional)', required: false, guess: [/refunded.?amount/i, /refund/i] },
    { key: 'currency', label: 'Currency (optional)', required: false, guess: [/^currency$/i, /currenc/i] }
  ];

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function setStatus(msg, isError) {
    const el = $('statusLine');
    el.textContent = msg;
    el.className = isError ? 'status error' : 'status';
  }

  // ---------- orders file loading (streaming, with progress) ----------
  async function loadOrdersFile(file) {
    setStatus('Checking file…');
    $('results').hidden = true;
    const head = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
    const binErr = K.detectBinary(head);
    if (binErr) { setStatus(binErr, true); return; }
    const records = [];
    const parser = new K.CSVParser(function (rec) { records.push(rec); });
    const reader = file.stream().getReader();
    const decoder = new TextDecoder('utf-8');
    const bar = $('ordersProgress');
    bar.hidden = false; bar.value = 0; bar.max = 100;
    let read = 0, chunkN = 0;
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      read += r.value.byteLength;
      parser.write(decoder.decode(r.value, { stream: true }));
      bar.value = file.size ? Math.round((read / file.size) * 100) : 0;
      if (++chunkN % 16 === 0) { // yield so the tab never freezes
        setStatus('Parsing… ' + bar.value + '% (' + records.length.toLocaleString('en-US') + ' rows)');
        await new Promise(function (res) { setTimeout(res, 0); });
      }
    }
    parser.write(decoder.decode());
    const done = parser.end();
    bar.value = 100;
    state.records = records;
    state.parseWarnings = done.warnings;
    state.fileName = file.name;
    if (records.length < 2) { setStatus('No data rows found in ' + file.name + '.', true); return; }
    setStatus('Loaded ' + file.name + ': ' + (records.length - 1).toLocaleString('en-US') + ' data rows. Map the columns below, then Compute.');
    buildMappingUI(records[0]);
  }

  function buildMappingUI(header) {
    const box = $('mappingFields');
    box.innerHTML = '';
    const isShopify = header.indexOf('Name') !== -1 && header.indexOf('Created at') !== -1 && header.indexOf('Total') !== -1;
    $('presetNote').textContent = isShopify
      ? 'Shopify orders export detected — columns pre-mapped (Name / Email / Created at / Total / Refunded Amount / Currency). Line-item rows will be collapsed by order Name.'
      : 'Columns guessed from headers — check every mapping before computing.';
    FIELDS.forEach(function (f) {
      const label = document.createElement('label');
      label.textContent = f.label + ' ';
      const sel = document.createElement('select');
      sel.id = 'map-' + f.key;
      const optNone = document.createElement('option');
      optNone.value = '-1';
      optNone.textContent = f.required ? '— choose column —' : '— none —';
      sel.appendChild(optNone);
      header.forEach(function (h, i) {
        const opt = document.createElement('option');
        opt.value = String(i);
        opt.textContent = h || '(column ' + (i + 1) + ')';
        sel.appendChild(opt);
      });
      let idx = -1;
      for (const re of f.guess) {
        idx = header.findIndex(function (h) { return re.test(h.trim()); });
        if (idx !== -1) break;
      }
      sel.value = String(idx);
      label.appendChild(sel);
      box.appendChild(label);
    });
    $('mappingSection').hidden = false;
    $('computeBtn').disabled = false;
  }

  function currentMapping() {
    const m = {};
    for (const f of FIELDS) {
      const v = parseInt($('map-' + f.key).value, 10);
      if (v >= 0) m[f.key] = v;
      else if (f.required) return { error: 'Please map the required column: ' + f.label };
    }
    return m;
  }

  // ---------- spend input ----------
  function addSpendRow(month, amount) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td><input type="month" value="' + esc(month || '') + '"></td>' +
      '<td><input type="number" min="0" step="0.01" placeholder="0.00" value="' + esc(amount == null ? '' : amount) + '"></td>' +
      '<td><button type="button" class="ghost">remove</button></td>';
    tr.querySelector('button').addEventListener('click', function () { tr.remove(); });
    $('spendRows').appendChild(tr);
  }

  async function loadSpendFile(file) {
    const head = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
    const binErr = K.detectBinary(head);
    if (binErr) { setStatus('Spend file: ' + binErr, true); return; }
    const text = await file.text();
    const rows = K.parseCSV(text).rows;
    if (rows.length < 2) { setStatus('Spend file has no data rows.', true); return; }
    const header = rows[0];
    let mi = header.findIndex(function (h) { return /month|date/i.test(h); });
    let si = header.findIndex(function (h) { return /spend|cost|amount|budget/i.test(h); });
    let start = 1;
    if (mi === -1 || si === -1) { mi = 0; si = 1; start = /[a-z]/i.test(header[1] || '') ? 1 : 0; }
    $('spendRows').innerHTML = '';
    let bad = 0;
    for (let i = start; i < rows.length; i++) {
      const mRaw = String(rows[i][mi] || '').trim();
      let key = null;
      if (/^\d{4}-\d{2}$/.test(mRaw)) key = mRaw;
      else {
        const d = K.parseDate(mRaw);
        if (d && !d.ambiguous) key = K.monthKey(d.y, d.m);
      }
      const sp = K.parseMoney(rows[i][si]);
      if (!key || !sp) { bad++; continue; }
      addSpendRow(key, sp.value);
    }
    setStatus('Spend file loaded: ' + $('spendRows').children.length + ' months.' + (bad ? ' ' + bad + ' unparseable row(s) skipped.' : ''));
  }

  function getSpendMap() {
    const spend = {};
    Array.prototype.forEach.call($('spendRows').querySelectorAll('tr'), function (tr) {
      const inputs = tr.querySelectorAll('input');
      const mo = inputs[0].value, amt = inputs[1].value;
      if (/^\d{4}-\d{2}$/.test(mo) && amt !== '' && isFinite(+amt)) spend[mo] = +amt;
    });
    return spend;
  }

  // ---------- compute + render ----------
  function compute() {
    if (!state.records) return;
    const mapping = currentMapping();
    if (mapping.error) { setStatus(mapping.error, true); return; }
    const fmtEl = document.querySelector('input[name="dateFormat"]:checked');
    const opts = fmtEl ? { dateFormat: fmtEl.value } : {};
    const collapsed = K.collapseOrders(state.records, mapping, opts);
    if (collapsed.stats.needsDateFormat && !fmtEl) {
      $('dateFormatSection').hidden = false;
      $('dateSamples').textContent = collapsed.stats.ambiguousSamples.join('   ');
      setStatus('Ambiguous dates like "' + collapsed.stats.ambiguousSamples[0] + '" found — pick a date format above, then Compute again. We will not guess.', true);
      return;
    }
    const asOf = $('asOfInput').value || undefined;
    const minSize = parseInt($('minCohortInput').value, 10) || 30;
    const marginPct = parseFloat($('marginInput').value);
    if (!isFinite(marginPct) || marginPct < 0 || marginPct > 100) { setStatus('Gross margin must be between 0 and 100.', true); return; }
    let cohortResult;
    try {
      cohortResult = K.computeCohorts(collapsed.orders, { asOf: asOf, minCohortSize: minSize });
    } catch (e) { setStatus(String(e.message || e), true); return; }
    const ltvResult = K.computeLTV(cohortResult, getSpendMap(), marginPct);
    state.lastResult = { stats: collapsed.stats, cohortResult: cohortResult, ltvResult: ltvResult };
    render();
  }

  function render() {
    const r = state.lastResult;
    $('results').hidden = false;
    $('summaryLine').textContent = K.formatSummary(r.stats) + '   (as of ' + r.cohortResult.asOfMonth + '; complete through ' + r.cohortResult.lastCompleteMonth + ')';
    $('marginEcho').textContent = String(r.ltvResult.marginPct);
    const warns = state.parseWarnings.concat(r.stats.warnings, r.ltvResult.spendWarnings);
    $('warningsBox').innerHTML = warns.length
      ? warns.map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('')
      : '<li class="ok">No warnings.</li>';
    // skipped rows: every error carries the row number and offending value
    const sk = r.stats.skipped;
    $('skippedSummary').textContent = sk.length
      ? sk.length + ' malformed row(s) were skipped (listed below with row numbers) — never silently dropped.'
      : 'No rows were skipped.';
    $('skippedBox').innerHTML = sk.slice(0, 200).map(function (s) {
      return '<tr><td>' + s.row + '</td><td>' + esc(s.reason) + '</td><td>' + esc(s.value) + '</td></tr>';
    }).join('');
    $('skippedTable').hidden = sk.length === 0;
    renderHeatmap();
    $('curvesBox').innerHTML = K.curvesSVG(r.cohortResult, r.ltvResult);
    renderPaybackTable();
    setStatus('Computed. Review the warnings, then export any table as CSV.');
  }

  function renderHeatmap() {
    const r = state.lastResult;
    if (!r) return;
    const mode = document.querySelector('input[name="heatMode"]:checked').value;
    $('heatmapBox').innerHTML = K.heatmapSVG(r.cohortResult, mode, r.ltvResult);
  }

  function renderPaybackTable() {
    const r = state.lastResult;
    const fm = K.formatMoney;
    let html = '<tr><th>Cohort</th><th>New customers</th><th>CAC</th><th>Observed LTV/customer</th><th>Payback month</th></tr>';
    r.ltvResult.rows.forEach(function (row) {
      const lastLtv = row.ltv.filter(function (v) { return v != null; }).pop();
      const cac = row.cacStatus === 'ok' ? '$' + fm(row.cac)
        : row.cacStatus === 'no_spend' ? 'CAC unavailable (no spend entered)' : 'CAC undefined (0 new customers)';
      const pb = row.cacStatus !== 'ok' ? '—'
        : row.payback != null ? 'M' + row.payback : 'not yet (within observed months)';
      html += '<tr' + (row.lowConfidence ? ' class="lowconf"' : '') + '><td>' + row.month + (row.lowConfidence ? '*' : '') + '</td><td>' +
        row.newCustomers + '</td><td>' + cac + '</td><td>' + (lastLtv == null ? 'all censored' : '$' + fm(lastLtv)) + '</td><td>' + pb + '</td></tr>';
    });
    $('paybackTable').innerHTML = html;
  }

  // ---------- CSV exports ----------
  function download(name, rows) {
    const blob = new Blob([K.tableToCSV(rows)], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
  }
  function headerRow(cr, label) {
    const h = ['cohort_month', 'new_customers'];
    for (let k = 0; k <= cr.maxOffset; k++) h.push(label + '_m' + k);
    return h;
  }
  function exportCells(kind) {
    const r = state.lastResult;
    if (!r) return;
    const cr = r.cohortResult;
    const rows = [headerRow(cr, kind)];
    cr.cohorts.forEach(function (c, ci) {
      const line = [c.month, c.newCustomers];
      c.cells.forEach(function (cell, k) {
        if (kind === 'ltv_per_customer') {
          const v = r.ltvResult.rows[ci].ltv[k];
          line.push(v == null ? 'censored' : v.toFixed(2));
        } else if (cell.censored) line.push('censored');
        else if (kind === 'net_revenue') line.push(cell.revenue.toFixed(2));
        else if (kind === 'cumulative_net_revenue') line.push(cell.cumRevenue.toFixed(2));
        else line.push(cell.retention.toFixed(4));
      });
      rows.push(line);
    });
    download('ltv-cohort-kit_' + kind + '.csv', rows);
  }
  function exportPayback() {
    const r = state.lastResult;
    if (!r) return;
    const rows = [['cohort_month', 'new_customers', 'low_confidence', 'spend', 'cac', 'cac_status', 'payback_month', 'margin_pct']];
    const spend = getSpendMap();
    r.ltvResult.rows.forEach(function (row) {
      rows.push([row.month, row.newCustomers, row.lowConfidence ? 'yes' : 'no',
        spend[row.month] != null ? spend[row.month] : '',
        row.cac != null ? row.cac.toFixed(2) : '', row.cacStatus,
        row.payback != null ? row.payback : '', r.ltvResult.marginPct]);
    });
    download('ltv-cohort-kit_cac_payback.csv', rows);
  }

  // ---------- wiring ----------
  document.addEventListener('DOMContentLoaded', function () {
    $('ordersFile').addEventListener('change', function (e) {
      if (e.target.files[0]) loadOrdersFile(e.target.files[0]).catch(function (err) { setStatus('Failed to read file: ' + err.message, true); });
    });
    $('spendFile').addEventListener('change', function (e) {
      if (e.target.files[0]) loadSpendFile(e.target.files[0]).catch(function (err) { setStatus('Failed to read spend file: ' + err.message, true); });
    });
    $('addSpendRow').addEventListener('click', function () { addSpendRow('', null); });
    $('computeBtn').addEventListener('click', compute);
    Array.prototype.forEach.call(document.querySelectorAll('input[name="heatMode"]'), function (el) {
      el.addEventListener('change', renderHeatmap);
    });
    $('exportRevenue').addEventListener('click', function () { exportCells('net_revenue'); });
    $('exportCumRevenue').addEventListener('click', function () { exportCells('cumulative_net_revenue'); });
    $('exportRetention').addEventListener('click', function () { exportCells('retention'); });
    $('exportLtv').addEventListener('click', function () { exportCells('ltv_per_customer'); });
    $('exportPayback').addEventListener('click', exportPayback);
    const today = new Date();
    $('asOfInput').value = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
  });
})();
