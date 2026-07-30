'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseCSV } = require('../src/csv.js');
const { collapseOrders, computeCohorts, computeLTV, formatSummary } = require('../src/cohort.js');

const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, (msg || '') + ' expected ' + b + ' got ' + a);

// Shopify-style mapping for the fixture file.
const MAP = { orderId: 0, customerId: 1, date: 2, total: 3, refund: 4, currency: 5 };

function loadFixture() {
  const text = fs.readFileSync(path.join(__dirname, 'fixtures', 'shopify_orders.csv'), 'utf8');
  return parseCSV(text).rows;
}

/*
 * Fixture hand-computed ground truth (asOf 2025-04-15, so complete through March):
 *   9 data rows; order #1001 has 2 line-item rows (totals only on first row).
 *   Orders: #1001 ann Jan 100; #1002 bob Jan 50; #1003 ann Feb 40 - 10 refund = 30;
 *           #1004 guest Jan 25 (excluded); #1005 bob Jan (same day as #1002) 0.00;
 *           #1006 cara Mar 200; #1007 ann Apr 500 (current partial month);
 *           #1008 dana Feb 80.
 *   Cohorts: 2025-01 {ann, bob}, 2025-02 {dana}, 2025-03 {cara}.
 */
test('Shopify line-item collapse: no double-count, correct summary line', () => {
  const { orders, stats } = collapseOrders(loadFixture(), MAP);
  assert.equal(stats.dataRows, 9);
  assert.equal(stats.orders, 8);      // 7 cohortable + 1 excluded guest order
  assert.equal(stats.customers, 4);   // ann, bob, cara, dana
  assert.equal(orders.length, 7);
  const o1001 = orders.find(o => o.id === '#1001');
  assert.equal(o1001.net, 100);       // NOT 200: second line-item row added nothing
  assert.equal(formatSummary(stats), '9 rows → 8 orders → 4 customers');
});

test('guest checkout: blank email excluded with count and revenue share', () => {
  const { stats } = collapseOrders(loadFixture(), MAP);
  assert.equal(stats.excluded.orders, 1);
  close(stats.excluded.revenue, 25);
  // net included revenue = 100+50+30+0+200+500+80 = 960; total = 985
  close(stats.excluded.revenueShare, 25 / 985);
  assert.ok(stats.warnings.some(w => /blank customer identifier/.test(w)));
  // 2.5% is under the 5% threshold: no unreliability warning
  assert.ok(!stats.warnings.some(w => /UNRELIABLE/.test(w)));
});

test('exclusions above 5% of revenue trigger the unreliable-results warning', () => {
  const rows = [
    ['Order', 'Email', 'Date', 'Total'],
    ['1', 'a@x.com', '2025-01-05', '100'],
    ['2', '', '2025-01-06', '50']  // 33% of revenue has no identity
  ];
  const { stats } = collapseOrders(rows, { orderId: 0, customerId: 1, date: 2, total: 3 });
  assert.ok(stats.warnings.some(w => /UNRELIABLE/.test(w)));
});

test('refund column reduces net revenue in the ORIGINAL order month', () => {
  const { orders } = collapseOrders(loadFixture(), MAP);
  const o1003 = orders.find(o => o.id === '#1003');
  assert.equal(o1003.net, 30);      // 40 - 10 refund
  assert.equal(o1003.m, 2);         // attributed to February, the order month
  const res = computeCohorts(orders, { asOf: '2025-04-15', minCohortSize: 30 });
  const jan = res.cohorts.find(c => c.month === '2025-01');
  close(jan.cells[1].revenue, 30);  // offset 1 (Feb) carries the refund-reduced net
});

test('standalone negative row reduces the month it occurs in, not the cohort month', () => {
  const rows = [
    ['Order', 'Email', 'Date', 'Total'],
    ['1', 'a@x.com', '2025-01-05', '100'],
    ['2', 'a@x.com', '2025-02-14', '(30.00)'] // refund issued as its own negative order
  ];
  const { orders } = collapseOrders(rows, { orderId: 0, customerId: 1, date: 2, total: 3 });
  const res = computeCohorts(orders, { asOf: '2025-03-10', minCohortSize: 1 });
  const c = res.cohorts[0];
  close(c.cells[0].revenue, 100);
  close(c.cells[1].revenue, -30);      // negative attributed to February
  close(c.cells[1].cumRevenue, 70);
  assert.equal(c.cells[1].active, 0);  // a refund is not retention activity
});

