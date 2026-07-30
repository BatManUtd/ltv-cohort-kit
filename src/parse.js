'use strict';
/*
 * ltv-cohort-kit — parse.js
 * Boundary parsing: money strings and date strings, plus calendar-month
 * arithmetic helpers. Zero dependencies; browser (window.LTVKit) + node.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) { root.LTVKit = root.LTVKit || {}; Object.assign(root.LTVKit, api); }
})(typeof self !== 'undefined' ? self : typeof globalThis !== 'undefined' ? globalThis : null, function () {

  // Symbols map to themselves: '$' is ambiguous across USD/CAD/AUD etc., so we
  // report the symbol as the currency token rather than guessing a code.
  const SYMBOLS = { '$': '$', '£': '£', '€': '€', '¥': '¥', '₹': '₹' };

  /**
   * Parse a money string into { value, currency|null }.
   * Handles: currency symbols ($ £ € ¥ ₹) and 3-letter codes (USD, "12.50 EUR"),
   * thousands separators (1,234,567.89), parentheses negatives ("(50.00)"),
   * explicit minus signs, surrounding whitespace.
   * Decimal convention is dot-decimal; a comma NOT followed by exactly 3 digits
   * (e.g. European "99,00") is rejected (returns null) rather than misparsed.
   * @returns {{value:number, currency:string|null}|null} null if unparseable
   */
  function parseMoney(raw) {
    if (raw == null) return null;
    let s = String(raw).trim();
    if (s === '') return null;
    let neg = false;
    let currency = null;
    if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1).trim(); }
    // Strip signs, symbols, and 3-letter codes from both ends (a few passes).
    for (let pass = 0; pass < 4; pass++) {
      s = s.trim();
      if (s.startsWith('-')) { neg = true; s = s.slice(1); continue; }
      if (s.startsWith('+')) { s = s.slice(1); continue; }
      let hit = false;
      for (const sym of Object.keys(SYMBOLS)) {
        if (s.startsWith(sym)) { currency = currency || SYMBOLS[sym]; s = s.slice(sym.length); hit = true; break; }
        if (s.endsWith(sym)) { currency = currency || SYMBOLS[sym]; s = s.slice(0, -sym.length); hit = true; break; }
      }
      if (hit) continue;
      let m = s.match(/^([A-Za-z]{3})[\s]/);
      if (m) { currency = currency || m[1].toUpperCase(); s = s.slice(3); continue; }
      m = s.match(/[\s]([A-Za-z]{3})$/);
      if (m) { currency = currency || m[1].toUpperCase(); s = s.slice(0, -4); continue; }
      break;
    }
    s = s.trim();
    // Remove thousands separators: comma followed by exactly 3 digits.
    s = s.replace(/,(?=\d{3}(\D|$))/g, '');
    if (s.indexOf(',') !== -1) return null; // leftover comma: ambiguous (e.g. "99,00")
    if (!/^\d+(\.\d*)?$|^\.\d+$/.test(s)) return null;
    const v = parseFloat(s);
    if (!isFinite(v)) return null;
    return { value: neg ? -v : v, currency };
  }

  /**
   * Parse a date string into { y, m, d } (calendar fields, no timezone math:
   * the literal date written in the export is used).
   * Accepted unambiguously:
   *   - ISO 8601:  2025-01-02, 2025-01-02T13:45:56Z, 2025-01-02 13:45:56
   *   - Shopify:   2025-01-02 13:45:56 -0500
   *   - Y/M/D:     2025/1/2
   * Ambiguous (returns {ambiguous:true} unless opts.dateFormat given):
   *   - 01/02/2025 or 01-02-2025 (could be Jan 2 or Feb 1)
   *     opts.dateFormat: 'mdy' or 'dmy' resolves them.
   * Anything else (incl. 2-digit years) returns null.
   */
  function parseDate(raw, opts) {
    if (raw == null) return null;
    const s = String(raw).trim();
    if (s === '') return null;
    const o = opts || {};
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/);
    if (m) return validDate(+m[1], +m[2], +m[3]);
    m = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})(?:[T\s].*)?$/);
    if (m) return validDate(+m[1], +m[2], +m[3]);
    m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})(?:\s.*)?$/);
    if (m) {
      if (o.dateFormat === 'mdy') return validDate(+m[3], +m[1], +m[2]);
      if (o.dateFormat === 'dmy') return validDate(+m[3], +m[2], +m[1]);
      return { ambiguous: true, value: s };
    }
    return null;
  }

  function validDate(y, mo, d) {
    if (y < 1970 || y > 2200) return null;
    if (mo < 1 || mo > 12) return null;
    if (d < 1 || d > 31) return null;
    return { y, m: mo, d };
  }

  /** 'YYYY-MM' key for a year/month. */
  function monthKey(y, m) { return y + '-' + String(m).padStart(2, '0'); }
  /** Absolute month index (year*12 + month-1) from a 'YYYY-MM' key. */
  function monthIndexOfKey(key) {
    const p = key.split('-');
    return (+p[0]) * 12 + (+p[1] - 1);
  }
  /** 'YYYY-MM' key from an absolute month index. */
  function keyOfMonthIndex(i) { return monthKey(Math.floor(i / 12), (i % 12) + 1); }

  return { parseMoney, parseDate, monthKey, monthIndexOfKey, keyOfMonthIndex };
});
