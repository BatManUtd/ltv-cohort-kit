'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCSV, CSVParser, detectBinary, tableToCSV } = require('../src/csv.js');

test('RFC4180: quoted fields with embedded commas', () => {
  const { rows } = parseCSV('a,"b,c",d\n1,2,3\n');
  assert.deepEqual(rows, [['a', 'b,c', 'd'], ['1', '2', '3']]);
});

test('RFC4180: quoted fields with embedded newlines and escaped quotes', () => {
  const { rows } = parseCSV('name,note\nann,"line1\nline2, still field"\nbob,"say ""hi"""\n');
  assert.deepEqual(rows, [
    ['name', 'note'],
    ['ann', 'line1\nline2, still field'],
    ['bob', 'say "hi"']
  ]);
});

test('RFC4180: CRLF line endings and CRLF inside quotes', () => {
  const { rows } = parseCSV('a,b\r\n"x\r\ny",2\r\n');
  assert.deepEqual(rows, [['a', 'b'], ['x\r\ny', '2']]);
});

test('RFC4180: UTF-8 BOM is stripped from first header cell', () => {
  const { rows } = parseCSV('\uFEFFName,Total\n#1,5\n');
  assert.equal(rows[0][0], 'Name');
});

test('RFC4180: trailing empty lines and blank lines are skipped', () => {
  const { rows } = parseCSV('a,b\n1,2\n\n\n');
  assert.equal(rows.length, 2);
});

test('RFC4180: empty fields and trailing commas preserved', () => {
  const { rows } = parseCSV('a,,c\n,,\n');
  assert.deepEqual(rows, [['a', '', 'c'], ['', '', '']]);
});

test('streaming: identical result when fed one character at a time', () => {
  const input = '\uFEFFa,"b,\nc",d\r\n"e""f",g,\r\n1,2,3\n';
  const whole = parseCSV(input).rows;
  const rows = [];
  const p = new CSVParser((rec) => rows.push(rec));
  for (const ch of input) p.write(ch);
  p.end();
  assert.deepEqual(rows, whole);
});

test('streaming: chunk boundary inside a quoted field', () => {
  const rows = [];
  const p = new CSVParser((rec) => rows.push(rec));
  p.write('a,"hel');
  p.write('lo, wo');
  p.write('rld"\n');
  p.end();
  assert.deepEqual(rows, [['a', 'hello, world']]);
});

test('unterminated quote at EOF yields a warning, not silence', () => {
  const rows = [];
  const p = new CSVParser((rec) => rows.push(rec));
  p.write('a,"never closed');
  const done = p.end();
  assert.equal(done.warnings.length, 1);
  assert.match(done.warnings[0], /quoted field/);
});

test('binary detection: xlsx (zip) magic bytes rejected with Excel message', () => {
  const xlsx = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
  assert.match(detectBinary(xlsx), /Excel file \(\.xlsx\)/);
});

test('binary detection: legacy .xls magic bytes rejected', () => {
  const xls = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1]);
  assert.match(detectBinary(xls), /legacy Excel/);
});

test('binary detection: NUL bytes rejected, plain text accepted', () => {
  assert.match(detectBinary(new Uint8Array([0x61, 0x00, 0x62])), /binary data/);
  const text = new TextEncoder().encode('Name,Total\n#1,5.00\n');
  assert.equal(detectBinary(text), null);
});

test('tableToCSV round-trips through parseCSV', () => {
  const rows = [['a', 'b,c', 'd"e'], ['1', 'x\ny', '']];
  const back = parseCSV(tableToCSV(rows)).rows;
  assert.deepEqual(back, rows);
});

test('scale smoke: 50,000 rows stream-parse quickly', () => {
  const chunks = ['Name,Email,Created at,Total\n'];
  for (let i = 0; i < 50000; i++) {
    chunks.push('#' + i + ',c' + (i % 5000) + '@x.com,2025-0' + ((i % 6) + 1) + '-10,"' + (10 + (i % 90)) + '.00"\n');
  }
  const start = Date.now();
  let n = 0;
  const p = new CSVParser(() => n++);
  for (const c of chunks) p.write(c);
  p.end();
  const ms = Date.now() - start;
  assert.equal(n, 50001);
  assert.ok(ms < 5000, '50k rows took ' + ms + 'ms');
});