test('same-day repeat orders and $0 orders: retention yes, revenue no', () => {
  const { orders, stats } = collapseOrders(loadFixture(), MAP);
  // #1002 and #1005 are distinct same-day orders by bob: both survive dedupe.
  assert.equal(orders.filter(o => o.customer === 'bob@example.com').length, 2);
  assert.equal(stats.orders, 8);
  const res = computeCohorts(orders, { asOf: '2025-04-15' });
  const jan = res.cohorts.find(c => c.month === '2025-01');
  close(jan.cells[0].revenue, 150);      // 100 + 50 + 0 — the $0 order adds nothing
  assert.equal(jan.cells[0].active, 2);  // but bob still counts as active
});

test('known-answer cohort table (asOf 2025-04-15)', () => {
  const { orders } = collapseOrders(loadFixture(), MAP);
  const res = computeCohorts(orders, { asOf: '2025-04-15', minCohortSize: 30 });
  assert.equal(res.lastCompleteMonth, '2025-03');
  assert.equal(res.asOfMonth, '2025-04');
  assert.equal(res.maxOffset, 3); // Jan..Apr columns; Apr censored everywhere
  assert.deepEqual(res.cohorts.map(c => c.month), ['2025-01', '2025-02', '2025-03']);

  const jan = res.cohorts[0];
  assert.equal(jan.newCustomers, 2);
  close(jan.cells[0].revenue, 150); close(jan.cells[0].cumRevenue, 150);
  close(jan.cells[0].retention, 1.0);
  close(jan.cells[1].revenue, 30); close(jan.cells[1].cumRevenue, 180);
  close(jan.cells[1].retention, 0.5);            // only ann repeats in Feb
  close(jan.cells[2].revenue, 0); close(jan.cells[2].cumRevenue, 180);
  close(jan.cells[2].retention, 0);

  const feb = res.cohorts[1];
  assert.equal(feb.newCustomers, 1);             // dana; ann's Feb order is NOT new
  close(feb.cells[0].revenue, 80);
  close(feb.cells[1].revenue, 0);

  const mar = res.cohorts[2];
  assert.equal(mar.newCustomers, 1);
  close(mar.cells[0].revenue, 200);
});

test('right-censoring: partial current month masked, never rendered as decay', () => {
  const { orders } = collapseOrders(loadFixture(), MAP);
  const res = computeCohorts(orders, { asOf: '2025-04-15' });
  const jan = res.cohorts.find(c => c.month === '2025-01');
  // ann's 500 April order lands at offset 3 for the Jan cohort: censored, no value.
  assert.equal(jan.cells[3].censored, true);
  assert.equal(jan.cells[3].revenue, undefined);
  assert.equal(jan.cells[3].cumRevenue, undefined);
  const feb = res.cohorts.find(c => c.month === '2025-02');
  assert.equal(feb.cells[2].censored, true);  // April
  assert.equal(feb.cells[3].censored, true);  // May (future)
  const mar = res.cohorts.find(c => c.month === '2025-03');
  assert.deepEqual(mar.cells.map(c => c.censored), [false, true, true, true]);
});

test('cohort acquired in the current partial month is fully censored and flagged', () => {
  const rows = [
    ['Order', 'Email', 'Date', 'Total'],
    ['1', 'new@x.com', '2025-04-03', '75']
  ];
  const { orders } = collapseOrders(rows, { orderId: 0, customerId: 1, date: 2, total: 3 });
  const res = computeCohorts(orders, { asOf: '2025-04-15' });
  const c = res.cohorts[0];
  assert.equal(c.partial, true);
  assert.equal(c.newCustomers, 1);
  assert.ok(c.cells.every(cell => cell.censored));
});

test('LTV, CAC, and payback: exact hand-computed values (60% margin)', () => {
  const { orders } = collapseOrders(loadFixture(), MAP);
  const res = computeCohorts(orders, { asOf: '2025-04-15' });
  const spend = { '2025-01': 90, '2025-03': 400, '2025-04': 100 };
  const ltv = computeLTV(res, spend, 60);

  const jan = ltv.rows.find(r => r.month === '2025-01');
  assert.equal(jan.cacStatus, 'ok');
  close(jan.cac, 45);                    // 90 spend / 2 new customers
  close(jan.ltv[0], 45);                 // 150/2 * 0.6
  close(jan.ltv[1], 54);                 // 180/2 * 0.6
  close(jan.ltv[2], 54);
  assert.equal(jan.ltv[3], null);        // censored
  assert.equal(jan.payback, 0);          // 45 >= 45 in month 0 (boundary case)

  const mar = ltv.rows.find(r => r.month === '2025-03');
  close(mar.cac, 400);
  close(mar.ltv[0], 120);                // 200 * 0.6
  assert.equal(mar.payback, null);       // not reached within observed window
});

