'use strict';
/*
 * ltv-cohort-kit — charts.js
 * Hand-rolled SVG: cohort heatmap and payback curves. No libraries, no
 * network. Attaches to window.LTVKit.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) { root.LTVKit = root.LTVKit || {}; Object.assign(root.LTVKit, api); }
})(typeof self !== 'undefined' ? self : typeof globalThis !== 'undefined' ? globalThis : null, function () {

  const PALETTE = ['#2563eb', '#059669', '#d97706', '#dc2626', '#7c3aed', '#0891b2', '#be185d', '#4d7c0f', '#b45309', '#1e40af', '#0f766e', '#9333ea'];

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function money(v) {
    const sign = v < 0 ? '-' : '';
    return sign + Math.abs(v).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  // interpolate white -> color by t in [0,1]
  function shade(hex, t) {
    const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
    const mix = (c) => Math.round(255 + (c - 255) * Math.max(0, Math.min(1, t)));
    return 'rgb(' + mix(r) + ',' + mix(g) + ',' + mix(b) + ')';
  }
  function textColor(t) { return t > 0.55 ? '#ffffff' : '#1f2937'; }

  const CENSOR_DEFS =
    '<defs><pattern id="censor" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">' +
    '<rect width="7" height="7" fill="#f1f3f6"/><line x1="0" y1="0" x2="0" y2="7" stroke="#cdd3dc" stroke-width="2.5"/>' +
    '</pattern></defs>';

  /**
   * Cohort heatmap. mode: 'retention' (repeat-purchase rate) or 'ltv'
   * (cumulative margin-adjusted LTV per customer; needs ltvResult).
   * Censored cells are hatched grey — never rendered as zeros.
   */
  function heatmapSVG(cohortResult, mode, ltvResult) {
    const cohorts = cohortResult.cohorts;
    if (!cohorts.length) return '<p>No cohorts to display.</p>';
    const nCols = cohortResult.maxOffset + 1;
    const labelW = 128, cellW = 62, cellH = 30, headH = 26, footH = 22;
    const W = labelW + nCols * cellW + 8, H = headH + cohorts.length * cellH + footH;
    const color = mode === 'ltv' ? '#059669' : '#2563eb';
    let maxV = 0;
    const cellVal = function (ci, k) {
      if (mode === 'ltv') {
        const v = ltvResult.rows[ci].ltv[k];
        return v == null ? null : v;
      }
      const cell = cohorts[ci].cells[k];
      return cell.censored ? null : cell.retention;
    };
    for (let ci = 0; ci < cohorts.length; ci++) {
      for (let k = 0; k < nCols; k++) {
        const v = cellVal(ci, k);
        if (v != null && v > maxV) maxV = v;
      }
    }
    if (maxV <= 0) maxV = 1;
    let s = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" font-family="system-ui,sans-serif" font-size="11">' + CENSOR_DEFS;
    for (let k = 0; k < nCols; k++) {
      s += '<text x="' + (labelW + k * cellW + cellW / 2) + '" y="' + (headH - 9) + '" text-anchor="middle" fill="#475569">M' + k + '</text>';
    }
    cohorts.forEach(function (c, ci) {
      const y = headH + ci * cellH;
      const label = c.month + ' (' + c.newCustomers + (c.lowConfidence ? '*' : '') + ')';
      s += '<text x="' + (labelW - 8) + '" y="' + (y + cellH / 2 + 4) + '" text-anchor="end" fill="' + (c.lowConfidence ? '#b45309' : '#1f2937') + '">' + esc(label) + '</text>';
      for (let k = 0; k < nCols; k++) {
        const x = labelW + k * cellW;
        const v = cellVal(ci, k);
        if (v == null) {
          s += '<rect x="' + x + '" y="' + y + '" width="' + (cellW - 2) + '" height="' + (cellH - 2) + '" fill="url(#censor)" rx="3"><title>' + c.month + ' +M' + k + ': censored (month not fully elapsed)</title></rect>';
        } else {
          const t = v / maxV;
          const txt = mode === 'ltv' ? money(v) : Math.round(v * 100) + '%';
          s += '<rect x="' + x + '" y="' + y + '" width="' + (cellW - 2) + '" height="' + (cellH - 2) + '" fill="' + shade(color, t) + '" rx="3"><title>' + c.month + ' +M' + k + ': ' + txt + '</title></rect>';
          s += '<text x="' + (x + (cellW - 2) / 2) + '" y="' + (y + cellH / 2 + 4) + '" text-anchor="middle" fill="' + textColor(t) + '">' + txt + '</text>';
        }
      }
    });
    s += '<text x="0" y="' + (H - 6) + '" fill="#64748b">Hatched = censored (period not fully elapsed as of ' + esc(cohortResult.asOfMonth) + ').  * = fewer than ' + cohortResult.minCohortSize + ' customers (low confidence).</text>';
    return s + '</svg>';
  }

  /**
   * Payback curves: cumulative margin-adjusted LTV per customer by month
   * offset, one line per cohort; dashed horizontal line at each cohort's CAC.
   * Censored offsets are simply not drawn.
   */
  function curvesSVG(cohortResult, ltvResult) {
    const rows = ltvResult.rows;
    if (!rows.length) return '<p>No cohorts to display.</p>';
    const W = 760, H = 340, mL = 64, mR = 160, mT = 18, mB = 40;
    const pw = W - mL - mR, ph = H - mT - mB;
    let maxX = 1, maxY = 0;
    rows.forEach(function (r) {
      r.ltv.forEach(function (v, k) { if (v != null) { if (k > maxX) maxX = k; if (v > maxY) maxY = v; } });
      if (r.cac != null && r.cac > maxY) maxY = r.cac;
    });
    if (maxY <= 0) maxY = 1;
    maxY *= 1.08;
    const X = function (k) { return mL + (k / maxX) * pw; };
    const Y = function (v) { return mT + ph - (v / maxY) * ph; };
    let s = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" font-family="system-ui,sans-serif" font-size="11">';
    // gridlines + y labels
    for (let i = 0; i <= 4; i++) {
      const v = (maxY / 4) * i, y = Y(v);
      s += '<line x1="' + mL + '" y1="' + y + '" x2="' + (mL + pw) + '" y2="' + y + '" stroke="#e2e8f0"/>';
      s += '<text x="' + (mL - 8) + '" y="' + (y + 4) + '" text-anchor="end" fill="#64748b">' + money(v) + '</text>';
    }
    for (let k = 0; k <= maxX; k++) {
      s += '<text x="' + X(k) + '" y="' + (H - mB + 16) + '" text-anchor="middle" fill="#64748b">M' + k + '</text>';
    }
    s += '<text x="' + (mL + pw / 2) + '" y="' + (H - 6) + '" text-anchor="middle" fill="#475569">months since first order (observed months only — censored periods not drawn)</text>';
    rows.forEach(function (r, i) {
      const col = PALETTE[i % PALETTE.length];
      const pts = [];
      r.ltv.forEach(function (v, k) { if (v != null) pts.push([X(k), Y(v), k, v]); });
      if (!pts.length) return;
      if (r.cac != null) {
        s += '<line x1="' + mL + '" y1="' + Y(r.cac) + '" x2="' + (mL + pw) + '" y2="' + Y(r.cac) + '" stroke="' + col + '" stroke-dasharray="5,4" opacity="0.45"><title>' + r.month + ' CAC ' + money(r.cac) + '</title></line>';
      }
      s += '<polyline fill="none" stroke="' + col + '" stroke-width="2" points="' + pts.map(function (p) { return p[0] + ',' + p[1]; }).join(' ') + '"/>';
      pts.forEach(function (p) {
        const pb = r.payback != null && p[2] === r.payback;
        s += '<circle cx="' + p[0] + '" cy="' + p[1] + '" r="' + (pb ? 5 : 3) + '" fill="' + col + '"' + (pb ? ' stroke="#111827" stroke-width="1.5"' : '') + '><title>' + r.month + ' M' + p[2] + ': LTV ' + money(p[3]) + (pb ? ' — payback reached' : '') + '</title></circle>';
      });
      // legend
      const ly = mT + 14 + i * 16;
      const cacTxt = r.cacStatus === 'ok' ? 'CAC ' + money(r.cac) : 'CAC unavailable';
      const pbTxt = r.cacStatus !== 'ok' ? '' : (r.payback != null ? ', payback M' + r.payback : ', no payback yet');
      s += '<rect x="' + (mL + pw + 12) + '" y="' + (ly - 9) + '" width="10" height="10" fill="' + col + '" rx="2"/>';
      s += '<text x="' + (mL + pw + 27) + '" y="' + ly + '" fill="#1f2937">' + esc(r.month + (r.lowConfidence ? '*' : '') + ' — ' + cacTxt + pbTxt) + '</text>';
    });
    return s + '</svg>';
  }

  return { heatmapSVG, curvesSVG, chartPalette: PALETTE, formatMoney: money };
});
