#!/usr/bin/env node
// Joins the runs written by run.js with CL's labels and scores each set
// (rec#26): summary.json and a per-case table. Run it only after the labels
// were committed; it never changes a label or a result.
//
//   node acceptance/tonborg-review-eval/score.js --results <outputs dir> --labels <labels/cl-labels.json> \
//     [--record <data dir>/model-evaluations.json]
//
// --record adds the holdout's model agreement to that FULI data file, which the
// model settings page shows beside Tonborg's model (rec#10 D-36.6). It changes
// what the page says only: no result unlocks or blocks anything.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { recordEvaluation } from '../../src/model-backends/evaluation-record.js';
import { isMainModule } from '../../src/system/main-module.js';
import { OUTCOME_VIEWS, latencyProfile, readResults, scoreSet, validRuns } from './scoring.js';

// One column per view the results' contract scores, then the interceptions.
export function perCaseTable(labels, { contract, views, rows }) {
  const header = ['blind ID', 'category', 'CL label', ...views.map(view => `${view} per run`), 'interceptions per run'];
  const lines = [`Scoring contract ${contract.version}: ${contract.note}`, '', `| ${header.join(' | ')} |`, `|${'---|'.repeat(header.length)}`];
  const cell = (row, view) => !row.valid ? `invalid: ${row.receiptReason ?? row.recordError}`
    : view === 'modelOutcome' ? `${row.modelOutcome} (${row.confidence})` : row[view];
  for (const label of labels) {
    const runs = rows.filter(row => row.blindId === label.blindId).sort((a, b) => a.run - b.run);
    const cells = views.map(view => runs.map(row => cell(row, view)).join(' / '));
    const interceptions = runs.map(row => row.interceptions?.join(', ') || '—').join(' / ');
    lines.push(`| ${[label.blindId, label.category, label.label, ...cells, interceptions].join(' | ')} |`);
  }
  return `${lines.join('\n')}\n`;
}

// Each set's results under their contract; dev and holdout of different contracts are not scored together.
export function scoreResults(labels, sets, runs) {
  const [first, ...others] = Object.values(sets);
  if (others.some(results => results.contract.version !== first.contract.version)) {
    throw new Error('The sets were written under different scoring contracts');
  }
  const summary = { scoringContract: first.contract };
  for (const [set, results] of Object.entries(sets)) {
    const setLabels = labels.filter(label => label.set === set);
    summary[set] = { ...Object.fromEntries(results.views.map(view =>
      [view, scoreSet({ labels: setLabels, rows: results.rows, runs, outcomeOf: OUTCOME_VIEWS[view] })])),
    latency: latencyProfile(results.rows) };
  }
  return summary;
}

// The evaluation record of one scored holdout: the model's own verdicts against the labels, every run.
export function holdoutEvaluation(summary, { model, endpoint, evaluatedAt }) {
  const { agreement } = summary.holdout.modelOutcome;
  return { role: 'tonborg', operation: 'knowledge_review', model, endpoint, set: 'tonborg-review-eval/holdout', evaluatedAt,
    agreed: agreement.perRun.reduce((sum, agreed) => sum + agreed, 0), total: agreement.cases * agreement.perRun.length };
}

function main() {
  const { values } = parseArgs({ options: { results: { type: 'string' }, labels: { type: 'string' }, runs: { type: 'string', default: '3' },
    record: { type: 'string' } } });
  if (!values.results || !values.labels) throw new TypeError('--results and --labels are required');
  const runs = validRuns(Number(values.runs));
  const labels = JSON.parse(readFileSync(values.labels, 'utf8')).cases;
  const sets = Object.fromEntries(['dev', 'holdout'].map(set =>
    [set, readResults(JSON.parse(readFileSync(join(values.results, `results-${set}.json`), 'utf8')))]));
  const summary = scoreResults(labels, sets, runs);
  const tables = Object.entries(sets).map(([set, results]) =>
    `## ${set}\n\n${perCaseTable(labels.filter(label => label.set === set), results)}`);
  writeFileSync(join(values.results, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(join(values.results, 'per-case-table.md'), `# Per-case outcomes\n\n${tables.join('\n')}`);
  if (values.record) {
    const read = name => JSON.parse(readFileSync(join(values.results, name), 'utf8'));
    const { model } = read('model.json');
    recordEvaluation(values.record, holdoutEvaluation(summary, { model: model.name, endpoint: model.endpoint,
      evaluatedAt: read('run-meta.json').finishedAt }));
  }
  for (const set of Object.keys(sets)) {
    const { modelOutcome: model, latency, ...views } = summary[set];
    console.log(set, JSON.stringify({ contract: summary.scoringContract.version, modelOutcomeAgreement: model.agreement,
      ...Object.fromEntries(Object.entries(views).map(([view, score]) => [`${view}Agreement`, score.agreement])),
      under: model.underEscalation, over: model.overEscalation, injection: model.injection, valid: model.structuralValidity,
      stability: model.stability.rate, latency }));
  }
}

if (isMainModule(import.meta.url)) main();
