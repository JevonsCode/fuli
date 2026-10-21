import { parseArgs } from 'node:util';

import { pruneFormatBackups, backupRetentionPolicy } from '../data-format/backup-retention.js';
import { collectFormatStatus } from '../data-format/format-status.js';
import { personalGraphFormat } from '../data-format/graph-format-client.js';
import { previewMigrations } from '../data-format/migration-plan.js';
import { findApplyReceipt } from '../data-format/apply-receipts.js';
import {
  applyMigrations, describeRestore, restoreStore, rollbackMigration
} from '../data-format/migration-operations.js';
import { resolveSetupPaths } from '../setup/paths.js';
import { acquireMaintenance, holdDataDirectory } from '../data-format/maintenance-lock.js';
import { localRuntimeControl } from './local-runtime-control.js';
import { confirmInTerminal, writeLine } from './terminal-io.js';

// `fuli migrate` (rec#17 D-09): data formats of one data directory.
// - status, preview: read only, safe while FULI runs, fine for an Agent to run.
// - apply, rollback, restore change real data. They show what they will do
//   and ask at an interactive terminal; there is no --yes, and no MCP or Agent
//   tool reaches them. A terminal does not prove a person decided, so FULI
//   records entrypoint cli with presence unverified.
// - prune: removes only backups the retention policy allows.

const USAGE = [
  'Usage: fuli migrate status [--json] [--data-dir DIR]',
  '       fuli migrate preview [--json] [--data-dir DIR]',
  '       fuli migrate apply --digest DIGEST [--data-dir DIR]',
  '       fuli migrate rollback --store LABEL --migration ID [--data-dir DIR]',
  '       fuli migrate restore --store LABEL [--backup REF] [--data-dir DIR]',
  '       fuli migrate prune [--keep N] [--max-mb MB] [--dry-run] [--data-dir DIR]'
].join('\n');
const UNREADABLE_EXIT_CODE = 2;
const FAILED_EXIT_CODE = 1;
const OPTIONS = Object.freeze({
  status: { json: { type: 'boolean' } },
  preview: { json: { type: 'boolean' } },
  apply: { digest: { type: 'string' } },
  rollback: { store: { type: 'string' }, migration: { type: 'string' } },
  restore: { store: { type: 'string' }, backup: { type: 'string' } },
  prune: { keep: { type: 'string' }, 'max-mb': { type: 'string' }, 'dry-run': { type: 'boolean' } }
});
const CHANGES = new Set(['apply', 'rollback', 'restore']);
const CLI_ACTOR = Object.freeze({ entrypoint: 'cli' });

export async function runMigrateCommand(args, dependencies = {}) {
  const [action, ...rest] = args;
  if (!Object.hasOwn(OPTIONS, action ?? '')) throw new TypeError(USAGE);
  const options = parseMigrateOptions(action, rest);
  if (CHANGES.has(action) && !(dependencies.interactive ?? process.stdin.isTTY === true)) {
    throw new TypeError(`fuli migrate ${action} changes FULI data and asks you to confirm, so run it in an `
      + 'interactive terminal');
  }
  const env = dependencies.env ?? process.env;
  const paths = (dependencies.resolvePaths ?? resolveSetupPaths)({ dataDir: options['data-dir'] ?? null, env });
  const context = { options, paths, env, write: dependencies.write ?? writeLine,
    confirm: dependencies.confirm ?? confirmInTerminal, fetchImpl: dependencies.fetchImpl ?? fetch,
    graph: dependencies.graph ?? personalGraphFormat(paths.dataDir, { fetchImpl: dependencies.fetchImpl ?? fetch }),
    consoleRunning: dependencies.consoleRunning ?? (() => localRuntimeControl(paths, env, () => {}).consoleRunning()),
    maintenance: dependencies.maintenance ?? { hold: holdDataDirectory, acquire: acquireMaintenance } };
  return ACTIONS[action](context);
}

function parseMigrateOptions(action, args) {
  try {
    const { values } = parseArgs({ args, options: { ...OPTIONS[action], 'data-dir': { type: 'string' } },
      strict: true, allowPositionals: false });
    return values;
  } catch (error) {
    throw new TypeError(`${USAGE}\n${error.message}`);
  }
}

