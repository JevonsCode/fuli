import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { npmUninstallCommand } from '../src/cli/update-installation.js';
import { runTrayAction } from '../src/desktop/desktop-controller.js';
import { DESKTOP_ADOPTION_FILE, otherPackageConsole, reconnectAfterAdoption } from '../src/desktop/npm-adoption.js';
import { findNpmCopies } from '../src/desktop/npm-copies.js';
import { createDoctor } from '../src/system/doctor.js';

// FULI installed with npm first, then the desktop app (same data directory).
// Synthetic temporary folders only: no real data directory, PATH, client
// configuration or port; no CLI or npm is run.

function temporary(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fuli-npm-coexist-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

// An npm global prefix with fuli-context in it, laid out as npm does on this host.
function npmPrefix(root, version = '0.12.4') {
  const prefix = join(root, 'npm prefix');
  const windows = process.platform === 'win32';
  const packageRoot = windows ? join(prefix, 'node_modules', 'fuli-context') : join(prefix, 'lib', 'node_modules', 'fuli-context');
  mkdirSync(join(packageRoot, 'src'), { recursive: true });
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: 'fuli-context', version }));
  writeFileSync(join(packageRoot, 'src', 'cli.js'), '#!/usr/bin/env node\n');
  const bin = windows ? prefix : join(prefix, 'bin');
  mkdirSync(bin, { recursive: true });
  if (windows) writeFileSync(join(bin, 'fl.cmd'), '@"%~dp0\\node_modules\\fuli-context\\src\\cli.js" %*\r\n');
  else {
    chmodSync(join(packageRoot, 'src', 'cli.js'), 0o755);
    symlinkSync(join('..', 'lib', 'node_modules', 'fuli-context', 'src', 'cli.js'), join(bin, 'fl'));
  }
  return { prefix, packageRoot, bin };
}

test('the one remove command names the npm prefix the copy lives in', () => {
  assert.equal(npmUninstallCommand('/opt/homebrew/lib/node_modules/fuli-context', 'darwin'),
    "npm uninstall --global fuli-context --prefix '/opt/homebrew'");
  assert.match(npmUninstallCommand('C:\\Users\\a\\AppData\\Roaming\\npm\\node_modules\\fuli-context', 'win32'),
    /^npm uninstall --global fuli-context --prefix .*AppData\\Roaming\\npm/);
  assert.equal(npmUninstallCommand('/Applications/FULI.app/Contents/Resources/fuli', 'darwin'), null);
  assert.equal(npmUninstallCommand('/work/fuli', 'linux'), null);
});

test('an npm copy on PATH is found with its version and remove command; the app copy is not', t => {
  const root = temporary(t);
  const npm = npmPrefix(root);
  const home = join(root, 'home');
  mkdirSync(home);
  const env = { PATH: npm.bin, APPDATA: join(root, 'appdata') };
  const copies = findNpmCopies({ ownRoot: join(root, 'app'), env, homeDir: home, listDirectory: () => [] });
  assert.equal(copies.length, 1);
  assert.equal(copies[0].version, '0.12.4');
  assert.equal(realpathSync(copies[0].packageRoot), realpathSync(npm.packageRoot));
  assert.equal(copies[0].launchers.length, 1);
  assert.match(copies[0].removeCommand, /^npm uninstall --global fuli-context --prefix /);
  // The desktop app never reports itself, and nothing on PATH means nothing found.
  assert.deepEqual(findNpmCopies({ ownRoot: npm.packageRoot, env, homeDir: home, listDirectory: () => [] }), []);
  assert.deepEqual(findNpmCopies({ ownRoot: join(root, 'app'), env: { PATH: join(root, 'empty') }, homeDir: home,
    listDirectory: () => [] }).filter(copy => copy.packageRoot.startsWith(root)), []);
});

test('an npm copy a running console recorded counts even when no fl is on PATH', t => {
  const root = temporary(t);
  const npm = npmPrefix(root, '0.20.1');
  const copies = findNpmCopies({ ownRoot: join(root, 'app'), extraRoots: [npm.packageRoot, join(root, 'checkout')],
    env: { PATH: '' }, homeDir: join(root, 'home'), listDirectory: () => [], inspect: () => ({ launchers: [] }) });
  assert.deepEqual(copies.map(copy => [copy.version, copy.launchers.length]), [['0.20.1', 0]]);
});

test('only a live console of another FULI package counts as another copy\'s', t => {
  const dataDir = temporary(t);
  const context = { dataDir, packageRoot: join(dataDir, 'app') };
  mkdirSync(context.packageRoot);
  const state = (value) => writeFileSync(join(dataDir, 'graph-runtime-state.json'), JSON.stringify(value));
  assert.equal(otherPackageConsole(context), null, 'no console recorded');
  state({ version: 4, pid: 4242, url: 'http://127.0.0.1:2727', packageRoot: '/opt/homebrew/lib/node_modules/fuli-context' });
  assert.deepEqual(otherPackageConsole(context, { isAlive: pid => pid === 4242 }),
    { pid: 4242, packageRoot: '/opt/homebrew/lib/node_modules/fuli-context' });
  assert.equal(otherPackageConsole(context, { isAlive: () => false }), null, 'a dead process runs nothing');
  state({ version: 4, pid: 4242, url: 'http://127.0.0.1:2727' });
  assert.deepEqual(otherPackageConsole(context, { isAlive: () => true }), { pid: 4242, packageRoot: null },
    'a console from before consoles recorded their package is another copy\'s');
  state({ version: 4, pid: 4242, url: 'http://127.0.0.1:2727', packageRoot: context.packageRoot });
  assert.equal(otherPackageConsole(context, { isAlive: () => true }), null, 'the app\'s own console');
});

