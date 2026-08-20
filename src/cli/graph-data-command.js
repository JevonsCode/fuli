import { createInterface } from 'node:readline/promises';

import { exportGraphData, importGraphData } from '../backup/graph-backup.js';
import { createGraphBackupAdapter } from '../backup/runtime-adapters.js';
import { resolveSetupPaths } from '../setup/paths.js';
import { readRuntimeSettings } from '../system/runtime-settings.js';

export async function runGraphDataCommand(action, args, dependencies = {}) {
  const options = parseGraphDataOptions(action, args);
  const resolvePaths = dependencies.resolvePaths ?? resolveSetupPaths;
  const paths = resolvePaths({ dataDir: options.dataDir, env: dependencies.env ?? process.env });
  const readSettings = dependencies.readSettings ?? readRuntimeSettings;
  const saved = readSettings(paths.runtimeSettingsPath);
  const mode = options.mode ?? saved.graphRuntimeMode;
  const write = dependencies.write ?? writeLine;

  if (action === 'import' && !options.yes) {
    const confirm = dependencies.confirm ?? confirmImport;
    if (!await confirm(mode)) {
      write('Cancelled. Graph data was not changed.');
      return { status: 'cancelled' };
    }
  }

  const createAdapter = dependencies.createAdapter ?? createGraphBackupAdapter;
  const adapter = await createAdapter({
    mode,
    paths,
    onProgress: write
  });
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
  return result;
}

export function parseGraphDataOptions(action, args = []) {
  if (!['export', 'import'].includes(action)) {
    throw new TypeError('Graph command must be export or import.');
  }
  const result = {
    action,
    outputDir: null,
    inputDir: null,
    mode: null,
    dataDir: null,
    yes: false
  };
  const values = action === 'export'
    ? { '--output': 'outputDir', '--mode': 'mode', '--data-dir': 'dataDir' }
    : { '--input': 'inputDir', '--target-mode': 'mode', '--data-dir': 'dataDir' };
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (seen.has(flag)) throw new TypeError(`Duplicate ${flag}`);
    if (flag === '--yes' && action === 'import') {
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

async function confirmImport(mode) {
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await input.question(
      `Import will replace the current ${mode} graph after making a rollback backup. Continue? [y/N] `
    )).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    input.close();
  }
}

function writeLine(value) {
  process.stdout.write(`${value}\n`);
}
