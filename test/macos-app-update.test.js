import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { macosDesktopClient, updateMacosAppFromRelease } from '../src/desktop/macos-app-update.js';

// The macOS app's one-click update, with every system tool faked: synthetic
// app bundles in a temporary "Applications" folder, no image is mounted, no
// FULI runs, and nothing outside the temporary folder is touched.

function applications(t) {
  const root = mkdtempSync(join(tmpdir(), 'fuli-app-update-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function bundle(app, version) {
  const root = join(app, 'Contents', 'Resources', 'fuli');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version }));
  return root;
}

const versionOf = app => JSON.parse(readFileSync(join(app, 'Contents', 'Resources', 'fuli', 'package.json'), 'utf8')).version;

// hdiutil/ditto/xattr: ditto "copies" FULI.app of the image as a bundle of imageVersion.
function tools(imageVersion, calls) {
  return async (command, args) => {
    calls.push([command.split('/').pop(), args[0]]);
    if (command.endsWith('ditto')) bundle(args[1], imageVersion);
    return '';
  };
}

function setup(t, { imageVersion = '0.24.0', starts = [true] } = {}) {
  const root = applications(t);
  const app = join(root, 'Applications', 'FULI.app');
  const packageRoot = bundle(app, '0.23.0');
  const calls = [];
  const controller = async (root, action) => {
    calls.push(['controller', action, versionOf(dirname(dirname(dirname(root))))]);
    return action === 'start' ? (starts.shift() ?? true) ? { ok: true, status: 'running' } : { ok: false, error: 'boom' }
      : { ok: true, status: 'stopped' };
  };
  const client = { close: async () => { calls.push(['client', 'close']); return true; }, open: () => calls.push(['client', 'open']) };
  const cli = async (root, args) => { calls.push(['cli', args.slice(0, 3).join(' '), versionOf(dirname(dirname(dirname(root))))]); return { code: 0 }; };
  const deps = { cli, download: async ({ name, directory }) => { calls.push(['download', name]); return join(directory, name); },
    runCommand: tools(imageVersion, calls), controller, client, readBundle: () => ({ arch: 'arm64' }), tempRoot: root, env: {} };
  return { app, packageRoot, calls, deps };
}

test('the app downloads its image, swaps FULI.app for the new one, starts it and opens its window again', async t => {
  const { app, packageRoot, calls, deps } = setup(t);
  const steps = [];
  const result = await updateMacosAppFromRelease({ packageRoot, dataDir: '/data', version: '0.24.0',
    progress: step => steps.push(step) }, deps);
  assert.deepEqual(result, { status: 'updated', version: '0.24.0', clients: 'reconnected' });
  assert.equal(versionOf(app), '0.24.0');
  assert.deepEqual(steps, ['preparing', 'restarting']);
  assert.equal(calls.filter(([kind]) => kind === 'ditto').length, 1);
  assert.deepEqual(calls.filter(([kind]) => !['hdiutil', 'xattr', 'ditto'].includes(kind)), [
    ['download', 'fuli-macos-arm64-0.24.0.dmg'], ['client', 'close'], ['controller', 'stop', '0.23.0'], ['controller', 'start', '0.24.0'],
    ['cli', 'setup --yes --connected-only', '0.24.0'], ['client', 'open']
  ]);
  assert.equal(existsSync(join(dirname(app), '.FULI.app.previous')), false, 'the previous bundle is removed once the new one runs');
  assert.equal(existsSync(join(dirname(app), '.FULI.app.update')), false);
});

test('a new version that does not start is swapped back and the previous one started again', async t => {
  const { app, packageRoot, calls, deps } = setup(t, { starts: [false, true] });
  await assert.rejects(updateMacosAppFromRelease({ packageRoot, version: '0.24.0' }, deps),
    error => error.code === 'start_failed' && /previous version was restored/.test(error.message));
  assert.equal(versionOf(app), '0.23.0');
  assert.deepEqual(calls.filter(([kind]) => kind === 'controller' || kind === 'client').slice(1), [
    ['controller', 'stop', '0.23.0'], ['controller', 'start', '0.24.0'], ['controller', 'stop', '0.24.0'],
    ['controller', 'start', '0.23.0'], ['client', 'open']
  ]);
});

test('an image of another version changes nothing and stops nothing', async t => {
  const { app, packageRoot, calls, deps } = setup(t, { imageVersion: '0.23.9' });
  await assert.rejects(updateMacosAppFromRelease({ packageRoot, version: '0.24.0' }, deps),
    error => error.code === 'download_failed' && /contains v0\.23\.9/.test(error.message));
  assert.equal(versionOf(app), '0.23.0');
  assert.equal(calls.some(([kind]) => ['controller', 'client', 'cli'].includes(kind)), false);
  assert.equal(existsSync(join(dirname(app), '.FULI.app.update')), false);
});

test('an app that is not installed in a folder (the disk image itself) is not replaced', async t => {
  const root = applications(t);
  const packageRoot = bundle(join(root, 'FULI'), '0.23.0');
  await assert.rejects(updateMacosAppFromRelease({ packageRoot, version: '0.24.0' }, { readBundle: () => ({ arch: 'arm64' }) }),
    error => error.code === 'not_installed');
});

test('the desktop client of exactly this app is ended, then killed if it stays', async () => {
  const signals = [];
  const living = new Set([7]);
  const closed = await macosDesktopClient.close('/Applications/FULI.app', {
    list: async () => [{ pid: 7, args: '/Applications/FULI.app/Contents/MacOS/FULI' },
      { pid: 8, args: '/Applications/FULI.app.bak/Contents/MacOS/FULI' }],
    signal: (pid, name) => { signals.push([pid, name]); if (name === 0 && !living.has(pid)) throw new Error('gone'); if (name === 'SIGKILL') living.delete(pid); },
    wait: async () => {},
    now: (() => { let time = 0; return () => (time += 1000); })()
  });
  assert.equal(closed, true);
  assert.deepEqual(signals[0], [7, 'SIGTERM']);
  assert.ok(signals.some(([pid, name]) => pid === 7 && name === 'SIGKILL'));
  assert.equal(signals.some(([pid]) => pid === 8), false);
});
