#!/usr/bin/env node
// npm run measure:recall-rate
//
// How often the right project knowledge and the right preferences reach the
// Agent, over a fictional world with a stated right answer for every task.
// Writes the numbers to stdout, and the whole record to --json <path>.
// --without-retrieval-terms ranks the same world with every hand-written
// retrieval term removed.

import { writeFileSync } from 'node:fs';
import { ITEMS, PROJECTS, withoutRetrievalTerms } from './knowledge-world.js';
import { measurePreferenceDelivery } from './preference-delivery-metrics.js';
import { measureEntryRecall } from './entry-recall-metrics.js';
import { measureOnDemandSearch } from './on-demand-search-metrics.js';
import { rankingInterpreter } from './provider-ranking.js';
import { formatReport } from './report.js';

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

async function main() {
  const started = Date.now();
  const retrievalTerms = !process.argv.includes('--without-retrieval-terms');
  const items = retrievalTerms ? ITEMS : withoutRetrievalTerms(ITEMS);
  const preferences = measurePreferenceDelivery();
  const entry = await measureEntryRecall(items);
  const search = await measureOnDemandSearch(items);
  const result = {
    measured_at: new Date().toISOString(),
    elapsed_ms: Date.now() - started,
    environment: { items: ITEMS.length, projects: Object.keys(PROJECTS).length, retrieval_terms: retrievalTerms,
      interpreter: rankingInterpreter() },
    preferences, entry, search
  };
  process.stdout.write(`${formatReport(result)}\n`);
  process.stdout.write(`\nrun in ${result.elapsed_ms} ms\n`);
  const json = option('--json');
  if (json) {
    writeFileSync(json, `${JSON.stringify(result, null, 2)}\n`);
    process.stdout.write(`full record: ${json}\n`);
  }
}

main().catch(error => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
