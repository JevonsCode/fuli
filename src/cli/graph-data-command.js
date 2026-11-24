import { createInterface } from 'node:readline/promises';

import { abandonUnfinishedImport, importToAbandon } from '../backup/abandon-import.js';
import { exportGraphData, importGraphData } from '../backup/graph-backup.js';
import { createGraphBackupAdapter } from '../backup/runtime-adapters.js';
import { resolveSetupPaths } from '../setup/paths.js';
import { readRuntimeSettings } from '../system/runtime-settings.js';
import { localRuntimeControl } from './local-runtime-control.js';
import { refuseOnFollower } from './follower-graph-refusal.js';
import { writeLine } from './terminal-io.js';

export async function runGraphDataCommand(action, args, dependencies = {}) {
  const options = parseGraphDataOptions(action, args);
  const resolvePaths = dependencies.resolvePaths ?? resolveSetupPaths;
  const paths = resolvePaths({ dataDir: options.dataDir, env: dependencies.env ?? process.env });
  refuseOnFollower(paths.dataDir, `fuli graph ${action}`, { isRunner: dependencies.isRunner });
  const readSettings = dependencies.readSettings ?? readRuntimeSettings;
  const saved = readSettings(paths.runtimeSettingsPath);
  const mode = options.mode ?? saved.graphRuntimeMode;
  const write = dependencies.write ?? writeLine;

  // Giving an import up looks first: with nothing to give up, nothing is
  // asked or stopped. It moves graphs aside, so a person runs it in a
  // terminal (no Agent shell, no MCP tool); --yes only skips the question there.
  if (action === 'abandon-import') {
    const found = (dependencies.importToAbandon ?? importToAbandon)({ paths, mode, platform: dependencies.platform });
    if (found === 'nothing') {
      write(nothingToAbandon(mode));
      return { status: 'nothing', targetMode: mode };
    }
    if (!(dependencies.interactive ?? process.stdin.isTTY === true)) {
      throw Object.assign(new Error('放弃导入会挪开图谱，要你自己在终端里运行这条命令；没有终端时不做，--yes 只是在终端里省掉确认。'
        + ' / Giving an import up moves graphs aside, so run this command yourself in an interactive terminal; without one nothing is done, and --yes only skips the question there.'),
      { code: 'needs_person' });
    }
  }

  if (action !== 'export' && !options.yes) {
    const confirm = dependencies.confirm ?? (action === 'import' ? confirmImport : confirmAbandon);
    if (!await confirm(mode)) {
      write('Cancelled. Graph data was not changed.');
      return { status: 'cancelled' };
    }
  }

  // A running console wakes graph services on demand, which reopens the
  // database between the offline stop and the dump or load. The whole local
  // runtime is stopped first and started again only if it was running.
  const runtime = dependencies.runtime ?? localRuntimeControl(paths, dependencies.env ?? process.env, write);
  const consoleWasRunning = await runtime.consoleRunning();
  if (consoleWasRunning) {
    write('Stopping the running Fuli console and graph services for an offline graph copy...');
    const stopped = await runtime.stop();
    if (stopped?.status === 'partial') {
      throw new Error('Could not confirm that the running Fuli console stopped. Graph data was not changed.');
    }
  }
  // An import that left a graph which may be half written, or found one an
  // earlier import left, starts nothing (graph-backup.js says why): a start
  // would only be refused. Any other failure starts what ran before again, and
  // a start that fails too does not hide why the command failed.
  let failure = null;
  try {
    return await transferGraphData({ action, options, paths, mode, write, dependencies });
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    const halfWritten = ['graph_import_incomplete', 'graph_import_unfinished'].includes(failure?.code);
    if (consoleWasRunning && !halfWritten) {
      write('Starting Fuli again...');
      try { await runtime.start(); }
      catch (startError) {
        if (!failure) throw startError;
        throw new AggregateError([failure, startError], `${failure.message} / Fuli did not start again either: ${startError.message}`, { cause: failure });
      }
    }
  }
}

