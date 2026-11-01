import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { createClientInstaller } from '../src/system/client-connection-install.js';
import { adapter } from '../src/setup/agents/gemini/index.js';

// agent-installer's answers are synthetic; FULI's writer edits a temporary home only.
const installerAnswer = (clients) => ({ status: async () => ({ status: 'available', extensionErrors: [], clients: clients.map(
  ({ id, detected = true, state = 'not_connected', mcp = 'missing' }) => ({ id, name: id, builtin: true, detected,
    platformSupported: true, state, componentStates: [{ component: 'mcp', state: mcp }] })) }) });

test('one-click connection writes a client agent-installer found, backs up first and self-checks', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'fuli-connect-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const agent = adapter.target({ homeDir: home, pathApi: posix });
  mkdirSync(join(home, '.gemini'));
  const original = '{"theme":"dark"}';
  writeFileSync(agent.configPath, original);
  const paths = { backupDir: join(home, 'backups'), mcpServerPath: '/pkg/mcp.js', graphRuntimeConfigPath: '/data/runtime.json' };
  // The installer sees what the writer wrote.
  const installer = { status: () => {
    const connected = readFileSync(agent.configPath, 'utf8').includes('"fuli"');
    return installerAnswer([{ id: 'gemini-cli', state: connected ? 'connected' : 'not_connected',
      mcp: connected ? 'current' : 'missing' }]).status();
  } };
  const connect = createClientInstaller({ paths, installer, targets: () => [agent] });
  for (const input of [null, {}, { clientId: 'unknown' }, { clientId: 'gemini', configPath: '/bad' }, { clientId: '__proto__' }]) {
    await assert.rejects(() => connect(input));
  }
  assert.equal(readFileSync(agent.configPath, 'utf8'), original);
  const result = await connect({ clientId: 'gemini' });
  assert.deepEqual(result, { id: 'gemini', status: 'connected', restartRequired: true });
  assert.equal(readFileSync(join(paths.backupDir, readdirSync(paths.backupDir)[0]), 'utf8'), original);
  assert.ok(!JSON.stringify(result).includes(home));
});

test('the self-check reads agent-installer: a write it does not see as connected is partial', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'fuli-connect-check-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const agent = adapter.target({ homeDir: home, pathApi: posix });
  const paths = { backupDir: join(home, 'backups'), mcpServerPath: '/pkg/mcp.js', graphRuntimeConfigPath: '/data/runtime.json' };
  const connect = createClientInstaller({ paths, installer: installerAnswer([{ id: 'gemini-cli', state: 'update_available', mcp: 'outdated' }]),
    targets: () => [agent] });
  assert.deepEqual(await connect({ clientId: 'gemini' }), { id: 'gemini', status: 'partial', restartRequired: false });
});

test('manual, absent or undetectable clients never write, and simultaneous requests cannot overlap', async () => {
  const targets = () => [{ id: 'opencode' }, { id: 'gemini' }];
  for (const [installer, clientId] of [
    [installerAnswer([{ id: 'opencode', state: 'manual' }]), 'opencode'],
    [installerAnswer([{ id: 'gemini-cli', detected: false }]), 'gemini'],
    [{ status: async () => ({ status: 'unavailable', reason: 'offline' }) }, 'gemini']
  ]) {
    const connect = createClientInstaller({ paths: {}, installer, targets, install: () => assert.fail('no writes') });
    await assert.rejects(() => connect({ clientId }), /unavailable/);
  }
  let release;
  const connect = createClientInstaller({ paths: {}, installer: installerAnswer([{ id: 'gemini-cli' }]), targets,
    install: () => new Promise((resolve) => { release = resolve; }) });
  const first = connect({ clientId: 'gemini' });
  await assert.rejects(() => connect({ clientId: 'gemini' }), /already/);
  await new Promise(setImmediate);
  release({ status: 'partial', message: '/private/config' });
  assert.deepEqual(await first, { id: 'gemini', status: 'partial', restartRequired: false });
});
