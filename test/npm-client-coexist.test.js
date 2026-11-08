import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { npmUninstallCommand } from '../src/cli/update-installation.js';
import { runTrayAction } from '../src/desktop/desktop-controller.js';
import { adoptionHold, otherPackageConsole, reconnectAfterAdoption } from '../src/desktop/npm-adoption.js';
import { DESKTOP_ADOPTION_FILE } from '../src/desktop/npm-adoption-store.js';
import { npmCopyDataUse } from '../src/desktop/npm-copy-data.js';
import { findNpmCopies } from '../src/desktop/npm-copies.js';
import { createNpmCopyControl } from '../src/desktop/npm-copy-control.js';
import { uninstallNpmCopy } from '../src/desktop/npm-copy-uninstall.js';
import { tidyInstallation } from '../src/desktop/windows-controller.js';
import { removeRetiredLaunchers } from '../src/desktop/windows-node-launcher.js';
import { createDoctor } from '../src/system/doctor.js';
import { handleNpmCopiesRequest } from '../src/http/npm-copies-api-router.js';

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
  assert.deepEqual(copies[0].shellCommands, ['fl']);
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

test('a project folder node_modules is never taken for an npm global install', t => {
  const root = temporary(t);
  const windows = process.platform === 'win32';
  const project = join(root, 'project');
  const packageRoot = windows ? join(project, 'node_modules', 'fuli-context') : join(project, 'lib', 'node_modules', 'fuli-context');
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: 'fuli-context', version: '0.12.4' }));
  writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'some-project', version: '1.0.0' }));
  assert.deepEqual(findNpmCopies({ ownRoot: join(root, 'app'), extraRoots: [packageRoot], env: { PATH: '' },
    homeDir: join(root, 'home'), listDirectory: () => [], inspect: () => ({ launchers: [] }) }), []);
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

test('clients are pointed at the app once per npm copy whose clients use this data, and again when a console was replaced', async t => {
  const dataDir = temporary(t);
  const context = { dataDir, packageRoot: join(dataDir, 'app') };
  const copy = { packageRoot: '/opt/homebrew/lib/node_modules/fuli-context', version: '0.12.4', launchers: [], removeCommand: 'x' };
  const calls = [];
  const invoke = async (args) => { calls.push(args); return { code: 0, stdout: '', stderr: '' }; };
  const now = () => new Date('2026-11-08T08:00:00.000Z');
  const uses = (shares, dataDir = null) => async () => new Map([[copy.packageRoot, { shares, dataDir }]]);
  const run = (options) => reconnectAfterAdoption(context, { replaced: null, invoke, findCopies: () => [copy], now,
    appVersion: '0.25.0', ...options });
  assert.equal(await run({ findCopies: () => [], dataUse: uses(true) }), null);
  assert.equal(existsSync(join(dataDir, DESKTOP_ADOPTION_FILE)), false, 'nothing found, nothing written');
  assert.equal(await run({ dataUse: uses(null) }), null, 'no client names the copy: nothing to point anywhere');
  assert.deepEqual(calls, []);
  assert.deepEqual(await run({ dataUse: uses(true) }), { clients: 'reconnected', npmCopies: 1 });
  assert.deepEqual(calls, [['setup', '--yes', '--connected-only']]);
  const record = JSON.parse(readFileSync(join(dataDir, DESKTOP_ADOPTION_FILE), 'utf8'));
  assert.deepEqual([record.adoptedAt, record.npmCopies, record.clients], ['2026-11-08T08:00:00.000Z', [copy.packageRoot], 'reconnected']);
  assert.equal(await run({ dataUse: uses(true) }), null, 'an adopted copy is not reconnected at every start');
  const failing = async (args) => { calls.push(args); return { code: 1, stdout: '', stderr: 'partial' }; };
  assert.deepEqual(await run({ replaced: { pid: 1, packageRoot: null }, invoke: failing, dataUse: uses(true) }),
    { clients: 'not_reconnected', npmCopies: 1 });
  assert.equal(calls.length, 2);
});

