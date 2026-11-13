import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { loadTrayContext, supersededReply } from '../src/desktop/windows-controller.js';
import { WindowsInstallationSupersededError } from '../src/desktop/windows-installation-context.js';
import { installWindowsForCurrentUser } from '../src/desktop/windows-installation.js';

import { windowsInstallationFixture as fixture } from './fixtures/windows-installation.js';

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