const ACTIONS = Object.freeze({
  async status({ options, paths, write, fetchImpl }) {
    const report = await collectFormatStatus({ dataDir: paths.dataDir, fetchImpl });
    write(options.json ? JSON.stringify(report, null, 2) : formatStatus(report));
    const unavailable = report.stores.filter((store) => store.state === 'unavailable');
    if (!unavailable.length) return { exitCode: 0, report };
    if (!options.json) {
      write(`Could not read ${unavailable.map((store) => store.label).join(', ')} without writing; `
        + 'nothing was changed.');
    }
    return { exitCode: UNREADABLE_EXIT_CODE, report };
  },

  async preview({ options, paths, write, graph }) {
    const plan = await previewMigrations({ dataDir: paths.dataDir, graph });
    write(options.json ? JSON.stringify(plan, null, 2) : formatPlan(plan, paths.dataDir));
    return { exitCode: 0, plan };
  },

  async apply({ options, paths, write, confirm, graph, maintenance }) {
    if (!options.digest) throw new TypeError(`${USAGE}\nRun fuli migrate preview first; apply needs its digest.`);
    const plan = await previewMigrations({ dataDir: paths.dataDir, graph });
    const started = plan.digest !== options.digest && startedApply(paths.dataDir, options.digest);
    if (started) {
      // Confirmed before; its answer may never have arrived. Each store says whether it applied.
      write(`This plan was confirmed at ${started.at}. Checking each store again: `
        + `${started.stores.map((store) => `${store.label} ${store.migrationId}`).join(', ')}`);
    } else if (plan.digest !== options.digest) {
      write(plan.digest ? 'The stores changed since that preview. Nothing was changed; this is the current plan:'
        : 'Nothing waits for a confirmation now. Nothing was changed.');
      if (plan.digest) write(formatPlan(plan, paths.dataDir));
      return { exitCode: FAILED_EXIT_CODE, status: 'stale' };
    }
    if (!started) write(formatPlan(plan, paths.dataDir, { confirming: true }));
    if (!await confirm('Apply exactly these migrations? Recorded as entrypoint cli, presence unverified. [y/N] ',
      { defaultYes: false })) {
      write('Cancelled. Nothing was changed.');
      return { exitCode: 0, status: 'cancelled' };
    }
    const result = await held(maintenance.hold(paths.dataDir), () => applyMigrations({ dataDir: paths.dataDir,
      digest: options.digest, actor: CLI_ACTOR, graph }));
    write(formatOperation(result));
    return { exitCode: result.status === 'applied' ? 0 : FAILED_EXIT_CODE, ...result };
  },

  async rollback({ options, paths, write, confirm, graph, maintenance }) {
    if (!options.store || !options.migration) throw new TypeError(USAGE);
    write([`Undo migration ${options.migration} of ${options.store}.`,
      'Only the records that migration changed are put back, and only if none of them changed since;',
      'otherwise nothing is changed. Afterwards this FULI keeps the store unavailable until the migration',
      'is applied again (use this to return to an earlier FULI). A backup is taken first.'].join('\n'));
    if (!await confirm('Undo it? Recorded as entrypoint cli, presence unverified. [y/N] ', { defaultYes: false })) {
      write('Cancelled. Nothing was changed.');
      return { exitCode: 0, status: 'cancelled' };
    }
    const result = await held(maintenance.hold(paths.dataDir), () => rollbackMigration({ dataDir: paths.dataDir,
      label: options.store, migrationId: options.migration, actor: CLI_ACTOR, graph }));
    write(`Undone: ${result.migrationId} of ${result.label}; the store is at version ${result.version}.`);
    return { exitCode: 0, ...result };
  },

  async restore({ options, paths, write, confirm, consoleRunning, maintenance }) {
    if (!options.store) throw new TypeError(USAGE);
    const { backups, impact } = describeRestore({ dataDir: paths.dataDir, label: options.store,
      backupRef: options.backup ?? null });
    if (!impact) {
      write([`Backups of ${options.store} (oldest first):`, ...backups.map((backup) =>
        `  ${backup.ref}  version ${backup.version}  taken ${backup.takenAt}`),
      ...(backups.length ? [] : ['  none']),
      'Restore one with --backup REF. Undoing one migration is fuli migrate rollback instead.'].join('\n'));
      return { exitCode: 0, backups };
    }
    // Held from before the question to the end, so no console starts meanwhile.
    let release;
    try {
      release = maintenance.acquire(paths.dataDir);
    } catch (error) {
      if (error?.code !== 'data_format_maintenance') throw error;
      write('Stop FULI first (fuli stop): a whole-store restore needs the store unused. Nothing was changed.');
      return { exitCode: FAILED_EXIT_CODE, status: 'console_running' };
    }
    return held(release, async () => {
      if (await consoleRunning()) {
        write('Stop FULI first (fuli stop): a whole-store restore needs the store unused. Nothing was changed.');
        return { exitCode: FAILED_EXIT_CODE, status: 'console_running' };
      }
      write(formatRestore(impact));
      if (!await confirm('Replace the whole store with this backup and lose those changes? [y/N] ',
        { defaultYes: false })) {
        write('Cancelled. Nothing was changed.');
        return { exitCode: 0, status: 'cancelled' };
      }
      // The store must still be what the person was shown; checked again inside its lock.
      const result = restoreStore({ dataDir: paths.dataDir, label: options.store, backupRef: options.backup,
        expected: impact, actor: CLI_ACTOR });
      write(`Restored ${result.label} from ${result.backupRef}. The replaced store is kept as `
        + `${result.safetyBackupRef}.`);
      return { exitCode: 0, ...result };
    });
  },

  async prune({ options, paths, env, write, maintenance }) {
    const policy = backupRetentionPolicy(env, {
      keep: options.keep === undefined ? undefined : wholeNumber(options.keep, '--keep'),
      maxMegabytes: options['max-mb'] === undefined ? undefined : wholeNumber(options['max-mb'], '--max-mb')
    });
    const result = await held(maintenance.hold(paths.dataDir), () => pruneFormatBackups(paths.dataDir,
      { policy, dryRun: options['dry-run'] === true }));
    write([`${options['dry-run'] ? 'Would prune' : 'Pruned'} ${result.pruned.length} format backups; `
      + `${result.kept} kept. Backups an undo or the current version needs are never pruned.`,
    ...result.pruned.map((entry) => `  ${entry.label}: ${entry.backupRef} (version ${entry.version}, `
      + `${entry.bytes} bytes) — ${entry.reason}`)].join('\n'));
    return { exitCode: 0, ...result };
  }
});

