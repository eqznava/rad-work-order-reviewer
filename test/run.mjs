// Regression test: node test/run.mjs [--show]
import { reviewWorkOrder } from '../src/engine.js';
import { workOrders } from './fixtures.mjs';
import { expected } from './expected.mjs';

let failed = 0;
for (const [key, text] of Object.entries(workOrders)) {
  const r = reviewWorkOrder(text);
  const got = `${r.counts.conflicts}/${r.counts.missing}`;
  if (process.argv.includes('--show')) {
    console.log(`\n== ${key}  conflicts/missing = ${got}  couldNotRead: ${r.couldNotRead.join(', ') || 'none'}`);
    for (const g of ['conflicts', 'missing']) for (const f of r[g]) console.log(`  [${g}] (${f.source}) ${f.text.slice(0, 150)}`);
  }
  if (expected[key] && expected[key] !== got) { failed += 1; console.log(`FAIL ${key}: expected ${expected[key]}, got ${got}`); }
}
console.log(failed ? `\n${failed} FAILED` : '\nAll Work Orders match the expected counts.');
process.exit(failed ? 1 : 0);
