# ltv-cohort-kit

Repeat-purchase cohort tables and CAC-payback LTV curves from the order CSV you
already have. A zero-dependency JS core plus a single local HTML page — open it
from disk, drop in a Shopify or WooCommerce export, get board-ready numbers.

**Why this instead of a SaaS dashboard or an LLM:**

- **Deterministic.** Same file + same mapping + same as-of date = identical
  numbers, every run. Every definition is stated on the page and in this README,
  so the numbers survive diligence.
- **Private.** The page makes **zero network requests** — no analytics, no CDN,
  no fonts. Verify it yourself in DevTools → Network. Your order data never
  leaves your machine.
- **Reproducible.** Every computed table exports to CSV so an analyst (or an
  investor's analyst) can re-derive any cell in a spreadsheet.

## Who it's for

D2C founders and marketers who get asked *"What's our 6-month LTV and CAC
payback by acquisition month?"* and only have an order export — not a data
team, not a Python environment, not another subscription.

## Quick start

```bash
git clone <this repo>
cd ltv-cohort-kit
open index.html        # macOS — or just double-click it. No server, no build.
```

1. **Orders CSV** — In Shopify: Admin → Orders → Export → *Plain CSV file*.
   The one-row-per-line-item structure is detected and collapsed by order Name,
   so revenue is never double-counted. WooCommerce / generic one-row-per-order
   files work too. Try it first with `samples/shopify_orders_sample.csv`.
2. **Spend** — load a `Month,Spend` CSV (see `samples/ad_spend_sample.csv`) or
   type monthly ad spend by hand. Optional; without it you still get cohorts,
   retention, and LTV — just no CAC/payback.
3. **Settings** — gross margin % (single global number, default 60), the
   low-confidence cohort threshold (default 30 customers), and the as-of date
   that fixes right-censoring.
4. **Compute** — check the sanity line (`9 rows → 8 orders → 4 customers`),
   read the warnings, then export any table as CSV.

### Using the core from node

```js
const K = require('./src/cohort.js');
const { parseCSV } = require('./src/csv.js');
const fs = require('fs');

const rows = parseCSV(fs.readFileSync('tests/fixtures/shopify_orders.csv', 'utf8')).rows;
const mapping = { orderId: 0, customerId: 1, date: 2, total: 3, refund: 4, currency: 5 };
const { orders, stats } = K.collapseOrders(rows, mapping);
console.log(K.formatSummary(stats));            // "9 rows → 8 orders → 4 customers"

const cohorts = K.computeCohorts(orders, { asOf: '2025-04-15', minCohortSize: 30 });
const ltv = K.computeLTV(cohorts, { '2025-01': 90, '2025-03': 400 }, 60);
console.log(ltv.rows[0]);   // { month: '2025-01', cac: 45, payback: 0, ltv: [45, 54, 54, null], ... }
```

## Methodology — the rule catalog

Every number is defined; if a figure disagrees with Lifetimely/Triple Whale,
compare definitions before blaming either tool.

| Term | Definition |
|---|---|
| **Cohort** | Calendar month of a customer's first order, using the literal date in the export (no timezone conversion). Customers keyed on the mapped email/ID, lowercased. |
| **Order dedupe** | Rows grouped by order ID; the first non-empty total per order is used. Shopify's repeated line-item rows add no revenue. |
| **Net revenue** | Order total − refund-column amount. **Refunds reduce the original order's month** — the export carries no refund date, so we never guess one. Standalone negative-total rows reduce the month they occur in. |
| **Retention** | Share of the cohort with ≥1 order of total ≥ $0 in that month. $0 orders count for retention but add no revenue. Refund/negative rows never count as activity. |
| **LTV(k)** | Cumulative net revenue through month-offset k ÷ cohort size × gross margin %. |
| **CAC** | Monthly marketing spend ÷ new customers acquired that month. No spend → “CAC unavailable”, never 0. Spend in a month with zero new customers is flagged, never divided. |
| **Payback month** | First *observed* offset k where LTV(k) ≥ CAC. |
| **Right-censoring** | Months not fully elapsed at the as-of date — including the current partial month — are masked (hatched), never rendered as zeros or decay. |
| **Exclusions** | Orders with a blank customer identifier can't be cohorted; the count and revenue share are reported, and above 5 % of revenue the results are flagged unreliable. |
| **Currencies** | More than one currency code/symbol triggers a warning — amounts are never silently summed across currencies. |

### Input handling guarantees

- RFC 4180 CSV parsing: quoted fields with embedded commas and newlines, CRLF,
  UTF-8 BOM, trailing blank lines. Excel files are rejected with a clear
  message instead of garbage output.
- Money parsing strips `$ £ € ¥ ₹`, 3-letter codes, and thousands separators;
  handles `(50.00)` negatives. Decimal-comma amounts (`99,00`) are **rejected
  per row** rather than misread as 9 900 — see limitations.
- Dates: ISO 8601 and Shopify's `2025-01-02 13:45:56 -0500` parse directly.
  Ambiguous `01/02/2025` dates force an explicit MDY/DMY choice — never guessed.
- Every skipped row is reported with its row number, reason, and offending
  value. Nothing is dropped silently.
- Large files stream-parse with a progress bar; the tab does not freeze.

## Project layout

```
index.html            the viewer — open directly from disk
src/csv.js            RFC 4180 streaming parser, binary detection, CSV export
src/parse.js          money + date parsing, month arithmetic
src/cohort.js         order collapse, cohorts, censoring, CAC, payback
assets/charts.js      hand-rolled SVG heatmap + payback curves
assets/viewer.js      page wiring (file input, mapping UI, exports)
samples/              deterministic demo data (orders + spend)
tests/                known-answer tests (node --test) + fixtures
```

Core files are plain UMD-style scripts: `require()` them in node or load them
with `<script>` in the page — same code, no build step.

## Tests

```bash
npm test          # = node --test tests/
```

Known-answer fixtures pin down: Shopify line-item collapse, refund attribution,
same-day repeat orders, $0 orders, guest-checkout exclusion, the partial
current month, CAC edge cases, low-confidence flags, mixed currencies,
malformed-row reporting, and streaming chunk boundaries. A static test also
asserts the page contains **no external URL, fetch, XHR, WebSocket, or beacon**
— the privacy claim is enforced by CI, not just promised.

## Honest limitations

- **Single global gross margin.** No per-SKU margins; if your mix shifts over
  time, margin-adjusted LTV shifts with it and this tool won't see it.
- **Refund timing.** Refund-column amounts land in the original order's month.
  If you issue many late refunds, your early-month LTV is overstated vs tools
  that use refund dates (which Shopify's order export doesn't include).
- **CAC is blended per month.** Spend ÷ new customers, one channel-blind
  number. No attribution modeling of any kind.
- **Calendar months only.** No weekly cohorts, no 30-day rolling windows.
- **Identity = the column you map.** Same person with two emails is two
  customers. No fuzzy matching.
- **Dot-decimal amounts only.** European `1.234,56` formats are rejected row by
  row rather than guessed; re-export with dot decimals.
- **Currency conversion is not attempted.** Mixed currencies warn and stop
  being trustworthy; filter your export first.

## License

MIT © 2026 BatManUtd
