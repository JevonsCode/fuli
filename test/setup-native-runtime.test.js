import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  NATIVE_NEO4J_VERSION,
  ensureNativeRuntime,
  nativeNeo4jConfiguration,
  nativeProviderInstallArguments
} from '../src/native-runtime/runtime.js';
import { resolveSetupPaths } from '../src/setup/paths.js';
import { DEFAULT_RUNTIME_SETTINGS } from '../src/system/runtime-settings.js';

test('native runtime installs pinned Neo4j and the Provider once, then reuses them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fuli-native-runtime-'));
  const paths = resolveSetupPaths({ dataDir: root, packageRoot: '/package' });
  const installed = [];
  const dependencies = {
    platform: 'darwin',
    resolveJavaHome: async () => '/jdk-21',
    resolveUvCommand: async () => '/usr/local/bin/uv',
    providerSourceFingerprint: async () => 'a'.repeat(64),
    async installNeo4j({ home }) {
      installed.push('neo4j');
      await mkdir(join(home, 'bin'), { recursive: true });
      await writeFile(join(home, 'bin', 'neo4j'), '');
      await writeFile(join(home, 'bin', 'neo4j-admin'), '');
    },
    async installProvider({ venvPath }) {
      installed.push('provider');
      await mkdir(join(venvPath, 'bin'), { recursive: true });
      await writeFile(join(venvPath, 'bin', 'python'), '');
    }
  };

  const first = await ensureNativeRuntime({
    paths,
    env: {},
    runtimeSettings: DEFAULT_RUNTIME_SETTINGS,
    personalOnly: true
  }, dependencies);
  const second = await ensureNativeRuntime({
    paths,
    env: {},
    runtimeSettings: DEFAULT_RUNTIME_SETTINGS,
    personalOnly: true
  }, dependencies);

  assert.equal(first.status, 'ready');
  assert.equal(first.mode, 'native');
  assert.equal(first.neo4jVersion, NATIVE_NEO4J_VERSION);
  assert.equal(first.javaHome, '/jdk-21');
  assert.equal(first.providerPython, join(paths.nativeProviderVenvPath, 'bin', 'python'));
  assert.deepEqual(second, first);
  assert.deepEqual(installed, ['neo4j', 'provider']);
});

test('native runtime reinstalls the Provider when packaged source content changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fuli-native-runtime-fingerprint-'));
  const paths = resolveSetupPaths({ dataDir: root, packageRoot: '/package' });
  const installedSources = [];
  let providerFingerprint = 'a'.repeat(64);
  const dependencies = {
    platform: 'darwin',
    resolveJavaHome: async () => '/jdk-21',
    resolveUvCommand: async () => '/usr/local/bin/uv',
    providerSourceFingerprint: async () => providerFingerprint,
    async installNeo4j({ home }) {
      await mkdir(join(home, 'bin'), { recursive: true });
      await writeFile(join(home, 'bin', 'neo4j'), '');
      await writeFile(join(home, 'bin', 'neo4j-admin'), '');
    },
    async installProvider({ venvPath, providerSource }) {
      installedSources.push(providerSource);
      await mkdir(join(venvPath, 'bin'), { recursive: true });
      await writeFile(join(venvPath, 'bin', 'python'), '');
    }
  };

  const first = await ensureNativeRuntime({
    paths,
    env: {},
    runtimeSettings: DEFAULT_RUNTIME_SETTINGS,
    personalOnly: true
  }, dependencies);
  const unchanged = await ensureNativeRuntime({
    paths,
    env: {},
    runtimeSettings: DEFAULT_RUNTIME_SETTINGS,
    personalOnly: true
  }, dependencies);
  providerFingerprint = 'b'.repeat(64);
  const changed = await ensureNativeRuntime({
    paths,
    env: {},
    runtimeSettings: DEFAULT_RUNTIME_SETTINGS,
    personalOnly: true
  }, dependencies);

  assert.equal(first.providerFingerprint, 'a'.repeat(64));
  assert.deepEqual(unchanged, first);
  assert.equal(changed.providerFingerprint, 'b'.repeat(64));
  assert.deepEqual(installedSources, [
    join('/package', 'graph-provider'),
    join('/package', 'graph-provider')
  ]);
});

test('native Neo4j config binds only loopback ports and applies the low-memory profile', () => {
  const config = nativeNeo4jConfiguration({
    instanceDir: '/data/native-runtime/personal',
    httpPort: 8060,
    boltPort: 7687,
    memory: {
      heapInitial: '128m',
      heapMax: '256m',
      pageCache: '64m'
    }
  });

  assert.match(config, /^server\.default_listen_address=127\.0\.0\.1$/m);
  assert.match(config, /^server\.http\.listen_address=127\.0\.0\.1:8060$/m);
  assert.match(config, /^server\.bolt\.listen_address=127\.0\.0\.1:7687$/m);
  assert.match(config, /^server\.memory\.heap\.initial_size=128m$/m);
  assert.match(config, /^server\.memory\.heap\.max_size=256m$/m);
  assert.match(config, /^server\.memory\.pagecache\.size=64m$/m);
  assert.match(config, /^server\.directories\.data=\/data\/native-runtime\/personal\/data$/m);
});

test('native Provider refresh forces only the packaged Provider to reinstall', () => {
  assert.deepEqual(nativeProviderInstallArguments({
    providerPython: '/data/provider-venv/bin/python',
    providerSource: '/package/graph-provider'
  }), [
    'pip', 'install', '--python', '/data/provider-venv/bin/python', '--upgrade',
    '--reinstall-package', 'fuli-graph-provider',
    '/package/graph-provider'
  ]);
});

test('native mode reports its Java 21 prerequisite without suggesting Docker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fuli-native-runtime-'));
  const paths = resolveSetupPaths({ dataDir: root, packageRoot: '/package' });

  await assert.rejects(
    ensureNativeRuntime({ paths, env: {}, runtimeSettings: DEFAULT_RUNTIME_SETTINGS }, {
      platform: 'darwin',
      resolveJavaHome: async () => null,
      resolveUvCommand: async () => '/usr/local/bin/uv'
    }),
    (error) => {
      assert.match(error.message, /Java 21/);
      assert.match(error.message, /brew install openjdk@21/);
      assert.doesNotMatch(error.message, /Docker|Rancher/);
      return true;
    }
  );
});
