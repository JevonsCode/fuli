import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { loadTrayContext, supersededReply } from '../src/desktop/windows-controller.js';
import { WindowsInstallationSupersededError } from '../src/desktop/windows-installation-context.js';
import { installWindowsForCurrentUser } from '../src/desktop/windows-installation.js';
import { updateWindowsInstallation } from '../src/desktop/windows-update.js';
import { mcpServerTarget } from '../src/mcp/relay-target.js';

import { installedWindowsFixture, windowsInstallationFixture as fixture } from './fixtures/windows-installation.js';

// rec#131: a client window from a version an update (command line or Agent)
// replaced is told it is the old version, with the copy to open, and keeps
// the one-client lock of the same data so the next update closes it.

function installedAndReplaced(t) {
  const f = fixture(t);
  const installed = installWindowsForCurrentUser(f.options, f.deps);
  const before = loadTrayContext({ packageRoot: installed.packageRoot, env: f.env });
  const recordPath = join(installed.installRoot, 'installation.json');
  const record = JSON.parse(readFileSync(recordPath, 'utf8'));
  const installationId = randomUUID();
  const next = { ...record, installationId, packageRoot: join(record.installRoot, 'versions', installationId),
    applicationVersion: '0.12.5' };
  writeFileSync(recordPath, JSON.stringify(next));
  return { f, installed, before, next, recordPath };
}

test('a client of a replaced version learns it is the old one, which copy to open, and keeps the same lock', t => {
  const { f, installed, before, next } = installedAndReplaced(t);
  let error;
  try { loadTrayContext({ packageRoot: installed.packageRoot, env: f.env }); } catch (caught) { error = caught; }
  assert.ok(error instanceof WindowsInstallationSupersededError);
  assert.match(error.message, /^这是旧版本的 FULI/);
  assert.match(error.message, / \/ This is an older version of FULI/);
  assert.deepEqual(supersededReply(error), {
    ok: false, status: 'superseded', error: error.message, dataDir: before.dataDir,
    instanceKey: before.instanceKey, currentPackageRoot: next.packageRoot
  });
});

test('a record for other data, or a moved folder, is a broken installation, said in Chinese and English', t => {
  const { f, installed, next, recordPath } = installedAndReplaced(t);
  writeFileSync(recordPath, JSON.stringify({ ...next, dataDir: join(f.root, 'other-data') }));
  const broken = error => !(error instanceof WindowsInstallationSupersededError)
    && /^FULI 的安装记录读不出来/.test(error.message) && /installation record can't be read/.test(error.message)
    && !/Invalid Windows/.test(error.message);
  assert.throws(() => loadTrayContext({ packageRoot: installed.packageRoot, env: f.env }), broken);
  writeFileSync(recordPath, JSON.stringify({ ...next, installationId: installed.installationId, packageRoot: installed.packageRoot }));
  const moved = installed.packageRoot + '-moved';
  renameSync(installed.packageRoot, moved);
  assert.throws(() => loadTrayContext({ packageRoot: moved, env: f.env }), broken);
});

test('both an open MCP relay and a fresh one launched from the previous slot follow the installed version', async t => {
  const f = installedWindowsFixture(t);
  const args = ['--runtime-config', join(f.current.dataDir, 'graph-runtime.json'), '--source-application', 'codex'];
  const fromPrevious = () => mcpServerTarget(args, { packageRoot: f.current.packageRoot });
  const openRelay = fromPrevious();
  assert.equal(openRelay().version, f.current.applicationVersion);
  const next = await updateWindowsInstallation(f.options, f.deps);
  const expected = {
    version: next.applicationVersion,
    command: join(next.packageRoot, 'runtime', 'node', 'node.exe'),
    args: [join(next.packageRoot, 'src', 'mcp-server.js'), ...args]
  };
  assert.deepEqual(openRelay(), expected);
  assert.deepEqual(fromPrevious()(), expected);

  const recordPath = join(f.current.installRoot, 'installation.json');
  const record = JSON.parse(readFileSync(recordPath, 'utf8'));
  writeFileSync(recordPath, JSON.stringify({ ...record, dataDir: join(f.root, 'other-data') }));
  assert.equal(openRelay(), null, 'an open client stays bound to its own data directory');
  assert.throws(fromPrevious, /installation record/);
});

test('the Windows stdio entry starts the active server before resolving runtime paths in a replaced slot',
  { skip: process.platform !== 'win32' }, async t => {
    const f = installedWindowsFixture(t);
    const next = await updateWindowsInstallation(f.options, f.deps);
    // Run the checkout's entry as the old slot. Only the active slot can answer.
    const previous = f.current.packageRoot;
    renameSync(join(previous, 'src'), join(previous, 'fixture-src'));
    copyFileSync(process.execPath, join(next.packageRoot, 'runtime', 'node', 'node.exe'));
    writeFileSync(join(next.packageRoot, 'src', 'mcp-server.js'), 'console.log(process.env.FULI_MCP_RELAYED)');
    const links = [];
    try {
      for (const name of ['src', 'packages', 'registry', 'node_modules']) {
        const link = join(name === 'node_modules' ? f.current.installRoot : previous, name);
        symlinkSync(resolve(name), link, 'junction');
        links.push(link);
      }
      const child = spawnSync(process.execPath, ['--preserve-symlinks', '--preserve-symlinks-main',
        join(previous, 'src', 'mcp-server.js'), '--runtime-config', join(f.current.dataDir, 'graph-runtime.json'),
        '--source-application', 'codex'], { encoding: 'utf8', timeout: 15_000, windowsHide: true,
        env: { ...process.env, FULI_MCP_RELAYED: '', FULI_CONSOLE_AUTOSTART: 'off' } });
      assert.equal(child.status, 0, child.error?.message ?? child.stderr);
      assert.equal(child.stdout.trim(), '1');
    } finally {
      for (const link of links) unlinkSync(link);
    }
  });
