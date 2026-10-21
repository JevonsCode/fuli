import { collectFormatStatus } from '../data-format/format-status.js';
import { resolveSetupPaths } from '../setup/paths.js';
import { writeLine } from './terminal-io.js';

// `fuli migrate status [--json] [--data-dir DIR]` (rec#17 D-09): every
// store's data format, ledger and the steps FULI would take, read only. Safe
// while FULI runs. Exits 2, after reporting, when a store could not be read
// without writing; it never falls back to a writable open.
// preview/apply/rollback are part 2.

const USAGE = 'Usage: fuli migrate status [--json] [--data-dir DIR]';
const UNREADABLE_EXIT_CODE = 2;

export async function runMigrateCommand(args, dependencies = {}) {
  const [action, ...rest] = args;
  if (action !== 'status') throw new TypeError(USAGE);
  const options = parseStatusOptions(rest);
  const env = dependencies.env ?? process.env;
  const write = dependencies.write ?? writeLine;
  const paths = (dependencies.resolvePaths ?? resolveSetupPaths)({ dataDir: options.dataDir, env });
  const report = await collectFormatStatus({ dataDir: paths.dataDir, fetchImpl: dependencies.fetchImpl ?? fetch });
  write(options.json ? JSON.stringify(report, null, 2) : formatStatus(report));
  const unavailable = report.stores.filter((store) => store.state === 'unavailable');
  if (!unavailable.length) return { exitCode: 0, report };
  if (!options.json) {
    write(`Could not read ${unavailable.map((store) => store.label).join(', ')} without writing; `
      + 'nothing was changed.');
  }
  return { exitCode: UNREADABLE_EXIT_CODE, report };
}

function parseStatusOptions(args) {
  const options = { json: false, dataDir: null };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--json') options.json = true;
    else if (args[index] === '--data-dir' && args[index + 1]) options.dataDir = args[++index];
    else throw new TypeError(`${USAGE}\nUnknown option: ${args[index]}`);
  }
  return options;
}

function formatStatus(report) {
  const lines = ['FULI data formats (read only; nothing was changed)', `Data directory: ${report.dataDir}`, ''];
  for (const store of report.stores) {
    lines.push(`${store.label}  [${store.store}, ${store.kind}]  found ${store.version ?? '-'}  target `
      + `${store.target ?? '-'}  ${store.state}${store.note ? `  (${store.note})` : ''}`);
    for (const step of store.steps ?? []) lines.push(`    step ${step.id}: ${step.state} — ${step.detail}`);
    for (const entry of store.ledger ?? []) {
      lines.push(`    ledger ${entry.migrationId ?? '-'} ${entry.fromVersion ?? '?'}→${entry.toVersion ?? '?'} `
        + `${entry.status}${entry.backupRef ? ` backup ${entry.backupRef}` : ''}`);
    }
  }
  return lines.join('\n');
}