test('an npm copy on other data, or newer than the app, keeps its clients: nothing is reconnected', async t => {
  const dataDir = temporary(t);
  const context = { dataDir, packageRoot: join(dataDir, 'app') };
  const copy = { packageRoot: '/opt/homebrew/lib/node_modules/fuli-context', version: '0.12.4', launchers: [], removeCommand: 'x' };
  const invoke = async () => assert.fail('no client is rewritten');
  const other = await reconnectAfterAdoption(context, { replaced: { pid: 1, packageRoot: copy.packageRoot }, invoke,
    findCopies: () => [copy], appVersion: '0.25.0',
    dataUse: async () => new Map([[copy.packageRoot, { shares: false, dataDir: '/Users/synthetic/other-fuli' }]]) });
  assert.deepEqual(other, { clients: 'kept', npmCopies: 1 });
  assert.deepEqual(JSON.parse(readFileSync(join(dataDir, DESKTOP_ADOPTION_FILE), 'utf8')).copies,
    { [copy.packageRoot]: { shares: false, dataDir: '/Users/synthetic/other-fuli' } });
  const newer = await reconnectAfterAdoption(context, { replaced: null, invoke, findCopies: () => [{ ...copy, version: '0.30.0' }],
    appVersion: '0.25.0', dataUse: async () => new Map([[copy.packageRoot, { shares: true, dataDir: null }]]) });
  assert.deepEqual(newer, { clients: 'kept', npmCopies: 1 });
});

test('a client entry tells which data an npm copy serves', () => {
  const copy = { packageRoot: '/opt/homebrew/lib/node_modules/fuli-context' };
  const file = (runtimeConfig) => JSON.stringify({ mcpServers: { fuli: { command: '/opt/homebrew/bin/node',
    args: [copy.packageRoot + '/src/mcp-server.js', '--runtime-config', runtimeConfig] } } });
  const files = { '/home/s/.claude.json': file('/home/s/Library/Application Support/Fuli/graph-runtime.json'),
    '/home/s/.codex/config.toml': 'other = 1' };
  const clients = [{ components: { mcp: 'outdated' }, mcpPaths: ['~/.claude.json'] },
    { components: { mcp: 'missing' }, mcpPaths: ['~/.codex/config.toml'] }];
  const use = (runtimeConfigPath, text = files) => npmCopyDataUse([copy], { runtimeConfigPath, clients, homeDir: '/home/s',
    platform: 'darwin', readText: (path) => { if (!(path in text)) throw new Error('missing'); return text[path]; } }).get(copy.packageRoot);
  assert.deepEqual(use('/home/s/Library/Application Support/Fuli/graph-runtime.json'), { shares: true, dataDir: null });
  assert.deepEqual(use('/home/s/Library/Application Support/Fuli-app/graph-runtime.json'),
    { shares: false, dataDir: '/home/s/Library/Application Support/Fuli' });
  assert.deepEqual(use('/x/graph-runtime.json', { '/home/s/.claude.json': 'no fuli here' }), { shares: null, dataDir: null });
  // Windows: JSON-escaped backslashes, compared without case, shown as written.
  const win = { packageRoot: 'C:\\nvm4w\\nodejs\\node_modules\\fuli-context' };
  const winFile = JSON.stringify({ args: ['C:\\NVM4W\\nodejs\\node_modules\\fuli-context\\src\\mcp-server.js', '--runtime-config',
    'D:\\数据\\Fuli\\graph-runtime.json'] });
  assert.deepEqual(npmCopyDataUse([win], { runtimeConfigPath: 'C:\\Users\\s\\AppData\\Local\\Fuli\\graph-runtime.json',
    clients: [{ components: { mcp: 'current' }, mcpPaths: ['~/.claude.json'] }], homeDir: 'C:\\Users\\s', platform: 'win32',
    readText: () => winFile }).get(win.packageRoot), { shares: false, dataDir: 'D:\\数据\\Fuli' });
});

test('the app waits while the data is busy, and leaves a newer npm copy running', t => {
  const root = temporary(t);
  const npmRoot = join(root, 'npm', 'lib', 'node_modules', 'fuli-context');
  mkdirSync(npmRoot, { recursive: true });
  writeFileSync(join(npmRoot, 'package.json'), JSON.stringify({ name: 'fuli-context', version: '0.30.0' }));
  const context = { dataDir: join(root, 'data'), packageRoot: join(root, 'app') };
  assert.deepEqual(adoptionHold(context, null, { busy: () => true }), { reason: 'data_busy' });
  assert.deepEqual(adoptionHold(context, { pid: 1, packageRoot: npmRoot }, { busy: () => false, appVersion: '0.25.0' }),
    { reason: 'npm_newer', version: '0.30.0' });
  assert.equal(adoptionHold(context, { pid: 1, packageRoot: npmRoot }, { busy: () => false, appVersion: '0.31.0' }), null);
  assert.equal(adoptionHold(context, { pid: 1, packageRoot: null }, { busy: () => false }), null,
    'a console from before consoles recorded their package is older than this app');
});

