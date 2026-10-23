#!/usr/bin/env node
// npm run measure:context-delivery [-- --out result.json] [-- --scenario name]
// Replays the synthetic scenarios through the real hook entries and prints
// the Markdown table; the full JSON result goes to --out or, with --json, stdout.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BUCKETS, markdownTable, summarize, UNIT_NOTE } from './report.js';
import { runScenario, SCENARIOS } from './scenarios.js';

const option = (args, name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);

function measuredCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fileURLToPath(new URL('.', import.meta.url)), encoding: 'utf8' }).trim();
  } catch { return null; }
}

export async function measure(names = Object.keys(SCENARIOS)) {
  const results = [];
  for (const name of names) results.push(summarize(name, await runScenario(name)));
  return { unit: UNIT_NOTE, commit: measuredCommit(), buckets: BUCKETS, scenarios: results };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const scenario = option(args, '--scenario');
  if (scenario && !SCENARIOS[scenario]) throw new TypeError(`Unknown scenario ${scenario}; one of ${Object.keys(SCENARIOS).join(', ')}`);
  const result = await measure(scenario ? [scenario] : undefined);
  const out = option(args, '--out');
  if (out) writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  if (args.includes('--json')) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write(`Measured on ${result.commit ?? 'an unknown commit'}.\n\n${markdownTable(result.scenarios)}\n`);
  const failed = result.scenarios.some(item => item.checks.some(check => !check.pass)
    || item.correctness.correct_turns !== item.correctness.delivered_turns);
  process.exitCode = failed ? 1 : 0;
}
