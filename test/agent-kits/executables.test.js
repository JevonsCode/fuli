import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { downloadedExecutablePath, downloadPinnedExecutable } from '../../src/agent-kits/executable-download.js';
import { agentKitExecutables } from '../../src/agent-kits/executables.js';
import { agentKitAsset } from '../../src/agent-kits/pins.js';

const LAUNCHER = 'agent-session-launcher';

function directory(t) {
  const root = mkdtempSync(join(tmpdir(), 'fuli-agent-kit-exe-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function file(path, text = 'synthetic executable') {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

// A bundle as the Windows portable build writes it (native-bundle.json).
function bundle(root, agentKits) {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'native-bundle.json'), JSON.stringify({ version: 1, platform: 'win32', arch: 'x64',
    providerPackaging: 'embedded', neo4jHome: 'runtime/neo4j', javaHome: 'runtime/jre21',
    providerPython: 'runtime/python/python.exe', providerSource: 'runtime/python/Lib/site-packages', dataDir: 'data',
    ...(agentKits ? { agentKits } : {}) }));
  return root;
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

test('the developer override comes first, then the bundle, then a verified download', async (t) => {
  const root = directory(t);
  const nativeRuntimeDir = join(root, 'data', 'native-runtime');
  const bundleRoot = bundle(join(root, 'bundle'), { [LAUNCHER]: 'runtime/agent-kits/agent-session-launcher.exe' });
  file(join(bundleRoot, 'runtime', 'agent-kits', 'agent-session-launcher.exe'));
  const override = file(join(root, 'dev', 'launcher.exe'));
  const resolve = (options) => agentKitExecutables({ nativeRuntimeDir, platform: 'win32', arch: 'x64', ...options }).resolve(LAUNCHER);

  assert.deepEqual(await resolve({ bundleRoot, env: { FULI_AGENT_SESSION_LAUNCHER: override } }),
    { status: 'available', path: override, source: 'override' });
  assert.deepEqual(await resolve({ bundleRoot, env: {} }), { status: 'available',
    path: join(bundleRoot, 'runtime', 'agent-kits', 'agent-session-launcher.exe'), source: 'bundle' });
  assert.match((await resolve({ bundleRoot, env: { FULI_AGENT_SESSION_LAUNCHER: 'relative.exe' } })).reason,
    /FULI_AGENT_SESSION_LAUNCHER does not name an executable file/);
  // A bundle built before the components were bundled, and an npm installation.
  assert.deepEqual(await resolve({ bundleRoot: bundle(join(root, 'old-bundle')), env: {} }),
    { status: 'unavailable', reason: 'agent-session-launcher 0.4.0 has not been downloaded yet.' });
  assert.equal((await resolve({ env: {} })).status, 'unavailable');
  assert.equal((await agentKitExecutables({ nativeRuntimeDir, env: {}, platform: 'win32', arch: 'arm64' }).resolve(LAUNCHER)).reason,
    'agent-session-launcher is not published for win32 arm64.');

  // A downloaded copy is used only while it still matches its pin.
  const downloaded = file(downloadedExecutablePath(nativeRuntimeDir, agentKitAsset(LAUNCHER, 'win32', 'x64')), 'tampered');
  assert.deepEqual(await resolve({ env: {} }),
    { status: 'unavailable', reason: 'The downloaded agent-session-launcher does not match its pinned checksum.' });
  assert.equal(existsSync(downloaded), true, 'a mismatching copy is preserved for inspection, never replaced silently');
});

test('a bundle may list only known components, inside the bundle', async (t) => {
  const { readWindowsNativeBundle } = await import('../../src/native-runtime/windows-assets.js');
  const root = directory(t);
  const kits = { 'agent-session-launcher': 'runtime/agent-kits/agent-session-launcher.exe',
    'agent-installer': 'runtime/agent-kits/agent-installer.exe' };
  assert.deepEqual(readWindowsNativeBundle(bundle(join(root, 'a'), kits)).agentKits, {
    'agent-session-launcher': join(root, 'a', 'runtime', 'agent-kits', 'agent-session-launcher.exe'),
    'agent-installer': join(root, 'a', 'runtime', 'agent-kits', 'agent-installer.exe') });
  assert.equal(readWindowsNativeBundle(bundle(join(root, 'b'))).agentKits, undefined);
  assert.throws(() => readWindowsNativeBundle(bundle(join(root, 'c'), { 'other-tool': 'runtime/x.exe' })), /unknown agent kit/);
  assert.throws(() => readWindowsNativeBundle(bundle(join(root, 'd'), { 'agent-installer': '../outside.exe' })),
    /stay inside the bundle: agentKits.agent-installer/);
  assert.throws(() => readWindowsNativeBundle(bundle(join(root, 'e'), { 'agent-installer': join(root, 'abs.exe') })),
    /must be relative: agentKits.agent-installer/);
});

test('a download is published only after its checksum matches the pin', async (t) => {
  const root = directory(t);
  const bytes = 'synthetic release asset';
  const asset = { component: LAUNCHER, version: '9.9.9', name: 'agent-session-launcher-test', url: 'https://example.invalid/asset',
    sha256: sha256(bytes) };
  const urls = [];
  const path = await downloadPinnedExecutable(root, asset, { download: async (url, destination) => {
    urls.push(url); file(destination, bytes);
  } });
  assert.equal(path, downloadedExecutablePath(root, asset));
  assert.deepEqual(urls, ['https://example.invalid/asset']);
  assert.deepEqual(readdirSync(dirname(path)), ['agent-session-launcher-test'], 'no staging file or lock is left');

  const bad = { ...asset, version: '9.9.8' };
  await assert.rejects(downloadPinnedExecutable(root, bad, { download: async (_url, destination) => file(destination, 'tampered') }),
    /failed checksum verification/);
  assert.deepEqual(readdirSync(dirname(downloadedExecutablePath(root, bad))), [], 'a refused download leaves nothing behind');
});

test('ensure downloads on first need, refuses a bad checksum and reports an offline machine', async (t) => {
  const root = directory(t);
  const tampered = agentKitExecutables({ nativeRuntimeDir: join(root, 'a'), env: {}, platform: 'linux', arch: 'x64',
    download: (nativeRuntimeDir, asset) => downloadPinnedExecutable(nativeRuntimeDir, asset,
      { download: async (_url, destination) => file(destination, 'not the pinned bytes') }) });
  const refused = await tampered.ensure(LAUNCHER);
  assert.equal(refused.status, 'unavailable');
  assert.match(refused.reason, /could not be downloaded: The downloaded agent-session-launcher-linux-x64 failed checksum verification/);
  assert.equal((await tampered.resolve(LAUNCHER)).status, 'unavailable', 'nothing was published');

  let attempts = 0;
  const offline = agentKitExecutables({ nativeRuntimeDir: join(root, 'b'), env: {}, platform: 'linux', arch: 'x64',
    download: async () => { attempts += 1; throw new Error('fetch failed'); } });
  const [first, second] = await Promise.all([offline.ensure(LAUNCHER), offline.ensure(LAUNCHER)]);
  assert.deepEqual(first, { status: 'unavailable', reason: 'agent-session-launcher could not be downloaded: fetch failed' });
  assert.deepEqual(second, first);
  assert.equal(attempts, 1, 'concurrent needs share one download');

  // Importing or resolving never downloads.
  let downloads = 0;
  await agentKitExecutables({ nativeRuntimeDir: join(root, 'c'), env: {}, download: async () => { downloads += 1; } })
    .resolve(LAUNCHER);
  assert.equal(downloads, 0);
});
