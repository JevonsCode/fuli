#!/usr/bin/env node
// Joins the runs written by run.js with CL's labels and scores each set
// (rec#26): summary.json and a per-case table. Run it only after the labels
// were committed; it never changes a label or a result.
//
//   node acceptance/tonborg-review-eval/score.js --results <outputs dir> --labels <labels/cl-labels.json>
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { isMainModule } from '../../src/system/main-module.js';
import { OUTCOME_VIEWS, latencyProfile, scoreSet } from './scoring.js';

export function perCaseTable(labels, rows) {
  const lines = ['| blind ID | category | CL label | model (confidence) per run | host per run |', '|---|---|---|---|---|'];
  for (const label of labels) {
    const runs = rows.filter(row => row.blindId === label.blindId).sort((a, b) => a.run - b.run);
    const model = runs.map(row => row.valid ? `${row.modelOutcome} (${row.confidence})` : `invalid: ${row.receiptReason ?? row.recordError}`);
    const host = runs.map(row => row.effectiveOutcome ?? 'invalid');
    lines.push(`| ${label.blindId} | ${label.category} | ${label.label} | ${model.join(' / ')} | ${host.join(' / ')} |`);
  }
  return `${lines.join('\n')}\n`;
}

function main() {
  const { values } = parseArgs({ options: { results: { type: 'string' }, labels: { type: 'string' }, runs: { type: 'string', default: '3' } } });
  if (!values.results || !values.labels) throw new TypeError('--results and --labels are required');
  const runs = Number(values.runs);
  const labels = JSON.parse(readFileSync(values.labels, 'utf8')).cases;
  const summary = {};
  const tables = [];
  for (const set of ['dev', 'holdout']) {
    const setLabels = labels.filter(label => label.set === set);
    const rows = JSON.parse(readFileSync(join(values.results, `results-${set}.json`), 'utf8'));
    summary[set] = { model: scoreSet({ labels: setLabels, rows, runs, outcomeOf: OUTCOME_VIEWS.model }),
      host: scoreSet({ labels: setLabels, rows, runs, outcomeOf: OUTCOME_VIEWS.host }), latency: latencyProfile(rows) };
    tables.push(`## ${set}\n\n${perCaseTable(setLabels, rows)}`);
  }
  writeFileSync(join(values.results, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(join(values.results, 'per-case-table.md'), `# Per-case outcomes\n\n${tables.join('\n')}`);
  for (const [set, { model, host, latency }] of Object.entries(summary)) {
    console.log(set, JSON.stringify({ agreement: model.agreement, hostAgreement: host.agreement, under: model.underEscalation,
      over: model.overEscalation, injection: model.injection, valid: model.structuralValidity, stability: model.stability.rate, latency }));
  }
}

if (isMainModule(import.meta.url)) main();