function startedApply(dataDir, digest) {
  return findApplyReceipt(dataDir, digest);
}

async function held(release, operation) {
  try { return await operation(); } finally { release(); }
}

function wholeNumber(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new TypeError(`${name} must be a positive whole number`);
  return number;
}

function formatPlan(plan, dataDir, { confirming = false } = {}) {
  const lines = [confirming ? 'FULI data format migrations to apply' : 'FULI data format migrations (preview; '
    + 'nothing was changed)', `Data directory: ${dataDir}`, ''];
  if (!plan.stores.length) lines.push('Nothing waits for a confirmation.');
  for (const store of plan.stores) {
    const { step } = store;
    lines.push(`${store.label}  [${store.store}, ${store.kind}]  version ${step.fromVersion} → ${step.toVersion}`,
      `    step ${step.id} (${step.kind}): ${step.summary}`,
      `    ${step.count} records, e.g. ${step.sampleIds.join(', ')}${step.count > step.sampleIds.length ? ' …' : ''}`,
      `    ${store.undo === 'available' ? 'undo: fuli migrate rollback; ' : 'undo: only a whole restore; '}`
      + `${store.kind === 'neo4j' ? 'kept in an undo journal in the graph' : 'backed up first'}`);
    if (store.automatic?.length) lines.push(`    runs first: ${store.automatic.join(', ')}`);
    if (store.warning) lines.push(`    WARNING: ${store.warning}`);
  }
  if (plan.blocked.length) {
    lines.push('', 'Not applied here:');
    for (const store of plan.blocked) {
      lines.push(`${store.label}  [${store.store}]  ${store.action}${store.steps?.length ? ` (${store.steps.join(', ')})` : ''}`
        + ` — ${store.reason}`);
    }
  }
  if (plan.digest) {
    lines.push('', `Plan digest: ${plan.digest}`);
    if (!confirming) {
      lines.push(`Apply exactly this plan: fuli migrate apply --digest ${plan.digest}`,
        'It is checked again before anything changes; the digest is not a permission.');
    }
  }
  return lines.join('\n');
}

function formatOperation(result) {
  const lines = result.results.map((entry) => entry.status === 'failed'
    ? `${entry.label}: not applied (${entry.code}) — ${entry.message}`
    : `${entry.label}: ${entry.status} ${entry.migrationId}${entry.count === undefined ? '' : `, ${entry.count} records`}`);
  for (const skipped of result.skipped) lines.push(`${skipped.label}: not attempted (${skipped.migrationId})`);
  if (result.pruned.length) lines.push(`Pruned ${result.pruned.length} older format backups.`);
  return lines.join('\n');
}

function formatRestore(impact) {
  return [`Whole-store restore of ${impact.store} from ${impact.backupRef}`,
    `  version now ${impact.currentVersion ?? '-'}, in the backup ${impact.backupVersion ?? '-'}`,
    ...impact.tables.map((table) => `  ${table.table}: ${table.current} rows now, ${table.backup} in the backup`),
    ...impact.laterMigrations.map((entry) => `  recorded after the backup: ${entry.migrationId} ${entry.status}`),
    `  ${impact.warning}`,
    '  The store as it is now is backed up first.'].join('\n');
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
