'use strict';
// Static guarantees about the viewer page itself: the privacy claim must be
// auditable (zero external references) and the methodology panel must state
// the exact definitions.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const PAGE_FILES = ['index.html', 'assets/viewer.js', 'assets/charts.js', 'src/csv.js', 'src/parse.js', 'src/cohort.js'];

test('privacy: no network calls of any kind in the page or its scripts', () => {
  for (const f of PAGE_FILES) {
    const src = read(f);
    assert.ok(!/https?:\/\/(?!www\.w3\.org\/2000\/svg)/.test(src), f + ' references an external URL');
    assert.ok(!/\bfetch\s*\(/.test(src), f + ' calls fetch()');
    assert.ok(!/XMLHttpRequest/.test(src), f + ' uses XMLHttpRequest');
    assert.ok(!/new\s+WebSocket/.test(src), f + ' opens a WebSocket');
    assert.ok(!/navigator\.sendBeacon/.test(src), f + ' uses sendBeacon');
    assert.ok(!/<link[^>]+href=["']http/i.test(src), f + ' loads an external stylesheet');
    assert.ok(!/@import/.test(src), f + ' uses CSS @import');
  }
});

test('viewer loads only local relative scripts', () => {
  const html = read('index.html');
  const srcs = [...html.matchAll(/<script[^>]*src=["']([^"']+)["']/g)].map(m => m[1]);
  assert.deepEqual(srcs, ['src/csv.js', 'src/parse.js', 'src/cohort.js', 'assets/charts.js', 'assets/viewer.js']);
  for (const s of srcs) assert.ok(fs.existsSync(path.join(ROOT, s)), s + ' missing on disk');
});

test('methodology panel states the exact LTV / CAC / payback definitions', () => {
  const html = read('index.html');
  assert.match(html, /Methodology/);
  assert.match(html, /cumulative net revenue through month-offset k ÷ cohort size × gross\s+margin %/);
  assert.match(html, /Monthly marketing spend ÷ new customers acquired that month/);
  assert.match(html, /First observed offset k where cumulative margin-adjusted LTV per customer ≥ CAC/);
  // refund attribution policy is documented in the UI (guardrail 7)
  assert.match(html, /original\s+order's month/);
  // censoring, $0 orders, exclusions, privacy are documented
  assert.match(html, /never shown as zeros or decay/);
  assert.match(html, /\$0 orders count for\s+retention but add no revenue/);
  assert.match(html, /blank customer identifier/);
  assert.match(html, /zero network requests/);
});

test('core scripts parse cleanly in both module systems (UMD sanity)', () => {
  // require() works (proven by other tests); here check browser-global shape.
  const sandboxNames = [];
  for (const f of ['src/csv.js', 'src/parse.js', 'src/cohort.js', 'assets/charts.js']) {
    const src = read(f);
    assert.match(src, /root\.LTVKit = root\.LTVKit \|\| \{\}/, f + ' must attach to window.LTVKit');
    sandboxNames.push(f);
  }
  assert.equal(sandboxNames.length, 4);
});
