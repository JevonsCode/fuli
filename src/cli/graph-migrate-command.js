import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';

import { exportGraphData, importGraphData } from '../backup/graph-backup.js';
import { createGraphBackupAdapter, managedGraphInstances } from '../backup/runtime-adapters.js';
import { migrateContainerGraphToNative } from '../backup/runtime-migration.js';
import { readWindowsNativeBundle, resolveWindowsNativeBundle } from '../native-runtime/windows-assets.js';
import { resolveSetupPaths } from '../setup/paths.js';
import { readRuntimeSettings } from '../system/runtime-settings.js';
import { localRuntimeControl } from './local-runtime-control.js';
import { runSetupCommand } from './setup-command.js';

// `fuli graph migrate --to native`: move this data directory's container graph
// into the native runtime. Client integrations are not changed here.
export async function runGraphMigrateCommand(args, dependencies = {}) {
  const options = parseGraphMigrateOptions(args);
  const env = dependencies.env ?? process.env;
  const write = dependencies.write ?? writeLine;
  const paths = (dependencies.resolvePaths ?? resolveSetupPaths)({ dataDir: options.dataDir, env });
  write([
    'Move the container graph to the native runtime',
    `Data: ${paths.dataDir}`,
    'The container graph is counted and exported, then left stopped and unchanged.',
    'The native graph is accepted only when every label and relationship count matches;',
    'otherwise Fuli switches back to the container graph.',
    'Agent and client settings are not changed.'
  ].join('\n'));
  if (!options.yes && !await (dependencies.confirm ?? confirmMigration)()) {
    write('Cancelled. Nothing was changed.');
    return { status: 'cancelled' };
  }
  const runtime = dependencies.runtime ?? localRuntimeControl(paths, env, write);
  const setup = dependencies.setup ?? runSetupCommand;
  const workspace = managedGraphInstances(paths).includes('workspace');
  const result = await (dependencies.migrate ?? migrateContainerGraphToNative)({
    backupRoot: paths.graphBackupDir,
    ports: {
      runtimeMode: () => readRuntimeSettings(paths.runtimeSettingsPath).graphRuntimeMode,
      checkNative: dependencies.checkNative ?? (() => checkNativeAssets(paths)),
      consoleRunning: runtime.consoleRunning,
      stopRuntime: runtime.stop,
      startRuntime: runtime.start,
      createAdapter: (mode) => (dependencies.createAdapter ?? createGraphBackupAdapter)({
        mode, paths, onProgress: write
      }),
      exportGraph: ({ adapter, outputDir }) => exportGraphData({
        outputDir, sourceMode: 'container', instances: adapter.instances, adapter
      }),
      importGraph: ({ adapter, inputDir }) => importGraphData({
        inputDir, targetMode: 'native', rollbackDir: paths.graphBackupDir, adapter
      }),
      setupRuntime: (mode) => setup([
        '--yes', '--skip-agents', '--runtime-mode', mode,
        workspace ? '--with-dev-public' : '--personal-only', '--data-dir', paths.dataDir
      ], { env, write }),
      write
    }
  });
  write(result.status === 'already_native'
    ? 'This data already uses the native graph runtime. Nothing was changed.'
    : [
      'Fuli now runs on the native graph runtime; Docker is no longer needed for it.',
      `Container export kept at: ${result.backupDir}`,
      'The container volume was left stopped and unchanged. Remove it yourself once you no longer need it.'
    ].join('\n'));
  return result;
}

export function parseGraphMigrateOptions(args = []) {
  const result = { to: null, dataDir: null, yes: false };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--yes') { result.yes = true; continue; }
    const key = { '--to': 'to', '--data-dir': 'dataDir' }[flag];
    const value = args[index + 1];
    if (!key) throw new TypeError(`Unknown graph migrate option: ${flag}`);
    if (typeof value !== 'string' || !value.trim() || value.startsWith('--')) {
      throw new TypeError(`Missing value for ${flag}`);
    }
    result[key] = value.trim();
    index += 1;
  }
  if (result.to !== 'native') throw new TypeError('graph migrate requires --to native');
  return result;
}

// Windows native needs the portable bundle shipped with the tray package.
function checkNativeAssets(paths) {
  if (process.platform !== 'win32') return;
  const packageRoot = dirname(paths.graphComposePath);
  const bundle = readWindowsNativeBundle(packageRoot);
  if (!bundle) {
    throw new Error('This Fuli package has no built-in Neo4j runtime. Run the migration from the installed Fuli desktop package.');
  }
  resolveWindowsNativeBundle(bundle, { providerSource: join(packageRoot, 'graph-provider') });
}

async function confirmMigration() {
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await input.question('Move the graph now? [y/N] ')).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    input.close();
  }
}

function writeLine(value) {
  process.stdout.write(`${value}\n`);
}
