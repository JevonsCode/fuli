import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';

import { runtimeEntitlements } from '../scripts/sign-macos-app.js';
import { runUpdateCommand } from '../src/cli/update-command.js';
import { loadMacosAppContext } from '../src/desktop/macos-controller.js';
import { readMacosNativeBundle } from '../src/native-runtime/macos-assets.js';
import { ensureNativeRuntime } from '../src/native-runtime/runtime.js';
import { resolveSetupPaths } from '../src/setup/paths.js';
import { DEFAULT_RUNTIME_SETTINGS } from '../src/system/runtime-settings.js';

// Synthetic package folders under the system temp directory only.
const MANIFEST = { version: 1, platform: 'darwin', arch: 'arm64', providerPackaging: 'embedded',
  javaHome: 'runtime/jre21', neo4jArchive: 'runtime/neo4j-community-5.26.28-unix.tar.gz',
  providerPython: 'runtime/python/bin/python3', providerSource: 'runtime/python/lib/python3.12/site-packages' };

async function appPackage(t, manifest = MANIFEST) {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'fuli-macos-app-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageRoot = join(root, 'FULI.app', 'Contents', 'Resources', 'fuli');
  await mkdir(packageRoot, { recursive: true });
  if (manifest) await writeFile(join(packageRoot, 'native-bundle.json'), JSON.stringify(manifest));
  return { root, packageRoot };
}

test('the macOS app manifest resolves its runtime inside the package and refuses anything else', async t => {
  const { packageRoot } = await appPackage(t);
  const bundle = readMacosNativeBundle(packageRoot);
  assert.equal(bundle.javaHome, join(packageRoot, 'runtime', 'jre21'));
  assert.equal(bundle.neo4jArchive, join(packageRoot, 'runtime', 'neo4j-community-5.26.28-unix.tar.gz'));
  assert.equal(bundle.providerPython, join(packageRoot, 'runtime', 'python', 'bin', 'python3'));
  assert.equal(bundle.arch, 'arm64');
  for (const [manifest, error] of [[{ ...MANIFEST, platform: 'win32' }, /not supported/],
    [{ ...MANIFEST, javaHome: '/Library/Java' }, /relative/], [{ ...MANIFEST, providerPython: '../python3' }, /inside/]]) {
    await writeFile(join(packageRoot, 'native-bundle.json'), JSON.stringify(manifest));
    assert.throws(() => readMacosNativeBundle(packageRoot), error);
  }
  assert.equal(readMacosNativeBundle(dirname(packageRoot)), null, 'an npm package has no bundle');
});

test('native setup in the macOS app uses its Java, Neo4j archive and Provider, never uv or a download', async t => {
  const { root, packageRoot } = await appPackage(t);
  const paths = resolveSetupPaths({ dataDir: join(root, 'data'), packageRoot, platform: 'darwin' });
  const bundle = readMacosNativeBundle(packageRoot);
  const calls = [];
  let neo4jInstalled = false;
  const manifest = await ensureNativeRuntime({ paths, env: { JAVA_HOME: '/elsewhere' },
    runtimeSettings: DEFAULT_RUNTIME_SETTINGS, personalOnly: true }, {
    platform: 'darwin',
    withOperation: (_paths, env, action) => action(env),
    resolveJavaHome: async env => { calls.push(['java', env.FULI_NATIVE_JAVA_HOME]); return env.FULI_NATIVE_JAVA_HOME; },
    resolveUvCommand: async () => assert.fail('the app needs no uv'),
    installProvider: async () => assert.fail('the bundled Provider is installed already'),
    providerSourceFingerprint: async source => { calls.push(['fingerprint', source]); return 'a'.repeat(64); },
    pathExists: path => !path.startsWith(paths.nativeNeo4jHome) || neo4jInstalled,
    readManifest: () => null,
    installNeo4j: async input => { neo4jInstalled = true; calls.push(['neo4j', input.bundledArchive]); },
    writeManifest: () => calls.push(['manifest'])
  });
  assert.deepEqual(calls, [['java', bundle.javaHome], ['fingerprint', bundle.providerSource],
    ['neo4j', bundle.neo4jArchive], ['manifest']]);
  assert.equal(manifest.javaHome, bundle.javaHome);
  assert.equal(manifest.providerPython, bundle.providerPython);
  assert.equal(manifest.uvCommand, null);
  assert.equal(manifest.neo4jHome, paths.nativeNeo4jHome, 'Neo4j is unpacked into the data directory as for npm');
});

test('the app controller uses the bundled Node and FULI\'s macOS data directory', async t => {
  const { root, packageRoot } = await appPackage(t);
  const dataDir = join(root, 'data');
  const context = loadMacosAppContext({ packageRoot, env: { FULI_DATA_DIR: dataDir } });
  assert.deepEqual(context, { packageRoot, dataDir,
    nodePath: join(packageRoot, 'runtime', 'node', 'bin', 'node'), cliPath: join(packageRoot, 'src', 'cli.js') });
  const npm = await appPackage(t, null);
  assert.throws(() => loadMacosAppContext({ packageRoot: npm.packageRoot }), /bundled runtime/);
});

test('the app is updated by replacing it, never through npm', async t => {
  const { packageRoot } = await appPackage(t);
  await assert.rejects(runUpdateCommand(['--yes'], { platform: 'darwin', packageRoot,
    resolveLatestVersion: () => assert.fail('nothing is checked'),
    stopRuntime: async () => assert.fail('nothing is stopped'), write: () => {} }), /drag FULI\.app to Applications/);
});

test('a Developer ID build gives each runtime executable only its own entitlements', async () => {
  const granted = async path => [...(await readFile(path, 'utf8')).matchAll(/<key>([^<]+)<\/key>/g)].map(match => match[1]);
  const node = runtimeEntitlements('runtime/node/bin/node');
  const java = runtimeEntitlements('runtime/jre21/bin/java');
  const python = runtimeEntitlements('runtime/python/bin/python3.12');
  assert.deepEqual([node, java, python].map(path => basename(path)),
    ['node.entitlements', 'java.entitlements', 'python.entitlements']);
  assert.equal(runtimeEntitlements('runtime/jre21/lib/jspawnhelper'), java);
  for (const library of ['runtime/jre21/lib/server/libjvm.dylib',
    'runtime/python/lib/python3.12/lib-dynload/_ssl.cpython-312-darwin.so', 'node_modules/x/bin/node']) {
    assert.equal(runtimeEntitlements(library), null, library);
  }
  assert.deepEqual(await granted(node), ['com.apple.security.cs.allow-jit', 'com.apple.security.cs.allow-unsigned-executable-memory']);
  assert.ok((await granted(java)).includes('com.apple.security.cs.disable-library-validation'));
  assert.deepEqual(await granted(python), ['com.apple.security.cs.allow-unsigned-executable-memory']);
});
