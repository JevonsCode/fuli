import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

import {
  NATIVE_NEO4J_VERSION,
  ensureNativeRuntime,
  nativeNeo4jConfiguration,
  nativeProviderInstallArguments
} from '../src/native-runtime/runtime.js';
import { resolveSetupPaths } from '../src/setup/paths.js';
import { DEFAULT_RUNTIME_SETTINGS } from '../src/system/runtime-settings.js';
import { FULI_VERSION } from '../src/package-metadata.js';

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
    join(dirname(paths.graphComposePath), 'graph-provider'),
    join(dirname(paths.graphComposePath), 'graph-provider')
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

test('Windows native setup resolves explicit existing assets and an external Provider without installing', async t => {
  const root = await mkdtemp(join(tmpdir(), 'fuli-native-assets-'));
  assert.equal(dirname(resolve(root)), resolve(tmpdir()));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = resolveSetupPaths({ dataDir: join(root, 'data'), packageRoot: process.cwd() });
  const bundle = { javaHome: join(root, 'jre21'), neo4jHome: join(root, 'neo4j'),
    providerPython: join(root, 'external-python', 'python.exe') };
  const files = [join(bundle.javaHome, 'bin', 'java.exe'), join(bundle.javaHome, 'lib', 'modules'),
    join(bundle.neo4jHome, 'conf', 'neo4j.conf'), join(bundle.neo4jHome, 'lib', 'neo4j-kernel-5.26.0.jar'),
    join(bundle.neo4jHome, 'lib', 'neo4j-5.26.0.jar'), bundle.providerPython];
  for (const file of files) { await mkdir(dirname(file), { recursive: true }); await writeFile(file, 'fixture'); }
  await writeFile(join(bundle.javaHome, 'release'), 'JAVA_VERSION="21.0.12.1"\n');
  const installed = [];
  const deps = { platform: 'win32', providerSourceFingerprint: async () => 'a'.repeat(64),
    installNeo4j: async () => installed.push('database'), installProvider: async () => installed.push('provider') };
  const first = await ensureNativeRuntime({ paths, bundle }, deps);
  assert.equal(first.neo4jVersion, '5.26.0');
  assert.equal(first.javaVersion, '21.0.12.1');
  assert.equal(first.providerPackaging, 'external');
  assert.equal(first.platform, 'win32');
  assert.deepEqual(await ensureNativeRuntime({ paths }, deps), first);
  assert.deepEqual(installed, []);
  assert.deepEqual(await ensureNativeRuntime({ paths: { ...paths, nativePersonalDir: join(root, '中文') }, bundle }, deps), first);
  await writeFile(join(bundle.javaHome, 'release'), 'JAVA_VERSION="17.0.0"\n');
  await assert.rejects(ensureNativeRuntime({ paths, bundle }, deps), /Java 21/);
});

test('Windows portable bundle discovery rebinds cached assets after a stopped directory move', async t => {
  // The bundle reader canonicalizes its root, so derive expectations from the same real path
  // (macOS tmpdir() is /var/..., which resolves to /private/var/...).
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'fuli-portable-discovery-')));
  assert.equal(dirname(root), realpathSync(tmpdir()));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, '中文 portable');
  const moved = join(root, '已搬移 portable');
  const manifest = { version: 1, platform: 'win32', arch: 'x64', providerPackaging: 'embedded',
    javaHome: 'runtime/jre21', neo4jHome: 'runtime/neo4j', providerPython: 'runtime/python/python.exe',
    providerSource: 'runtime/python/Lib/site-packages', dataDir: 'data' };
  for (const name of ['runtime/jre21/bin/java.exe', 'runtime/jre21/lib/modules',
    'runtime/neo4j/conf/neo4j.conf', 'runtime/neo4j/lib/neo4j-kernel-5.26.0.jar',
    'runtime/neo4j/lib/neo4j-5.26.0.jar', 'runtime/python/python.exe', 'runtime/python/python312.zip',
    'runtime/python/Lib/site-packages/fuli_graph/app.py']) {
    const path = join(source, name);
    await mkdir(dirname(path), { recursive: true }); await writeFile(path, 'fixture');
  }
  await writeFile(join(source, 'runtime/jre21/release'), 'JAVA_VERSION="21.0.12.1"\n');
  await writeFile(join(source, 'runtime/python/python312._pth'), 'python312.zip\n.\nLib/site-packages\nimport site\n');
  await writeFile(join(source, 'native-bundle.json'), JSON.stringify(manifest));
  const pathsFor = (packageRoot, extra = {}) => resolveSetupPaths({ packageRoot, platform: 'win32', env: {}, ...extra });
  const paths = pathsFor(source);
  assert.equal(paths.dataDir, join(source, 'data'));
  assert.equal(pathsFor(source, { env: { FULI_DATA_DIR: join(root, 'external') } }).dataDir, join(root, 'external'));
  assert.equal(pathsFor(source, { dataDir: join(root, 'explicit'), env: { FULI_DATA_DIR: join(root, 'external') } }).dataDir,
    join(root, 'explicit'));
  const deps = { platform: 'win32', providerSourceFingerprint: async () => 'a'.repeat(64),
    installProvider: async () => assert.fail('A portable Provider must not install at runtime') };
  const first = await ensureNativeRuntime({ paths }, deps);
  assert.equal(first.providerPackaging, 'embedded');
  await rename(source, moved);
  const nextPaths = pathsFor(moved);
  const next = await ensureNativeRuntime({ paths: nextPaths }, deps);
  assert.equal(next.providerPython, join(moved, manifest.providerPython));
  assert.equal(next.providerSource, join(moved, manifest.providerSource));
  assert.equal(next.providerFingerprint, first.providerFingerprint);
  await writeFile(join(moved, 'native-bundle.json'), JSON.stringify({ ...manifest, javaHome: '../outside' }));
  assert.throws(() => pathsFor(moved), /inside the bundle/);
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

for (const providerVersion of ['99.0.0+native.2', `${FULI_VERSION}+native.3`]) {
test(`native setup refuses to overwrite newer Provider ${providerVersion} before any mutation`, async () => {
  const paths = resolveSetupPaths({ dataDir: '/synthetic', packageRoot: '/package' });
  const mutations = [];
  await assert.rejects(ensureNativeRuntime({ paths, env: {}, runtimeSettings: DEFAULT_RUNTIME_SETTINGS }, {
    platform: 'darwin', resolveJavaHome: async () => '/jdk-21', resolveUvCommand: async () => 'uv',
    providerSourceFingerprint: async () => 'a'.repeat(64), pathExists: () => true,
    readManifest: () => ({ providerVersion }),
    installProvider: async () => mutations.push('install'),
    installNeo4j: async () => mutations.push('database'),
    writeManifest: () => mutations.push('manifest')
  }), /newer.*Provider|downgrade/i);
  assert.deepEqual(mutations, []);
});
}
