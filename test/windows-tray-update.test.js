import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { updateWindowsTrayFromRelease } from '../src/desktop/windows-tray-update.js';

// The console's one-click update of a tray installation, with every Windows
// step replaced: no download, no tray, no update process, no real install.

function installation(t) {
  const root = mkdtempSync(join(tmpdir(), 'fuli-tray-update-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const installRoot = join(root, 'Programs', 'Fuli');
  mkdirSync(installRoot, { recursive: true });
  const record = (packageRoot) => writeFileSync(join(installRoot, 'installation.json'), JSON.stringify({ packageRoot }));
  record(join(installRoot, 'versions', 'old'));
  return { root, record, value: { installRoot, packageRoot: join(installRoot, 'versions', 'old'), dataDir: join(root, 'data') } };
}

function steps({ tray = 'exited', outcome, record }) {
  const events = [];
  const deps = {
    download: async (version, directory, { progress }) => {
      progress('downloading'); progress('verifying');
      events.push(['download', version]);
      return join(directory, 'package');
    },
    exitTray: async (dataDir) => { events.push(['exitTray', dataDir]); return tray; },
    runUpdate: async (source, args) => {
      events.push(['update', args.filter((arg) => !arg.includes('result') && !arg.includes('Fuli') && !arg.includes('fuli'))]);
      const result = outcome?.();
      if (result) {
        if (result.status === 'updated') record(result.packageRoot);
        writeFileSync(args[args.indexOf('--result-file') + 1], JSON.stringify(result));
      }
      return result?.status === 'updated' ? 0 : 1;
    },
    launchTray: (packageRoot) => events.push(['tray', packageRoot])
  };
  return { events, deps };
}

test('download, verify, exit the tray, run the package\'s own update, then reopen the new tray', async (t) => {
  const install = installation(t);
  const newRoot = join(install.value.installRoot, 'versions', 'new');
  const progress = [];
  const { events, deps } = steps({ record: install.record,
    outcome: () => ({ status: 'updated', applicationVersion: '0.13.0', packageRoot: newRoot, clients: 'reconnected' }) });
  const result = await updateWindowsTrayFromRelease({ installation: install.value, version: '0.13.0', progress: (step) => progress.push(step) },
    { ...deps, tempRoot: install.root });
  assert.deepEqual(result, { status: 'updated', version: '0.13.0', clients: 'reconnected' });
  assert.deepEqual(progress, ['downloading', 'verifying', 'exitingTray', 'installing']);
  assert.deepEqual(events, [['download', '0.13.0'], ['exitTray', install.value.dataDir], ['update', ['--yes', '--install-root']],
    ['tray', newRoot]]);
});

test('a blocked update names the processes, picked ones are passed on, and the kept version\'s tray comes back', async (t) => {
  const install = installation(t);
  const blockers = [{ role: 'console', pid: 40, createdFileTime: '133', executable: 'node.exe' }];
  const { events, deps } = steps({ record: install.record,
    outcome: () => ({ status: 'failed', error: 'Another Fuli program runs on this data folder, so nothing was switched: console PID 40', blockers }) });
  const error = await updateWindowsTrayFromRelease({ installation: install.value, version: '0.13.0', stopPids: ['39:1'] },
    { ...deps, tempRoot: install.root }).then(() => assert.fail('blocked'), (caught) => caught);
  assert.deepEqual(error.blockers, blockers);
  assert.deepEqual(events.at(-2), ['update', ['--yes', '--install-root', '--stop-pid', '39:1']]);
  assert.deepEqual(events.at(-1), ['tray', install.value.packageRoot]);
});

test('a tray that does not exit stops the update before anything is installed; no tray was running, none is opened', async (t) => {
  const install = installation(t);
  const busy = steps({ tray: 'busy', record: install.record, outcome: () => assert.fail('nothing is installed') });
  await assert.rejects(updateWindowsTrayFromRelease({ installation: install.value, version: '0.13.0' }, { ...busy.deps, tempRoot: install.root }),
    /tray did not exit/);
  assert.equal(busy.events.some(([name]) => name === 'update' || name === 'tray'), false);

  const absent = steps({ tray: 'absent', record: install.record, outcome: () => null });
  await assert.rejects(updateWindowsTrayFromRelease({ installation: install.value, version: '0.13.0' }, { ...absent.deps, tempRoot: install.root }),
    /without an outcome \(exit 1\)/);
  assert.equal(absent.events.some(([name]) => name === 'tray'), false);
  assert.equal(existsSync(join(install.root, 'Programs')), true);
});

test('an update that installed the new version but did not reconnect the clients says so', async (t) => {
  const install = installation(t);
  const newRoot = join(install.value.installRoot, 'versions', 'new');
  const { deps } = steps({ record: install.record,
    outcome: () => ({ status: 'updated', applicationVersion: '0.13.0', packageRoot: newRoot, clients: 'not_reconnected' }) });
  const result = await updateWindowsTrayFromRelease({ installation: install.value, version: '0.13.0' }, { ...deps, tempRoot: install.root });
  assert.deepEqual(result, { status: 'updated', version: '0.13.0', clients: 'not_reconnected' });
});
