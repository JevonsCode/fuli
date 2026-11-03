import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';

import { formatUninstallPreview, formatUninstallResult, runUninstallCommand } from '../src/cli/uninstall-command.js';
import { applyLocalUninstall, planLocalUninstall, removalTarget } from '../src/setup/uninstall.js';
import { fakeClientInstaller } from '../test-support/fake-client-installer.js';

const PLAN = Object.freeze({
  paths: {
    dataDir: 'C:/Fuli',
    backupDir: 'C:/Fuli/backups/agents'
  },
  agents: [{ id: 'codex', label: 'Codex', available: true, integrationStatus: 'connected' }]
});

test('uninstall planning removes FULI where agent-installer finds it; without it, from none, and says why', async () => {
  const plan = await planLocalUninstall({ dataDir: null }, {
    resolvePaths: () => PLAN.paths,
    detect: async () => ({ status: 'available', agents: [PLAN.agents[0],
      { id: 'cursor', label: 'Cursor', integrationStatus: 'update_available' },
      { id: 'gemini', label: 'Gemini CLI', integrationStatus: 'not_connected' }] })
  });
  assert.deepEqual(plan.agents.map(({ id }) => id), ['codex', 'cursor']);
  const offline = await planLocalUninstall({ dataDir: null }, { resolvePaths: () => PLAN.paths,
    detect: async () => ({ status: 'unavailable', reason: 'offline' }) });
  assert.deepEqual(offline.agents, []);
  assert.match(formatUninstallPreview(offline), /Agent integrations: left in place\. 无法下载客户端组件.*check your network connection and try again\./);
  const result = await applyLocalUninstall(offline, { stopRuntime: async () => ({ status: 'stopped' }) });
  assert.equal(result.status, 'partial');
  assert.match(formatUninstallResult(result), /Agent integrations were left in place: 无法下载客户端组件/);
});

test('uninstall removes FULI through agent-installer, reports what it left, and preserves data', async () => {
  const installer = fakeClientInstaller([{ id: 'codex', state: 'connected', mcp: 'current' },
    { id: 'cursor', state: 'connected', mcp: 'current' }, { id: 'gemini' }], { problems: { cursor: ['skills: It was changed by hand, so it is left as it is.'] } });
  const result = await applyLocalUninstall({ ...PLAN, agents: [PLAN.agents[0], { id: 'cursor', label: 'Cursor' }, { id: 'gemini', label: 'Gemini CLI' }] }, {
    stopRuntime: async () => ({ status: 'stopped' }),
    clientInstaller: installer
  });

  assert.deepEqual(installer.calls, [['remove', ['codex']], ['remove', ['cursor']], ['remove', ['gemini']]]);
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.data, { status: 'preserved', path: 'C:/Fuli' });
  assert.deepEqual(result.agents, [
    { id: 'codex', label: 'Codex', status: 'disconnected' },
    { id: 'cursor', label: 'Cursor', status: 'partial', errors: ['skills: It was changed by hand, so it is left as it is.'] },
    { id: 'gemini', label: 'Gemini CLI', status: 'not_connected' }
  ]);
  assert.match(formatUninstallResult(result), /Cursor: skills: It was changed by hand/);
});

test('uninstall stays partial when the local process cannot be safely confirmed stopped', async () => {
  const result = await applyLocalUninstall({ ...PLAN, agents: [] }, {
    stopRuntime: async () => ({
      status: 'partial',
      console: 'unverified',
      providers: 'stopped'
    })
  });

  assert.equal(result.status, 'partial');
  assert.deepEqual(result.data, { status: 'preserved', path: 'C:/Fuli' });
});

test('fl uninstall previews preserved data and --yes skips confirmation', async () => {
  const output = [];
  let confirmations = 0;
  const result = await runUninstallCommand(['--yes'], {
    planUninstall: () => PLAN,
    applyUninstall: async () => ({
      status: 'ready',
      runtime: { status: 'stopped' },
      agents: [],
      data: { status: 'preserved', path: 'C:/Fuli' }
    }),
    confirm: async () => { confirmations += 1; return false; },
    write: (line) => output.push(line)
  });

  assert.equal(confirmations, 0);
  assert.equal(result.status, 'ready');
  assert.match(output[0], /Data: preserve C:\/Fuli/);
  assert.match(output.at(-1), /npm uninstall --global fuli-context/);
  assert.doesNotMatch(output.join('\n'), /[\p{Script=Han}]/u);
});

test('portable uninstall says to delete the folder and warns when data lives inside it', async () => {
  const portable = { ...PLAN, paths: { ...PLAN.paths, portableRoot: 'C:/Portable Fuli', dataDir: 'C:/Portable Fuli/data' } };
  const removal = removalTarget(portable.paths);
  assert.deepEqual(removal, { kind: 'portable_folder', path: 'C:/Portable Fuli', dataInside: true });
  const output = [];
  await runUninstallCommand(['--yes'], {
    planUninstall: () => portable,
    applyUninstall: async () => ({ status: 'ready', runtime: { status: 'stopped' }, agents: [],
      data: { status: 'preserved', path: portable.paths.dataDir }, removal }),
    write: line => output.push(line)
  });
  const text = output.join('\n');
  assert.doesNotMatch(text, /npm uninstall|Neo4j volumes/);
  assert.match(output.at(-1), /delete this portable folder: C:\/Portable Fuli[\s\S]*move it out of C:\/Portable Fuli first/);
  assert.match(output[0], /data directory is inside the portable folder/);
});

test('portable data outside the folder needs no warning; npm installs keep the npm instruction', () => {
  assert.deepEqual(removalTarget({ portableRoot: 'C:/Portable Fuli', dataDir: 'D:/Fuli data' }),
    { kind: 'portable_folder', path: 'C:/Portable Fuli', dataInside: false });
  assert.deepEqual(removalTarget({ portableRoot: 'C:/Portable Fuli', dataDir: 'C:/Portable Fuli other/data' }),
    { kind: 'portable_folder', path: 'C:/Portable Fuli', dataInside: false });
  assert.deepEqual(removalTarget({ portableRoot: null, dataDir: 'C:/Fuli' }), { kind: 'npm_global' });
  assert.match(formatUninstallResult({ status: 'ready', runtime: { status: 'stopped' }, agents: [],
    data: { path: 'D:/Fuli data' }, removal: { kind: 'portable_folder', path: 'C:/Portable Fuli', dataInside: false } }),
    /delete this portable folder: C:\/Portable Fuli$/);
});

test('a data folder whose name starts with two dots is still inside the portable folder', () => {
  // Host-native absolute paths: removalTarget uses the host path module.
  const base = process.cwd();
  const portableRoot = join(base, 'Portable Fuli');
  for (const dataDir of [join(portableRoot, '..data'), join(portableRoot, '..data', 'graph'), portableRoot]) {
    assert.equal(removalTarget({ portableRoot, dataDir }).dataInside, true, dataDir);
  }
  for (const dataDir of [join(base, 'data'), join(base, 'Portable Fuli other', 'data')]) {
    assert.equal(removalTarget({ portableRoot, dataDir }).dataInside, false, dataDir);
  }
});

test('Windows portable data checks accept backslashes and reject another drive', { skip: process.platform !== 'win32' }, () => {
  assert.equal(removalTarget({ portableRoot: 'C:\\Portable Fuli', dataDir: 'C:\\Portable Fuli\\..data\\graph' }).dataInside, true);
  assert.equal(removalTarget({ portableRoot: 'C:\\Portable Fuli', dataDir: 'D:\\Portable Fuli\\data' }).dataInside, false);
});
