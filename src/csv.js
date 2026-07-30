'use strict';
/*
 * ltv-cohort-kit — csv.js
 * RFC 4180 CSV parsing (streaming state machine), binary-file detection,
 * and CSV serialization. Zero dependencies. Works in the browser (attaches
 * to window.LTVKit) and in node (module.exports).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) { root.LTVKit = root.LTVKit || {}; Object.assign(root.LTVKit, api); }
})(typeof self !== 'undefined' ? self : typeof globalThis !== 'undefined' ? globalThis : null, function () {

  /**
   * Inspect the first bytes of a file and return an error message if it is
   * clearly not a text CSV (xlsx/xls/zip, NUL bytes, mostly control chars).
   * @param {Uint8Array} bytes  first chunk of the file
   * @returns {string|null} human-readable rejection message, or null if OK
   */
  function detectBinary(bytes) {
    if (!bytes || bytes.length === 0) return null;
    if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
      return 'This looks like an Excel file (.xlsx) — export it as CSV and try again.';
    }
    if (bytes.length >= 4 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
      return 'This looks like a legacy Excel file (.xls) — export it as CSV and try again.';
    }
    const n = Math.min(bytes.length, 4096);
    let ctrl = 0;
    for (let i = 0; i < n; i++) {
      const b = bytes[i];
      if (b === 0) return 'This file contains binary data (NUL bytes) — it is not a CSV. Export it as CSV and try again.';
      if (b < 9 || (b > 13 && b < 32)) ctrl++;
    }
    if (ctrl / n > 0.05) return 'This file does not look like text — export it as CSV and try again.';
    return null;
  }

  /**
   * Streaming RFC 4180 parser. Feed arbitrary string chunks via write();
   * each complete record is delivered to onRecord(fields, recordNumber)
   * (recordNumber is 1-based and includes the header record).
   * Handles: quoted fields with embedded commas/newlines/escaped quotes,
   * CRLF and LF and lone CR, UTF-8 BOM, blank/trailing empty lines (skipped).
   */
  class CSVParser {
    constructor(onRecord) {
      this.onRecord = onRecord;
      this.field = '';
      this.record = [];
      // 0 = at start of field, 1 = in unquoted field, 2 = inside quotes,
      // 3 = just saw a quote while inside a quoted field
      this.state = 0;
      this.recordHasData = false;
      this.first = true;
      this.skipLF = false;
      this.recordCount = 0;
      this.warnings = [];
    }
    _endField() {
      this.record.push(this.field);
      this.field = '';
      this.state = 0;
    }
    _endRecord() {
      this._endField();
      const rec = this.record;
      this.record = [];
      this.recordHasData = false;
      this.recordCount++;
      this.onRecord(rec, this.recordCount);
    }
    _maybeEndRecord() {
      if (this.recordHasData || this.record.length > 0 || this.field.length > 0) {
        this._endRecord();
      } else { // blank line: skip silently
        this.field = '';
        this.record = [];
        this.state = 0;
      }
    }
    write(chunk) {
      let i = 0;
      if (this.first) {
        this.first = false;
        if (chunk.charCodeAt(0) === 0xfeff) i = 1; // strip UTF-8 BOM
      }
      for (; i < chunk.length; i++) {
        const c = chunk[i];
        if (this.skipLF) {
          this.skipLF = false;
          if (c === '\n') continue;
        }
        if (this.state === 2) { // inside quoted field
          if (c === '"') this.state = 3;
          else this.field += c;
          continue;
        }
        if (this.state === 3) { // quote seen inside quoted field
          if (c === '"') { this.field += '"'; this.state = 2; continue; }
          this.state = 1; // closing quote; treat following char normally
        }
        if (c === ',') { this.recordHasData = true; this._endField(); }
        else if (c === '\n') { this._maybeEndRecord(); }
        else if (c === '\r') { this.skipLF = true; this._maybeEndRecord(); }
        else if (c === '"' && this.state === 0) { this.state = 2; this.recordHasData = true; }
        else { this.field += c; this.state = 1; this.recordHasData = true; }
      }
    }
    end() {
      if (this.state === 2 || this.state === 3) {
        if (this.state === 2) {
          this.warnings.push('File ended inside a quoted field (record ' + (this.recordCount + 1) + ') — the last record may be truncated.');
        }
      }
      this._maybeEndRecord();
      return { records: this.recordCount, warnings: this.warnings };
    }
  }

  /**
   * Parse a full CSV string into an array of records.
   * @returns {{rows: string[][], warnings: string[]}}
   */
  function parseCSV(text) {
    const rows = [];
    const p = new CSVParser(function (rec) { rows.push(rec); });
    p.write(String(text));
    const done = p.end();
    return { rows, warnings: done.warnings };
  }

  /** Serialize rows (array of arrays) to an RFC 4180 CSV string (CRLF). */
  function tableToCSV(rows) {
    return rows.map(function (row) {
      return row.map(function (cell) {
        const s = cell == null ? '' : String(cell);
        if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
        return s;
      }).join(',');
    }).join('\r\n') + '\r\n';
  }

  return { detectBinary, CSVParser, parseCSV, tableToCSV };
});