test('clients are pointed at the app once per npm copy, and again whenever another copy\'s console was replaced', async t => {
  const dataDir = temporary(t);
  const context = { dataDir, packageRoot: join(dataDir, 'app') };
  const copy = { packageRoot: '/opt/homebrew/lib/node_modules/fuli-context', version: '0.12.4', launchers: [], removeCommand: 'x' };
  const calls = [];
  const invoke = async (args) => { calls.push(args); return { code: 0, stdout: '', stderr: '' }; };
  const now = () => new Date('2026-11-08T08:00:00.000Z');
  assert.equal(await reconnectAfterAdoption(context, { replaced: null, invoke, findCopies: () => [], now }), null);
  assert.equal(existsSync(join(dataDir, DESKTOP_ADOPTION_FILE)), false, 'nothing found, nothing written');
  assert.deepEqual(await reconnectAfterAdoption(context, { replaced: null, invoke, findCopies: () => [copy], now }),
    { clients: 'reconnected', npmCopies: 1 });
  assert.deepEqual(calls, [['setup', '--yes', '--connected-only']]);
  assert.deepEqual(JSON.parse(readFileSync(join(dataDir, DESKTOP_ADOPTION_FILE), 'utf8')),
    { version: 1, adoptedAt: '2026-11-08T08:00:00.000Z', npmCopies: [copy.packageRoot], clients: 'reconnected' });
  assert.equal(await reconnectAfterAdoption(context, { replaced: null, invoke, findCopies: () => [copy], now }), null,
    'an adopted copy is not reconnected at every start');
  const failing = async (args) => { calls.push(args); return { code: 1, stdout: '', stderr: 'partial' }; };
  assert.deepEqual(await reconnectAfterAdoption(context, { replaced: { pid: 1, packageRoot: null }, invoke: failing,
    findCopies: () => [copy], now }), { clients: 'not_reconnected', npmCopies: 1 });
  assert.equal(calls.length, 2);
});

test('the desktop app restarts a console an npm copy runs, then reconnects the clients', async t => {
  const root = temporary(t);
  const context = { dataDir: join(root, 'data'), packageRoot: join(root, 'app'), nodePath: 'node', cliPath: 'cli.js' };
  mkdirSync(context.dataDir);
  mkdirSync(context.packageRoot);
  writeFileSync(join(context.dataDir, 'graph-runtime.json'), '{}');
  writeFileSync(join(context.dataDir, 'runtime-settings.json'), JSON.stringify({ graphRuntimeMode: 'native' }));
  const npmRoot = '/opt/homebrew/lib/node_modules/fuli-context';
  writeFileSync(join(context.dataDir, 'graph-runtime-state.json'),
    JSON.stringify({ version: 4, pid: process.pid, url: 'http://127.0.0.1:2727', packageRoot: npmRoot }));
  const calls = [];
  const runCli = async (_context, args) => {
    calls.push(args.slice(0, -2));
    if (args[0] === 'restart') {
      writeFileSync(join(context.dataDir, 'graph-runtime-state.json'),
        JSON.stringify({ version: 4, pid: process.pid, url: 'http://127.0.0.1:2727', packageRoot: context.packageRoot }));
    }
    return args[0] === 'status' ? { code: 0, stdout: JSON.stringify({ status: 'running' }), stderr: '' } : { code: 0, stdout: '', stderr: '' };
  };
  const copies = ({ extraRoots }) => extraRoots.map(packageRoot => ({ packageRoot, version: '0.12.4', launchers: [], removeCommand: 'x' }));
  const result = await runTrayAction('start', context, { runCli, findCopies: copies });
  assert.equal(result.ok, true);
  assert.equal(result.replacedConsole, process.pid);
  assert.deepEqual(result.adopted, { clients: 'reconnected', npmCopies: 1 });
  assert.deepEqual(calls.map(args => args.join(' ')),
    ['status --json', 'restart', 'status --json', 'setup --yes --connected-only', 'status --json']);
  // The next start finds the app's own console running: nothing is restarted or reconnected.
  calls.length = 0;
  const again = await runTrayAction('start', context, { runCli, findCopies: copies });
  assert.equal(again.ok, true);
  assert.equal(again.adopted, undefined);
  assert.deepEqual(calls.map(args => args.join(' ')), ['status --json', 'status --json', 'status --json']);
});

test('the 体检 names an npm copy beside the app, the shell commands it still answers and the one command to remove it', async () => {
  const doctor = (npmCopies) => createDoctor({ observeClients: () => ({ clients: [] }), liveProcesses: () => [],
    latestVersion: () => null, lastUpdate: () => null, npmCopies, version: '0.25.0' });
  const none = await doctor(() => []).check();
  assert.equal(none.items.some(item => item.kind === 'npm_copy_installed'), false);
  const found = await doctor(() => [{ packageRoot: '/opt/homebrew/lib/node_modules/fuli-context', version: '0.12.4',
    launchers: ['/opt/homebrew/bin/fl', '/opt/homebrew/bin/fuli'],
    removeCommand: 'npm uninstall --global fuli-context --prefix /opt/homebrew' }]).check();
  const item = found.items.find(candidate => candidate.kind === 'npm_copy_installed');
  assert.deepEqual(item, { id: 'npm_copy_installed', kind: 'npm_copy_installed', severity: 'warning', fix: 'person',
    data: { copies: [{ version: '0.12.4', shellCommands: ['fl', 'fuli'] }],
      commands: ['npm uninstall --global fuli-context --prefix /opt/homebrew'] } });
  assert.equal(found.overall, 'needs_person');
});
