import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { bundledPackagesFile } from './bundled-packages.js';

// The pull request audit gate: which advisories in an `npm audit --json`
// report reach the people who install FULI. Two things ship: the packages a
// production install puts in node_modules (every npm-shrinkwrap.json entry not
// marked dev, as `npm install -g` and the tray's `npm ci --omit=dev` install
// them), and the packages built into the console bundle, which are
// devDependencies but ship inside dist/web. An advisory only in a test or
// build tool does not block; .github/workflows/dependency-audit.yml audits the
// whole tree daily and opens a fix pull request or an issue for it.
//
// node scripts/audit-shipped.js REPORT [--root DIR]
//   Run after `npm run build:web`, which records the bundled packages.
//   Exit 1 when an advisory reaches what ships; 2 when there is no report
//   (registry or lockfile error) or no record of the bundle.

const BLOCKING = new Set(['low', 'moderate', 'high', 'critical']);

const { values: options, positionals: [reportPath] } = parseArgs({
  allowPositionals: true,
  options: { root: { type: 'string' } }
});
const root = resolve(options.root ?? fileURLToPath(new URL('..', import.meta.url)));
if (!reportPath) refuse('Usage: node scripts/audit-shipped.js REPORT [--root DIR]');

const report = readJson(reportPath, 'The npm audit report');
if (typeof report?.vulnerabilities !== 'object' || report.vulnerabilities === null) {
  refuse(`npm audit did not produce a report; it said:\n${JSON.stringify(report?.error ?? report, null, 2)}`);
}
const { packages = {} } = readJson(join(root, 'npm-shrinkwrap.json'), 'npm-shrinkwrap.json');
const bundled = new Set(readJson(bundledPackagesFile(root), 'The console bundle record (run `npm run build:web` first)'));
const ships = (node) => bundled.has(node) || (packages[node] !== undefined && packages[node].dev !== true);

const advisories = Object.values(report.vulnerabilities)
  .filter(({ severity }) => BLOCKING.has(severity))
  .sort((a, b) => a.name.localeCompare(b.name));
const blocking = advisories.filter(({ nodes = [] }) => nodes.some(ships));
const devOnly = advisories.filter((entry) => !blocking.includes(entry));

if (blocking.length) {
  console.error('Advisories in what ships to users (fix before merging):');
  for (const entry of blocking) console.error(`  ${describe(entry)}`);
  process.exitCode = 1;
}
if (devOnly.length) {
  console.log('Advisories only in development tools (the daily dependency audit opens a fix):');
  for (const entry of devOnly) console.log(`  ${describe(entry)}`);
}
if (!advisories.length) console.log('No advisories.');

function describe(entry) {
  const via = entry.via ?? [];
  const sources = [...new Set(via.filter((item) => typeof item === 'object' && item !== null)
    .map(({ title, url }) => `${title} ${url}`))];
  const through = via.filter((item) => typeof item === 'string');
  return `${entry.name} ${entry.range} (${entry.severity})`
    + (sources.length ? `: ${sources.join('; ')}` : '')
    + (through.length ? ` via ${through.join(', ')}` : '');
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return refuse(`${label} could not be read: ${error.message}`);
  }
}

function refuse(message) {
  console.error(message);
  process.exit(2);
}