test('the desktop app leaves a newer npm console running and says to update the app first', async t => {
  const root = temporary(t);
  const context = { dataDir: join(root, 'data'), packageRoot: join(root, 'app'), nodePath: 'node', cliPath: 'cli.js' };
  mkdirSync(context.dataDir);
  writeFileSync(join(context.dataDir, 'graph-runtime.json'), '{}');
  writeFileSync(join(context.dataDir, 'runtime-settings.json'), JSON.stringify({ graphRuntimeMode: 'native' }));
  writeFileSync(join(context.dataDir, 'graph-runtime-state.json'),
    JSON.stringify({ version: 4, pid: process.pid, url: 'http://127.0.0.1:2727', packageRoot: '/synthetic/node_modules/fuli-context' }));
  const calls = [];
  const runCli = async (_context, args) => { calls.push(args[0]);
    return args[0] === 'status' ? { code: 0, stdout: JSON.stringify({ status: 'running' }), stderr: '' } : { code: 0, stdout: '', stderr: '' }; };
  const result = await runTrayAction('start', context, { runCli,
    holdAdoption: () => ({ reason: 'npm_newer', version: '0.30.0' }) });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ['status', 'status', 'status'], 'nothing restarted, no client reconnected');
  assert.match(result.notice, /v0\.30\.0 比桌面版新/);
  const busy = await runTrayAction('start', context, { runCli, holdAdoption: () => ({ reason: 'data_busy' }) });
  assert.match(busy.notice, /下次启动再试/);
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
    launchers: ['/opt/homebrew/bin/fl', '/opt/homebrew/bin/fuli'], shellCommands: ['fl', 'fuli'],
    removeCommand: 'npm uninstall --global fuli-context --prefix /opt/homebrew' }]).check();
  const item = found.items.find(candidate => candidate.kind === 'npm_copy_installed');
  // The console's own notice speaks to the person; the 体检 keeps it as info for Agents.
  assert.deepEqual(item, { id: 'npm_copy_installed', kind: 'npm_copy_installed', severity: 'info', fix: 'person',
    data: { copies: [{ version: '0.12.4', shellCommands: ['fl', 'fuli'] }],
      commands: ['npm uninstall --global fuli-context --prefix /opt/homebrew'] } });
  assert.equal(found.overall, 'ok');
});

