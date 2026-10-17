import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { parseGraphMigrateOptions, runGraphMigrateCommand } from '../src/cli/graph-migrate-command.js';
import { resolveSetupPaths } from '../src/setup/paths.js';

test('graph migrate only accepts an explicit native target', () => {
  assert.deepEqual(parseGraphMigrateOptions(['--to', 'native', '--yes', '--data-dir', '/data']),
    { to: 'native', dataDir: '/data', yes: true });
  assert.throws(() => parseGraphMigrateOptions([]), /--to native/);
  assert.throws(() => parseGraphMigrateOptions(['--to', 'container']), /--to native/);
  assert.throws(() => parseGraphMigrateOptions(['--to']), /Missing value/);
});

test('graph migrate asks first and changes nothing when declined', async () => {
  let migrated = false;
  const result = await runGraphMigrateCommand(['--to', 'native'], {
    resolvePaths: () => resolveSetupPaths({ dataDir: '/data', packageRoot: '/package' }),
    confirm: async () => false,
    migrate: async () => { migrated = true; },
    runtime: {},
    write: () => {}
  });
  assert.deepEqual(result, { status: 'cancelled' });
  assert.equal(migrated, false);
});

test('graph migrate sets each mode up for this data directory without touching Agent settings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fuli-graph-migrate-'));
  const paths = resolveSetupPaths({ dataDir: root, packageRoot: '/package' });
  await writeFile(paths.graphRuntimeConfigPath, JSON.stringify({ workspaces: [] }));
  const setups = [];
  const output = [];
  await runGraphMigrateCommand(['--to', 'native', '--yes'], {
    resolvePaths: () => paths,
    runtime: { consoleRunning: async () => false, stop: async () => {}, start: async () => {} },
    setup: async (args) => setups.push(args),
    async migrate({ backupRoot, ports }) {
      assert.equal(backupRoot, paths.graphBackupDir);
      await ports.setupRuntime('native');
      await ports.setupRuntime('container');
      return { status: 'migrated', backupDir: join(backupRoot, 'container-to-native-x') };
    },
    write: (line) => output.push(line)
  });
  assert.deepEqual(setups, ['native', 'container'].map((mode) => [
    '--yes', '--skip-agents', '--runtime-mode', mode, '--personal-only', '--data-dir', root
  ]));
  assert.match(output.at(-1), /Docker is no longer needed/);
  assert.match(output.at(-1), /left stopped and unchanged/);
});
