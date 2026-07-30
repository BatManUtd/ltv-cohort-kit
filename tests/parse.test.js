'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMoney, parseDate, monthKey, monthIndexOfKey, keyOfMonthIndex } = require('../src/parse.js');

test('money: plain and decimal values', () => {
  assert.deepEqual(parseMoney('100'), { value: 100, currency: null });
  assert.deepEqual(parseMoney('99.95'), { value: 99.95, currency: null });
  assert.deepEqual(parseMoney(' 0.00 '), { value: 0, currency: null });
});

test('money: currency symbols stripped and reported', () => {
  assert.deepEqual(parseMoney('$1,234.56'), { value: 1234.56, currency: '$' });
  assert.deepEqual(parseMoney('£99.00'), { value: 99, currency: '£' });
  assert.deepEqual(parseMoney('€5'), { value: 5, currency: '€' });
});

test('money: thousands separators stripped', () => {
  assert.equal(parseMoney('1,234,567.89').value, 1234567.89);
  assert.equal(parseMoney('12,000').value, 12000);
});

test('money: parentheses negatives and explicit minus', () => {
  assert.equal(parseMoney('(50.00)').value, -50);
  assert.equal(parseMoney('($1,299.00)').value, -1299);
  assert.equal(parseMoney('-25.50').value, -25.5);
  assert.equal(parseMoney('-$10').value, -10);
});

test('money: 3-letter currency codes', () => {
  assert.deepEqual(parseMoney('USD 12.50'), { value: 12.5, currency: 'USD' });
  assert.deepEqual(parseMoney('12.50 EUR'), { value: 12.5, currency: 'EUR' });
});

test('money: garbage and ambiguous decimal-comma rejected (never misparsed)', () => {
  assert.equal(parseMoney(''), null);
  assert.equal(parseMoney('abc'), null);
  assert.equal(parseMoney('99,00'), null); // European decimal comma: reject, do not read as 9900
  assert.equal(parseMoney('12.3.4'), null);
});

test('date: ISO 8601 forms', () => {
  assert.deepEqual(parseDate('2025-01-02'), { y: 2025, m: 1, d: 2 });
  assert.deepEqual(parseDate('2025-01-02T13:45:56Z'), { y: 2025, m: 1, d: 2 });
  assert.deepEqual(parseDate('2025/1/2'), { y: 2025, m: 1, d: 2 });
});

test('date: Shopify "Created at" timestamp format', () => {
  assert.deepEqual(parseDate('2025-01-02 13:45:56 -0500'), { y: 2025, m: 1, d: 2 });
});

test('date: ambiguous 01/02/2025 requires explicit format', () => {
  assert.deepEqual(parseDate('01/02/2025'), { ambiguous: true, value: '01/02/2025' });
  assert.deepEqual(parseDate('01/02/2025', { dateFormat: 'mdy' }), { y: 2025, m: 1, d: 2 });
  assert.deepEqual(parseDate('01/02/2025', { dateFormat: 'dmy' }), { y: 2025, m: 2, d: 1 });
  assert.deepEqual(parseDate('01-02-2025'), { ambiguous: true, value: '01-02-2025' });
});

test('date: invalid values rejected', () => {
  assert.equal(parseDate('13/40/2025', { dateFormat: 'mdy' }), null); // month 13
  assert.equal(parseDate('2025-13-01'), null);
  assert.equal(parseDate('01/02/25'), null); // 2-digit year: refuse to guess
  assert.equal(parseDate('not a date'), null);
  assert.equal(parseDate(''), null);
});

test('month arithmetic helpers', () => {
  assert.equal(monthKey(2025, 3), '2025-03');
  assert.equal(monthIndexOfKey('2025-01'), 2025 * 12);
  assert.equal(keyOfMonthIndex(2025 * 12 + 11), '2025-12');
  assert.equal(keyOfMonthIndex(monthIndexOfKey('2024-12') + 1), '2025-01');
});