test('removing an npm copy runs the npm of its own prefix, without lifecycle scripts, and checks it is gone', async t => {
  const root = temporary(t);
  const npm = npmPrefix(root);
  const windows = process.platform === 'win32';
  const npmCli = windows ? join(npm.prefix, 'node_modules', 'npm', 'bin', 'npm-cli.js') : join(npm.prefix, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const node = windows ? join(npm.prefix, 'node.exe') : join(npm.prefix, 'bin', 'node');
  mkdirSync(join(npmCli, '..'), { recursive: true });
  writeFileSync(npmCli, '');
  writeFileSync(node, '');
  const copy = { packageRoot: npm.packageRoot, version: '0.12.4' };
  const runs = [];
  const removed = await uninstallNpmCopy(copy, { env: { PATH: '' }, execPath: 'app-node', run: async (command, args) => {
    runs.push([command, ...args]);
    rmSync(npm.packageRoot, { recursive: true, force: true });
    return { code: 0, stdout: '', stderr: '' };
  } });
  assert.equal(removed.status, 'uninstalled');
  assert.deepEqual(runs, [[node, npmCli, 'uninstall', '--global', 'fuli-context', '--prefix', npm.prefix, '--ignore-scripts']]);
  assert.equal(existsSync(join(root, 'npm prefix')), true, 'only the package goes; npm does the rest');
});

test('a removal that cannot run or does not finish names the command the person runs', async t => {
  const root = temporary(t);
  const npm = npmPrefix(root);
  const copy = { packageRoot: npm.packageRoot, version: '0.12.4' };
  const notFound = await uninstallNpmCopy(copy, { env: { PATH: '' }, run: async () => assert.fail('no npm to run') });
  assert.equal(notFound.status, 'failed');
  assert.equal(notFound.error, 'npm_not_found');
  assert.match(notFound.manualCommand, /^npm uninstall --global fuli-context --prefix /);
  const npmCli = process.platform === 'win32' ? join(npm.prefix, 'node_modules', 'npm', 'bin', 'npm-cli.js')
    : join(npm.prefix, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  mkdirSync(join(npmCli, '..'), { recursive: true });
  writeFileSync(npmCli, '');
  const denied = await uninstallNpmCopy(copy, { env: { PATH: '' }, execPath: 'app-node',
    run: async () => ({ code: 243, stdout: '', stderr: 'npm error code EACCES\nnpm error permission denied' }) });
  assert.deepEqual([denied.status, denied.error], ['failed', 'npm error permission denied']);
  assert.equal(existsSync(npm.packageRoot), true);
});

test('only a copy found right now can be removed; a closed notice stays closed', async t => {
  const dataDir = temporary(t);
  const copy = { packageRoot: '/synthetic/lib/node_modules/fuli-context', version: '0.12.4', launchers: [], shellCommands: [],
    removeCommand: 'x' };
  const removed = [];
  const control = createNpmCopyControl({ dataDir, ownRoot: '/app', find: () => [copy],
    uninstall: async (target) => { removed.push(target.packageRoot); return { status: 'uninstalled', version: target.version } } });
  await assert.rejects(control.uninstall({ packageRoot: '/elsewhere/node_modules/fuli-context' }), /No npm copy of FULI is installed there/);
  await assert.rejects(control.uninstall({ packageRoot: copy.packageRoot, extra: true }), /Send only packageRoot/);
  assert.deepEqual(removed, []);
  assert.equal((await control.uninstall({ packageRoot: copy.packageRoot })).status, 'uninstalled');
  assert.deepEqual(removed, [copy.packageRoot]);
  assert.equal(control.list().copies[0].noticeDismissed, false);
  assert.equal(control.setNotice({ packageRoot: copy.packageRoot, dismissed: true }).copies[0].noticeDismissed, true);
  assert.equal(createNpmCopyControl({ dataDir, ownRoot: '/app', find: () => [copy] }).list().copies[0].noticeDismissed, true);
  assert.equal(control.setNotice({ packageRoot: copy.packageRoot, dismissed: false }).copies[0].noticeDismissed, false);
});

test('a Windows tray start clears launchers an update set aside, and keeps one still in use', t => {
  const installRoot = temporary(t);
  const old = 'FuliNode.exe.0b8a3c1e-1111-4222-8333-444455556666.old';
  writeFileSync(join(installRoot, old), '');
  writeFileSync(join(installRoot, 'FuliNode.exe'), '');
  const staged = 'FuliNode.exe.0b8a3c1e-1111-4222-8333-777788889999.new';
  writeFileSync(join(installRoot, staged), '');
  assert.deepEqual(tidyInstallation({ installRoot }, 'status'), [], 'status never touches files');
  assert.equal(existsSync(join(installRoot, old)), true);
  assert.deepEqual(tidyInstallation({ installRoot }, 'start'), []);
  assert.equal(existsSync(join(installRoot, old)), false);
  assert.equal(existsSync(join(installRoot, 'FuliNode.exe')), true, 'the current launcher stays');
  assert.equal(existsSync(join(installRoot, staged)), true, 'a launcher an update is placing is never touched');
  assert.deepEqual(tidyInstallation({ installRoot: null }, 'start'), [], 'a portable tray has no installation');
  assert.deepEqual(tidyInstallation({ installRoot }, 'start-open', { removeLeftovers: () => ['held'] }), ['held']);
  assert.deepEqual(removeRetiredLaunchers(installRoot), []);
});

test('only this computer removes an npm copy or closes its notice; anyone may read the list', async () => {
  const answer = () => {
    const sent = { headers: {} };
    return { sent, response: { setHeader: (key, value) => { sent.headers[key] = value; },
      writeHead: (status) => { sent.status = status; }, end: (body) => { sent.body = JSON.parse(body); } } };
  };
  const call = async (method, path, address, system) => {
    const { sent, response } = answer();
    const handled = await handleNpmCopiesRequest({ request: { method, socket: { remoteAddress: address } }, response,
      url: new URL(`http://127.0.0.1${path}`), system });
    return { handled, ...sent };
  };
  const system = { npmCopies: { list: () => ({ copies: [{ version: '0.12.4' }] }),
    uninstall: async () => assert.fail('a remote request never removes'), setNotice: () => assert.fail('nor closes') } };
  assert.deepEqual((await call('GET', '/api/system/npm-copies', '192.168.1.20', system)).body, { copies: [{ version: '0.12.4' }] });
  const remote = await call('POST', '/api/system/npm-copies/uninstall', '192.168.1.20', system);
  assert.deepEqual([remote.status, remote.body.code], [403, 'local_user_only']);
  assert.equal((await call('PUT', '/api/system/npm-copies/notice', '192.168.1.20', system)).status, 403);
  assert.equal((await call('DELETE', '/api/system/npm-copies/uninstall', '127.0.0.1', system)).status, 405);
  assert.deepEqual((await call('GET', '/api/system/npm-copies', '127.0.0.1', {})).body, { copies: [] }, 'no desktop app, nothing listed');
  assert.equal((await call('GET', '/api/system/doctor', '127.0.0.1', system)).handled, false);
});