async function transferGraphData({ action, options, paths, mode, write, dependencies }) {
  const createAdapter = dependencies.createAdapter ?? createGraphBackupAdapter;
  const adapter = await createAdapter({
    mode,
    paths,
    onProgress: write
  });
  if (action === 'abandon-import') {
    const abandon = dependencies.abandonImport ?? abandonUnfinishedImport;
    const result = await abandon({ adapter, targetMode: mode, paths });
    write(result.status === 'nothing' ? nothingToAbandon(mode) : result.words);
    return result;
  }
  if (action === 'export') {
    const exportData = dependencies.exportData ?? exportGraphData;
    const result = await exportData({
      outputDir: options.outputDir,
      sourceMode: mode,
      instances: adapter.instances,
      adapter
    });
    write(`Graph data exported from ${mode} mode to ${options.outputDir}.`);
    return result;
  }

  const importData = dependencies.importData ?? importGraphData;
  const result = await importData({
    inputDir: options.inputDir,
    targetMode: mode,
    rollbackDir: paths.graphBackupDir,
    adapter
  });
  write(result.rollbackDir
    ? `Graph data imported into ${mode} mode. A pre-import rollback backup was preserved.`
    : `Graph data imported into ${mode} mode. The target had no prior data to preserve.`);
  if (result.earlierCopy) {
    write(`上次没完成的那次导入之前的副本还留着：${result.earlierCopy}，用不着时可以自己删掉。`
      + ` / The copy taken before the earlier unfinished import is still kept at ${result.earlierCopy}; delete it yourself once it is not needed.`);
  }
  return result;
}

export function parseGraphDataOptions(action, args = []) {
  if (!['export', 'import', 'abandon-import'].includes(action)) {
    throw new TypeError('Graph command must be export, import or abandon-import.');
  }
  const result = {
    action,
    outputDir: null,
    inputDir: null,
    mode: null,
    dataDir: null,
    yes: false
  };
  const values = {
    export: { '--output': 'outputDir', '--mode': 'mode', '--data-dir': 'dataDir' },
    import: { '--input': 'inputDir', '--target-mode': 'mode', '--data-dir': 'dataDir' },
    'abandon-import': { '--target-mode': 'mode', '--data-dir': 'dataDir' }
  }[action];
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (seen.has(flag)) throw new TypeError(`Duplicate ${flag}`);
    if (flag === '--yes' && action !== 'export') {
      result.yes = true;
      seen.add(flag);
      continue;
    }
    const key = values[flag];
    if (!key) throw new TypeError(`Unknown graph ${action} option: ${flag}`);
    const value = args[index + 1];
    if (typeof value !== 'string' || !value.trim() || value.startsWith('--')) {
      throw new TypeError(`Missing value for ${flag}`);
    }
    result[key] = value.trim();
    seen.add(flag);
    index += 1;
  }
  if (action === 'export' && !result.outputDir) throw new TypeError('--output is required');
  if (action === 'import' && !result.inputDir) throw new TypeError('--input is required');
  if (result.mode && !['container', 'native'].includes(result.mode)) {
    throw new TypeError('Graph runtime mode must be container or native.');
  }
  return result;
}

const nothingToAbandon = mode => `没有没完成的导入要放弃（${mode} 模式）。 / No unfinished import into the ${mode} runtime to give up.`;

function confirmImport(mode) {
  return confirmed(`Import will replace the current ${mode} graph after making a rollback backup. Continue? [y/N] `);
}

function confirmAbandon(mode) {
  return confirmed(`放弃没完成的那次导入：可能只写了一半的图谱会被挪开（不删除），之后它是空的。继续吗？ / Give up the unfinished import: each ${mode} graph that may be half written moves aside (not deleted) and is empty afterwards. Continue? [y/N] `);
}

async function confirmed(question) {
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await input.question(question)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    input.close();
  }
}