test('spend/cohort alignment: no spend => CAC unavailable, never CAC = 0', () => {
  const { orders } = collapseOrders(loadFixture(), MAP);
  const res = computeCohorts(orders, { asOf: '2025-04-15' });
  const ltv = computeLTV(res, { '2025-01': 90, '2025-03': 400, '2025-04': 100 }, 60);
  const feb = ltv.rows.find(r => r.month === '2025-02');
  assert.equal(feb.cacStatus, 'no_spend'); // dana's cohort has no Feb spend row
  assert.equal(feb.cac, null);
  assert.equal(feb.payback, null);
  // April: 100 spend, zero new customers -> flagged, not divided by zero
  assert.equal(ltv.spendWarnings.length, 1);
  assert.match(ltv.spendWarnings[0], /2025-04/);
  assert.match(ltv.spendWarnings[0], /no new customers/);
});

test('small-cohort noise: cohorts under minCohortSize flagged low-confidence', () => {
  const { orders } = collapseOrders(loadFixture(), MAP);
  const res30 = computeCohorts(orders, { asOf: '2025-04-15', minCohortSize: 30 });
  assert.ok(res30.cohorts.every(c => c.lowConfidence)); // 2, 1, 1 customers
  const res1 = computeCohorts(orders, { asOf: '2025-04-15', minCohortSize: 1 });
  assert.ok(res1.cohorts.every(c => !c.lowConfidence));
});

test('malformed rows skip with row number and offending value, never silently', () => {
  const rows = [
    ['Order', 'Email', 'Date', 'Total'],
    ['1', 'a@x.com', '2025-01-05', '100'],
    ['2', 'b@x.com', 'garbage-date', '50'],
    ['3', 'c@x.com', '2025-01-07', 'not-money'],
    ['', '', '', '']
  ];
  const { orders, stats } = collapseOrders(rows, { orderId: 0, customerId: 1, date: 2, total: 3 });
  assert.equal(orders.length, 1);
  assert.equal(stats.skipped.length, 3);
  const badDate = stats.skipped.find(s => s.reason === 'unparseable date');
  assert.equal(badDate.row, 3);
  assert.equal(badDate.value, 'garbage-date');
  const badMoney = stats.skipped.find(s => s.reason === 'unparseable total');
  assert.equal(badMoney.row, 4);
  assert.equal(badMoney.value, 'not-money');
});

test('ambiguous dates set needsDateFormat instead of guessing', () => {
  const rows = [
    ['Order', 'Email', 'Date', 'Total'],
    ['1', 'a@x.com', '01/02/2025', '100']
  ];
  const noFmt = collapseOrders(rows, { orderId: 0, customerId: 1, date: 2, total: 3 });
  assert.equal(noFmt.stats.needsDateFormat, true);
  assert.deepEqual(noFmt.stats.ambiguousSamples, ['01/02/2025']);
  assert.equal(noFmt.orders.length, 0);
  const dmy = collapseOrders(rows, { orderId: 0, customerId: 1, date: 2, total: 3 }, { dateFormat: 'dmy' });
  assert.equal(dmy.orders.length, 1);
  assert.equal(dmy.orders[0].m, 2); // 1 Feb 2025
});

test('mixed currencies warn instead of silently summing', () => {
  const rows = [
    ['Order', 'Email', 'Date', 'Total', 'Currency'],
    ['1', 'a@x.com', '2025-01-05', '100', 'USD'],
    ['2', 'b@x.com', '2025-01-06', '80', 'CAD']
  ];
  const { stats } = collapseOrders(rows, { orderId: 0, customerId: 1, date: 2, total: 3, currency: 4 });
  assert.deepEqual(stats.currencies, ['CAD', 'USD']);
  assert.ok(stats.warnings.some(w => /Multiple currencies/.test(w)));
  // single currency: no warning
  const one = collapseOrders([rows[0], rows[1]], { orderId: 0, customerId: 1, date: 2, total: 3, currency: 4 });
  assert.ok(!one.stats.warnings.some(w => /Multiple currencies/.test(w)));
});

test('mixed currency symbols detected without a currency column', () => {
  const rows = [
    ['Order', 'Email', 'Date', 'Total'],
    ['1', 'a@x.com', '2025-01-05', '$100'],
    ['2', 'b@x.com', '2025-01-06', '€80']
  ];
  const { stats } = collapseOrders(rows, { orderId: 0, customerId: 1, date: 2, total: 3 });
  assert.ok(stats.warnings.some(w => /Multiple currencies/.test(w)));
});

test('spend fixture parses into a spend map usable by computeLTV', () => {
  const text = fs.readFileSync(path.join(__dirname, 'fixtures', 'spend.csv'), 'utf8');
  const rows = parseCSV(text).rows;
  const spend = {};
  for (let i = 1; i < rows.length; i++) spend[rows[i][0]] = parseFloat(rows[i][1]);
  assert.deepEqual(spend, { '2025-01': 90, '2025-03': 400, '2025-04': 100 });
});
