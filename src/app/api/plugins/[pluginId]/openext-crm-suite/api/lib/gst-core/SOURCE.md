# gst-core: where these files come from

**Do not edit any `.js` file in this folder except `index.js`.** They are copies of the GST app's tested helpers. A bug fix goes into the GST app first, then the files are copied again, so both stay identical.

| | |
|---|---|
| Source | `Refactor\gstbillingsoft\src\` (package `free-gst-billing-software`) |
| App version | `1.10.85` |
| Copied on | 18 Nov 2026 (CRM 3.53.0, GST plan Step 0) |
| Copied how | Byte for byte (checked with `cmp`), keeping the `utils/` folder layout |
| npm package needed | `fflate` (`^0.8.3`, the app's lock file has `0.8.3`). Declared in `manifest.json` → `dependencies`; the CMS installs it at its root |

## Files

**Loaded by `index.js`** (used by the CRM):
`utils.js`, `utils/gstr1Json.js`, `utils/cashBook.js`, `utils/bankMatch.js`, `utils/tdsTcs.js`, `utils/lut.js`, `utils/periodLock.js`, `utils/period.js`, `utils/hsnRates.js`

**Imported by those** (copied so their imports work):
`utils/expensePayment.js`, `utils/bulkCsv.js`, `utils/xlsxRead.js` (imports `fflate`), `utils/purchaseOrders.js`, `utils/purchasePayments.js`, `utils/partyOutstanding.js`, `utils/fx.js`

**Test support only** (imported by the copied tests in `test/gst-core/`, never loaded by the CRM):
`utils/xlsx.js` (imports `fflate`), `utils/products.js`, `utils/supporters.js`, `utils/changelog.js`, `utils/itr.js`

## Tests

The app's own tests are copied to `openext-crm-suite/test/gst-core/`. Only their import paths changed (`../src/` became `../../api/lib/gst-core/`). They are plain scripts that exit non-zero on failure, so `node --test` reports each file as pass or fail.

`tax-test.mjs` and `bank-match-test.mjs` need `fflate` to be installed where Node can find it.

## Copying again

1. Copy the same files from the GST app over these, byte for byte.
2. Copy the same tests again and redo only the import-path change.
3. Update the version and date above.
4. Run `node --test` in `openext-crm-suite`.
