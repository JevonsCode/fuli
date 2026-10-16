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
  assert.equal(paths.runtimeSettingsPath, join(paths.dataDir, 'runtime-settings.json'));
  assert.equal(
    paths.externalKnowledgeRegistryPath,
    join(paths.dataDir, 'external-knowledge', 'bindings.json')
  );
  assert.equal(
    paths.externalKnowledgeConflictPolicyPath,
    join(paths.dataDir, 'external-knowledge', 'conflict-policies.json')
  );
  assert.equal(
    paths.externalKnowledgeConnectorDir,
    join(paths.dataDir, 'external-knowledge', 'connectors')
  );
  assert.equal(paths.backupDir, join(paths.dataDir, 'backups', 'agents'));
  assert.equal(paths.graphBackupDir, join(paths.dataDir, 'backups', 'graph'));
  assert.equal(paths.logPath, join(paths.dataDir, 'logs', 'runtime.log'));
  assert.equal(paths.nativeRuntimeDir, join(paths.dataDir, 'native-runtime'));
  assert.equal(paths.nativeRuntimeManifestPath,
    join(paths.dataDir, 'native-runtime', 'manifest.json'));
  assert.equal(paths.nativeProcessStatePath,
    join(paths.dataDir, 'native-runtime', 'processes.json'));
  assert.equal(paths.nativeNeo4jHome,
    join(paths.dataDir, 'native-runtime', 'neo4j-community-5.26.28'));
  assert.equal(paths.nativeProviderVenvPath,
    join(paths.dataDir, 'native-runtime', 'provider-venv'));
  assert.equal(paths.nativePersonalDir,
    join(paths.dataDir, 'native-runtime', 'personal'));
  assert.equal(paths.nativeWorkspaceDir,
    join(paths.dataDir, 'native-runtime', 'workspace'));
  assert.equal(paths.containerGraphConfigProfilePath,
    join(paths.dataDir, 'runtime-configs', 'container.json'));
  assert.equal(paths.nativeGraphConfigProfilePath,
    join(paths.dataDir, 'runtime-configs', 'native.json'));
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
  assert.equal(paths.sessionSkillPath, join(PACKAGE_ROOT, 'skills', 'capturing-session-knowledge'));
  assert.equal(paths.projectSkillPath, join(PACKAGE_ROOT, 'skills', 'grilling-project'));
  assert.equal(paths.reviewSkillPath, join(PACKAGE_ROOT, 'skills', 'flreview'));
  assert.equal(paths.operationSkillPath, join(PACKAGE_ROOT, 'skills', 'operating-fuli'));
});

test('a Windows portable bundle exposes its folder as the removal root; other installs do not', async () => {
  const { mkdtempSync, writeFileSync, realpathSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const root = mkdtempSync(join(tmpdir(), 'fuli portable paths '));
  try {
    writeFileSync(join(root, 'native-bundle.json'), JSON.stringify({ version: 1, platform: 'win32', arch: 'x64',
      providerPackaging: 'embedded', neo4jHome: 'runtime/neo4j', javaHome: 'runtime/jre21',
      providerPython: 'runtime/python/python.exe', providerSource: 'runtime/python/Lib/site-packages', dataDir: 'data' }));
    const portable = resolveSetupPaths({ platform: 'win32', env: {}, homeDir: 'C:/Users/Test', packageRoot: root });
    assert.equal(portable.portableRoot, realpathSync(root));
    assert.equal(portable.dataDir, join(realpathSync(root), 'data'));
    assert.equal(resolveSetupPaths({ platform: 'linux', env: {}, homeDir: '/home/test', packageRoot: root }).portableRoot, null);
  } finally { rmSync(root, { recursive: true, force: true }); }
  assert.equal(resolveSetupPaths({ platform: 'win32', env: { LOCALAPPDATA: 'C:/Local' }, homeDir: 'C:/Users/Test',
    packageRoot: PACKAGE_ROOT }).portableRoot, null);
});
