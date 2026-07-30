'use strict';
/*
 * ltv-cohort-kit — cohort.js
 * Order collapse (Shopify one-row-per-line-item handling), cohort assignment,
 * retention, cumulative net revenue with right-censoring, CAC and payback.
 * Zero dependencies; browser (window.LTVKit) + node.
 *
 * Methodology (also displayed verbatim in the viewer):
 *  - Cohort  = calendar month of a customer's first order (by the date written
 *    in the export; no timezone conversion is applied).
 *  - Net revenue = order total minus the refund-column amount. Refund-column
 *    amounts reduce the MONTH OF THE ORIGINAL ORDER (Shopify's export carries
 *    no refund date, so this is the only attribution that never guesses).
 *    Standalone negative-total rows reduce the month THEY occur in.
 *  - Retention: a customer counts as active in a month if they placed at least
 *    one order with total >= 0 that month. $0 orders count for retention but
 *    add no revenue. Negative-total rows never count as retention activity.
 *  - Right-censoring: a cohort cell (cohort month + offset k) is observed only
 *    if that calendar month ended before the as-of date. Later cells —
 *    including the current partial month — are censored, never shown as zeros.
 *  - LTV(k)  = cumulative net revenue through offset k / cohort size x margin%.
 *  - CAC     = monthly ad spend / new customers acquired that month.
 *  - Payback = first observed offset k with LTV(k) >= CAC.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./parse.js'));
  } else if (root) {
    root.LTVKit = root.LTVKit || {};
    Object.assign(root.LTVKit, factory(root.LTVKit));
  }
})(typeof self !== 'undefined' ? self : typeof globalThis !== 'undefined' ? globalThis : null, function (P) {

  /**
   * Collapse raw CSV records into deduplicated orders.
   * Shopify exports one row per LINE ITEM: the order Name repeats and the
   * totals/email/date appear only on the first row of each order. We group by
   * order id and take the FIRST NON-EMPTY value of each field, so line-item
   * rows never double-count revenue. One-row-per-order exports (WooCommerce)
   * pass through unchanged.
   *
   * @param {string[][]} records  parsed CSV incl. header row (records[0])
   * @param {object} mapping  column indexes {orderId, customerId, date, total,
   *                          refund (optional), currency (optional)}
   * @param {object} opts  {dateFormat: 'mdy'|'dmy'} for ambiguous dates
   * @returns {{orders: object[], stats: object}}
   */
  function collapseOrders(records, mapping, opts) {
    const o = opts || {};
    const stats = {
      dataRows: 0, orders: 0, customers: 0,
      skipped: [],                     // [{row, reason, value}]
      excluded: { orders: 0, revenue: 0, revenueShare: 0 }, // blank customer id
      currencies: [], warnings: [],
      needsDateFormat: false, ambiguousSamples: []
    };
    const get = function (row, idx) {
      if (idx == null || idx < 0 || idx >= row.length) return '';
      return String(row[idx]).trim();
    };
    const orderMap = new Map();
    for (let i = 1; i < records.length; i++) {
      const row = records[i];
      const rowNum = i + 1; // 1-based, header = row 1
      stats.dataRows++;
      let id = get(row, mapping.orderId);
      if (!id) {
        if (!get(row, mapping.total)) {
          stats.skipped.push({ row: rowNum, reason: 'no order id and no total', value: row.join(',').slice(0, 120) });
          continue;
        }
        id = '__row_' + rowNum; // orderless row with a total: its own order
      }
      let ord = orderMap.get(id);
      if (!ord) {
        ord = { id, firstRow: rowNum, customerRaw: '', dateRaw: '', totalRaw: '', refundRaw: '', currencyRaw: '' };
        orderMap.set(id, ord);
      }
      if (!ord.customerRaw) ord.customerRaw = get(row, mapping.customerId);
      if (!ord.dateRaw) ord.dateRaw = get(row, mapping.date);
      if (!ord.totalRaw) ord.totalRaw = get(row, mapping.total);
      if (!ord.refundRaw && mapping.refund != null) ord.refundRaw = get(row, mapping.refund);
      if (!ord.currencyRaw && mapping.currency != null) ord.currencyRaw = get(row, mapping.currency);
    }
    const orders = [];
    const currencies = new Set();
    const custSet = new Set();
    const hasCurrencyCol = mapping.currency != null;
    let includedRevenue = 0;
    for (const ord of orderMap.values()) {
      const rowNum = ord.firstRow;
      if (!ord.totalRaw) {
        stats.skipped.push({ row: rowNum, reason: 'order "' + ord.id + '" has no total on any of its rows', value: '(empty)' });
        continue;
      }
      const money = P.parseMoney(ord.totalRaw);
      if (!money) {
        stats.skipped.push({ row: rowNum, reason: 'unparseable total', value: ord.totalRaw });
        continue;
      }
      let refund = 0;
      if (ord.refundRaw) {
        const rm = P.parseMoney(ord.refundRaw);
        if (rm) refund = Math.abs(rm.value);
        else stats.skipped.push({ row: rowNum, reason: 'unparseable refund (treated as 0, order kept)', value: ord.refundRaw });
      }
      const d = P.parseDate(ord.dateRaw, o);
      if (!d) {
        stats.skipped.push({ row: rowNum, reason: 'unparseable date', value: ord.dateRaw || '(empty)' });
        continue;
      }
      if (d.ambiguous) {
        stats.needsDateFormat = true;
        if (stats.ambiguousSamples.length < 3) stats.ambiguousSamples.push(ord.dateRaw);
        continue;
      }
      if (hasCurrencyCol) {
        if (ord.currencyRaw) currencies.add(ord.currencyRaw.toUpperCase());
      } else if (money.currency) {
        currencies.add(money.currency);
      }
      const net = money.value - refund;
      const customer = ord.customerRaw ? ord.customerRaw.toLowerCase() : '';
      if (!customer) {
        stats.excluded.orders++;
        stats.excluded.revenue += net;
        continue;
      }
      custSet.add(customer);
      includedRevenue += net;
      orders.push({ id: ord.id, customer, y: d.y, m: d.m, day: d.d, monthIdx: d.y * 12 + d.m - 1, net, row: rowNum });
    }
    stats.orders = orders.length + stats.excluded.orders;
    stats.customers = custSet.size;
    stats.currencies = Array.from(currencies).sort();
    if (currencies.size > 1) {
      stats.warnings.push('Multiple currencies detected (' + stats.currencies.join(', ') + '). Amounts were summed WITHOUT conversion — results are unreliable. Filter your export to a single currency.');
    }
    const totalRev = includedRevenue + stats.excluded.revenue;
    stats.excluded.revenueShare = totalRev > 0 ? stats.excluded.revenue / totalRev : 0;
    if (stats.excluded.orders > 0) {
      stats.warnings.push(stats.excluded.orders + ' order(s) with a blank customer identifier were excluded (' +
        (stats.excluded.revenueShare * 100).toFixed(1) + '% of net revenue). They cannot be assigned to a cohort.');
    }
    if (stats.excluded.revenueShare > 0.05) {
      stats.warnings.push('Excluded orders exceed 5% of net revenue — cohort and LTV results are UNRELIABLE. Re-export with a customer email or ID on every order.');
    }
    return { orders, stats };
  }

  /**
   * Build the cohort table with right-censoring.
   * @param {object[]} orders  from collapseOrders
   * @param {object} opts  {asOf: 'YYYY-MM-DD'|Date (default now),
   *                        minCohortSize: number (default 30)}
   * @returns {{cohorts, maxOffset, asOfMonth, lastCompleteMonth, minCohortSize}}
   * Each cohort: {month, newCustomers, lowConfidence, partial, cells[]}
   * Each cell: {offset, censored} plus, when observed:
   *   {revenue, cumRevenue, active, retention}
   */
  function computeCohorts(orders, opts) {
    const o = opts || {};
    let asOfIdx;
    if (typeof o.asOf === 'string') {
      const d = P.parseDate(o.asOf);
      if (!d || d.ambiguous) throw new Error('computeCohorts: asOf must be an ISO date, got ' + o.asOf);
      asOfIdx = d.y * 12 + d.m - 1;
    } else {
      const now = o.asOf instanceof Date ? o.asOf : new Date();
      asOfIdx = now.getFullYear() * 12 + now.getMonth();
    }
    const lastComplete = asOfIdx - 1; // last fully elapsed calendar month
    const minSize = o.minCohortSize != null ? o.minCohortSize : 30;
    const byCustomer = new Map();
    for (const ord of orders) {
      let c = byCustomer.get(ord.customer);
      if (!c) { c = { first: Infinity, orders: [] }; byCustomer.set(ord.customer, c); }
      if (ord.monthIdx < c.first) c.first = ord.monthIdx;
      c.orders.push(ord);
    }
    const cohortMap = new Map(); // cohortIdx -> {n, cells: Map(offset -> {revenue, active:Set})}
    for (const entry of byCustomer.entries()) {
      const cust = entry[0], c = entry[1];
      let coh = cohortMap.get(c.first);
      if (!coh) { coh = { n: 0, cells: new Map() }; cohortMap.set(c.first, coh); }
      coh.n++;
      for (const ord of c.orders) {
        const k = ord.monthIdx - c.first;
        let cell = coh.cells.get(k);
        if (!cell) { cell = { revenue: 0, active: new Set() }; coh.cells.set(k, cell); }
        cell.revenue += ord.net;
        if (ord.net >= 0) cell.active.add(cust); // $0 counts, negatives never
      }
    }
    const cohortIdxs = Array.from(cohortMap.keys()).sort(function (a, b) { return a - b; });
    let maxOffset = 0;
    if (cohortIdxs.length > 0) maxOffset = Math.max(0, asOfIdx - cohortIdxs[0]);
    const cohorts = cohortIdxs.map(function (ci) {
      const coh = cohortMap.get(ci);
      const observedMax = lastComplete - ci; // may be negative (all censored)
      const cells = [];
      let cum = 0;
      for (let k = 0; k <= maxOffset; k++) {
        if (k <= observedMax) {
          const cell = coh.cells.get(k);
          const rev = cell ? cell.revenue : 0;
          const act = cell ? cell.active.size : 0;
          cum += rev;
          cells.push({ offset: k, censored: false, revenue: rev, cumRevenue: cum, active: act, retention: coh.n > 0 ? act / coh.n : 0 });
        } else {
          cells.push({ offset: k, censored: true });
        }
      }
      return {
        month: P.keyOfMonthIndex(ci),
        newCustomers: coh.n,
        lowConfidence: coh.n < minSize,
        partial: ci >= asOfIdx, // cohort month itself not fully elapsed
        cells
      };
    });
    return {
      cohorts,
      maxOffset,
      asOfMonth: P.keyOfMonthIndex(asOfIdx),
      lastCompleteMonth: P.keyOfMonthIndex(lastComplete),
      minCohortSize: minSize
    };
  }

  /**
   * Margin-adjusted LTV per customer, CAC per cohort, and payback month.
   * @param {object} cohortResult  from computeCohorts
   * @param {object} spendByMonth  {'YYYY-MM': number} marketing spend
   * @param {number} marginPct  gross margin percent (e.g. 60)
   * @returns {{rows, marginPct, spendWarnings}}
   * Each row: {month, newCustomers, lowConfidence, cac, cacStatus, ltv[], payback}
   *   cacStatus: 'ok' | 'no_spend' (CAC unavailable) | 'no_customers'
   *   ltv[k] is null for censored offsets; payback null if not reached/unknown.
   */
  function computeLTV(cohortResult, spendByMonth, marginPct) {
    const spend = spendByMonth || {};
    const margin = (marginPct == null ? 100 : marginPct) / 100;
    const rows = cohortResult.cohorts.map(function (c) {
      const hasSpend = Object.prototype.hasOwnProperty.call(spend, c.month) &&
        spend[c.month] != null && spend[c.month] !== '' && isFinite(spend[c.month]);
      let cac = null, cacStatus;
      if (!hasSpend) cacStatus = 'no_spend';
      else if (c.newCustomers === 0) cacStatus = 'no_customers'; // division-by-zero guard
      else { cac = Number(spend[c.month]) / c.newCustomers; cacStatus = 'ok'; }
      const ltv = c.cells.map(function (cell) {
        if (cell.censored || c.newCustomers === 0) return null;
        return (cell.cumRevenue / c.newCustomers) * margin;
      });
      let payback = null;
      if (cacStatus === 'ok') {
        for (let k = 0; k < ltv.length; k++) {
          if (ltv[k] != null && ltv[k] >= cac - 1e-9) { payback = k; break; }
        }
      }
      return { month: c.month, newCustomers: c.newCustomers, lowConfidence: c.lowConfidence, cac, cacStatus, ltv, payback };
    });
    const spendWarnings = [];
    for (const mo of Object.keys(spend)) {
      if (spend[mo] == null || spend[mo] === '') continue;
      const found = cohortResult.cohorts.some(function (c) { return c.month === mo; });
      if (!found) spendWarnings.push('Spend of ' + spend[mo] + ' recorded for ' + mo + ' but no new customers were acquired that month — CAC is undefined for that spend (not treated as CAC = 0).');
    }
    return { rows, marginPct: marginPct == null ? 100 : marginPct, spendWarnings };
  }

  /** "12,431 rows -> 8,902 orders -> 3,114 customers" sanity-check line. */
  function formatSummary(stats) {
    const f = function (n) { return n.toLocaleString('en-US'); };
    return f(stats.dataRows) + ' rows → ' + f(stats.orders) + ' orders → ' + f(stats.customers) + ' customers';
  }

  return { collapseOrders, computeCohorts, computeLTV, formatSummary };
});
