import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { downloadedExecutablePath, downloadPinnedExecutable } from '../../src/agent-kits/executable-download.js';
import { agentKitExecutables } from '../../src/agent-kits/executables.js';
import { agentKitAsset } from '../../src/agent-kits/pins.js';

const LAUNCHER = 'agent-session-launcher';

function directory(t) {
  // Real path: macOS's temporary directory is reached through a symlink.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'fuli-agent-kit-exe-')));
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
    { status: 'unavailable', reason: 'agent-session-launcher 0.5.1 has not been downloaded yet.' });
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

// Two FULI processes needing the same component at once (two clients connected
// on first use, or parallel test processes sharing one cache): the second waits
// for the first and uses its copy instead of failing.
test('a second download of the same asset waits for the first and uses its copy', async (t) => {
  const root = directory(t);
  const bytes = 'synthetic release asset';
  const asset = { component: LAUNCHER, version: '9.9.7', name: 'agent-session-launcher-test', url: 'https://example.invalid/asset',
    sha256: sha256(bytes) };
  let downloads = 0;
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const first = downloadPinnedExecutable(root, asset, { download: async (_url, destination) => {
    downloads += 1; started.resolve(); await release.promise; file(destination, bytes);
  } });
  await started.promise;
  // The second finds the lock held and waits; its first wait lets the first one finish.
  const second = downloadPinnedExecutable(root, asset, {
    download: async () => { downloads += 1; throw new Error('a second download'); },
    wait: async () => { release.resolve(); await new Promise((resolve) => setImmediate(resolve)); } });
  assert.deepEqual(await Promise.all([first, second]), [downloadedExecutablePath(root, asset), downloadedExecutablePath(root, asset)]);
  assert.equal(downloads, 1);

  // A first download that ends without a copy leaves the second to download itself.
  const other = { ...asset, version: '9.9.6' };
  const failing = Promise.withResolvers();
  const failed = Promise.withResolvers();
  const broken = downloadPinnedExecutable(root, other, { download: async () => {
    failing.resolve(); await failed.promise; throw new Error('fetch failed'); } });
  await failing.promise;
  const retried = downloadPinnedExecutable(root, other, { download: async (_url, destination) => file(destination, bytes),
    wait: async () => { failed.resolve(); await broken.catch(() => {}); } });
  await assert.rejects(broken, /fetch failed/);
  assert.equal(await retried, downloadedExecutablePath(root, other));

  // A lock older than any download may take is a crashed process's, and is taken over.
  const crashed = { ...asset, version: '9.9.5' };
  mkdirSync(`${downloadedExecutablePath(root, crashed)}.lock`, { recursive: true });
  assert.equal(await downloadPinnedExecutable(root, crashed, { now: () => Date.now() + 11 * 60_000,
    download: async (_url, destination) => file(destination, bytes),
    wait: async () => { throw new Error('a stale lock is not waited for'); } }), downloadedExecutablePath(root, crashed));
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

// ---- The download lock: holders, take-overs and the published copy ----

const DEAD_PID = 4_000_000;
// This process as the lock records it, and how a test's OS answers about a PID:
// `startTimes` maps a PID to its start time now (a function may pause the answer).
const identify = async () => ({ pid: process.pid, command: 'node fuli', startedAt: 'started-now' });
function osAnswering(startTimes) {
  return { state: () => 'running', matches: async () => true,
    startTime: async (pid) => (typeof startTimes[pid] === 'function' ? startTimes[pid]() : startTimes[pid] ?? 'started-now') };
}
function syntheticAsset(version, bytes = 'synthetic release asset') {
  return { component: LAUNCHER, version, name: 'agent-session-launcher-test', url: 'https://example.invalid/asset', sha256: sha256(bytes) };
}
function lockOf(root, asset, holder, { ageMs = 0 } = {}) {
  const lock = `${downloadedExecutablePath(root, asset)}.lock`;
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, 'holder.json'), JSON.stringify(holder));
  if (ageMs) utimesSync(lock, new Date(Date.now() - ageMs), new Date(Date.now() - ageMs));
  return lock;
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('two waiters that both find an abandoned lock download once', async (t) => {
  const root = directory(t);
  const bytes = 'synthetic release asset';
  const asset = syntheticAsset('9.8.1', bytes);
  // A crashed FULI's lock: its PID now belongs to another program (another start time).
  lockOf(root, asset, { pid: DEAD_PID, command: 'node fuli', startedAt: 'started-earlier', token: 'crashed' });
  let downloads = 0;
  const judging = Promise.withResolvers();
  const judged = Promise.withResolvers();
  const started = Promise.withResolvers();
  const finish = Promise.withResolvers();
  // B reads the crashed lock and is still judging it when A takes it over and starts downloading.
  const second = downloadPinnedExecutable(root, asset, { identify,
    identity: osAnswering({ [DEAD_PID]: () => { judging.resolve(); return judged.promise; } }),
    download: async (_url, destination) => { downloads += 1; file(destination, bytes); },
    wait: async () => { finish.resolve(); await tick(); } });
  await judging.promise;
  const first = downloadPinnedExecutable(root, asset, { identify, identity: osAnswering({ [DEAD_PID]: 'started-later' }),
    download: async (_url, destination) => { downloads += 1; started.resolve(); await finish.promise; file(destination, bytes); },
    wait: async () => { throw new Error('the crashed lock is taken over at once'); } });
  await started.promise;
  // B's judgment ends: the lock it judged is gone, so it leaves A's alone and waits for A.
  judged.resolve('started-later');
  assert.deepEqual(await Promise.all([first, second]), [downloadedExecutablePath(root, asset), downloadedExecutablePath(root, asset)]);
  assert.equal(downloads, 1);
  assert.equal(sha256(readFileSync(downloadedExecutablePath(root, asset), 'utf8')), asset.sha256);
  assert.deepEqual(readdirSync(dirname(downloadedExecutablePath(root, asset))), [asset.name], 'no lock, staging or take-over is left');
});

test('the lock of a process that has ended is taken over at once', async (t) => {
  const root = directory(t);
  const asset = syntheticAsset('9.8.2');
  lockOf(root, asset, { pid: DEAD_PID, command: 'node fuli', startedAt: 'started-earlier', token: 'crashed' });
  let downloads = 0;
  assert.equal(await downloadPinnedExecutable(root, asset, { identify,
    identity: { ...osAnswering({}), state: (pid) => (pid === DEAD_PID ? 'gone' : 'running') },
    download: async (_url, destination) => { downloads += 1; file(destination, 'synthetic release asset'); },
    wait: async () => { throw new Error('an ended holder is not waited for'); } }), downloadedExecutablePath(root, asset));
  assert.equal(downloads, 1);
});

test('a holder whose lock was taken over leaves the new holder\'s lock in place', async (t) => {
  const root = directory(t);
  const bytes = 'synthetic release asset';
  const asset = syntheticAsset('9.8.3', bytes);
  const lock = `${downloadedExecutablePath(root, asset)}.lock`;
  const staged = [];
  const aStarted = Promise.withResolvers();
  const aFinish = Promise.withResolvers();
  const bStarted = Promise.withResolvers();
  const bFinish = Promise.withResolvers();
  // A hangs past any download's time; B, judging by its clock, takes the lock over.
  const first = downloadPinnedExecutable(root, asset, { identify, identity: osAnswering({}),
    download: async (_url, destination) => { staged.push(destination); aStarted.resolve(); await aFinish.promise; file(destination, bytes); } });
  await aStarted.promise;
  const second = downloadPinnedExecutable(root, asset, { identify, identity: osAnswering({}), now: () => Date.now() + 12 * 60_000,
    download: async (_url, destination) => { staged.push(destination); bStarted.resolve(); await bFinish.promise; file(destination, bytes); } });
  await bStarted.promise;
  const bToken = JSON.parse(readFileSync(join(lock, 'holder.json'), 'utf8')).token;
  aFinish.resolve();
  assert.equal(await first, downloadedExecutablePath(root, asset));
  assert.equal(JSON.parse(readFileSync(join(lock, 'holder.json'), 'utf8')).token, bToken, 'A released only its own lock');
  assert.notEqual(staged[0], staged[1], 'each holder writes its own staging file');
  bFinish.resolve();
  assert.equal(await second, downloadedExecutablePath(root, asset));
  assert.equal(existsSync(lock), false);
  assert.equal(sha256(readFileSync(downloadedExecutablePath(root, asset), 'utf8')), asset.sha256);
});

test('ensure downloads again over a published copy that fails its pin, keeping that copy aside', async (t) => {
  const root = directory(t);
  const asset = agentKitAsset(LAUNCHER, 'linux', 'x64');
  const path = file(downloadedExecutablePath(root, asset), 'damaged');
  let downloads = 0;
  const executables = agentKitExecutables({ nativeRuntimeDir: root, env: {}, platform: 'linux', arch: 'x64',
    download: (nativeRuntimeDir, pinned, options) => downloadPinnedExecutable(nativeRuntimeDir, { ...pinned, sha256: sha256('repaired') },
      { ...options, download: async (_url, destination) => { downloads += 1; file(destination, 'repaired'); } }) });
  assert.deepEqual(await executables.ensure(LAUNCHER), { status: 'available', path, source: 'download' });
  assert.equal(downloads, 1);
  assert.equal(readFileSync(path, 'utf8'), 'repaired');
  const aside = readdirSync(dirname(path)).filter((name) => name.startsWith(`${asset.name}.unverified-`));
  assert.equal(aside.length, 1);
  assert.equal(readFileSync(join(dirname(path), aside[0]), 'utf8'), 'damaged', 'the damaged copy is kept, not deleted');
});

test('waiting for another FULI\'s download is said once, can be cancelled, and the console does not wait', async (t) => {
  const root = directory(t);
  const asset = agentKitAsset(LAUNCHER, 'linux', 'x64');
  // A live FULI downloading it now.
  const lock = lockOf(root, asset, { pid: DEAD_PID, command: 'node fuli', startedAt: 'started-now', token: 'other' });
  let downloads = 0;
  const waiting = Promise.withResolvers();
  const told = [];
  const pinned = (options) => (nativeRuntimeDir, wanted, own) => downloadPinnedExecutable(nativeRuntimeDir, wanted, { ...own, identify,
    identity: osAnswering({}), download: async () => { downloads += 1; }, ...options });
  const executables = agentKitExecutables({ nativeRuntimeDir: root, env: {}, platform: 'linux', arch: 'x64',
    onWait: (status) => { told.push(status); waiting.resolve(); },
    download: pinned({ wait: (signal) => new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 5);
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
    }) }) });
  const controller = new AbortController();
  const answer = executables.ensure(LAUNCHER, { signal: controller.signal });
  await waiting.promise;
  await new Promise((resolve) => setTimeout(resolve, 30));
  controller.abort();
  assert.deepEqual(await answer, { status: 'unavailable', reason: 'Waiting for agent-session-launcher was cancelled.', cancelled: true });
  assert.equal(told.length, 1, 'the wait is said once, not on every look');
  assert.equal(told[0].component, LAUNCHER);
  assert.match(told[0].message, /另一个 FULI 正在下载客户端组件 agent-session-launcher.*Another FULI is downloading/);
  assert.equal(downloads, 0);
  assert.equal(existsSync(lock), true, 'the other FULI keeps its lock');

  const consoleKits = agentKitExecutables({ nativeRuntimeDir: root, env: {}, platform: 'linux', arch: 'x64', waitForOthers: false,
    download: pinned({ wait: async () => { throw new Error('the console never waits'); } }) });
  const now = await consoleKits.ensure(LAUNCHER);
  assert.equal(now.status, 'unavailable');
  assert.equal(now.downloading, true);
  assert.equal(downloads, 0);
});
