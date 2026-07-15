import test from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';

import { resolveSetupPaths } from '../src/setup/paths.js';

const PACKAGE_ROOT = resolve('T:/fuli-package');

test('setup paths use LocalAppData on Windows', () => {
  const paths = resolveSetupPaths({
    platform: 'win32',
    env: { LOCALAPPDATA: 'C:/Users/Test/AppData/Local' },
    homeDir: 'C:/Users/Test',
    packageRoot: PACKAGE_ROOT
  });

  assert.equal(paths.dataDir, resolve('C:/Users/Test/AppData/Local/Fuli'));
  assert.equal(paths.dbPath, join(paths.dataDir, 'context.db'));
  assert.equal(paths.backupDir, join(paths.dataDir, 'backups', 'agents'));
  assert.equal(paths.logPath, join(paths.dataDir, 'logs', 'runtime.log'));
  assert.equal(paths.statePath, join(paths.dataDir, 'runtime.json'));
});

test('setup paths use the platform data convention on macOS and Linux', () => {
  const mac = resolveSetupPaths({
    platform: 'darwin',
    env: {},
    homeDir: '/Users/test',
    packageRoot: PACKAGE_ROOT
  });
  const linux = resolveSetupPaths({
    platform: 'linux',
    env: { XDG_DATA_HOME: '/var/test/data' },
    homeDir: '/home/test',
    packageRoot: PACKAGE_ROOT
  });
  const linuxFallback = resolveSetupPaths({
    platform: 'linux',
    env: {},
    homeDir: '/home/test',
    packageRoot: PACKAGE_ROOT
  });

  assert.equal(mac.dataDir, resolve('/Users/test/Library/Application Support/Fuli'));
  assert.equal(linux.dataDir, resolve('/var/test/data/fuli'));
  assert.equal(linuxFallback.dataDir, resolve('/home/test/.local/share/fuli'));
});

test('setup paths honor an explicit data directory and resolve runtime entries', () => {
  const paths = resolveSetupPaths({
    dataDir: './custom-data',
    cwd: 'T:/workspace',
    platform: 'win32',
    env: {},
    homeDir: 'C:/Users/Test',
    packageRoot: PACKAGE_ROOT
  });

  assert.equal(paths.dataDir, resolve('T:/workspace/custom-data'));
  assert.equal(paths.serverPath, join(PACKAGE_ROOT, 'src', 'server.js'));
  assert.equal(paths.mcpServerPath, join(PACKAGE_ROOT, 'src', 'mcp-server.js'));
});
