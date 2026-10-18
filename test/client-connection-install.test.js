import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { createClientInstaller } from '../src/system/client-connection-install.js';
import { adapter } from '../src/setup/agents/gemini/index.js';

test('one-click connection validates a discovered ID, backs up before writing and self-checks', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'fuli-connect-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const agent = adapter.detect({ homeDir: home, pathApi: posix, fileExists: () => false, commandExists: () => true });
  mkdirSync(join(home, '.gemini'));
  const original = '{"theme":"dark"}';
  writeFileSync(agent.configPath, original);
  const paths = { backupDir: join(home, 'backups'), mcpServerPath: '/pkg/mcp.js', graphRuntimeConfigPath: '/data/runtime.json' };
  const connect = createClientInstaller({ paths, discover: () => [agent] });
  for (const input of [null, {}, { clientId: 'unknown' }, { clientId: 'gemini', configPath: '/bad' }, { clientId: '__proto__' }]) {
    await assert.rejects(() => connect(input));
  }
  assert.equal(readFileSync(agent.configPath, 'utf8'), original);
  const result = await connect({ clientId: 'gemini' });
  assert.deepEqual(result, { id: 'gemini', status: 'connected', restartRequired: true });
  assert.equal(readFileSync(join(paths.backupDir, readdirSync(paths.backupDir)[0]), 'utf8'), original);
  assert.ok(!JSON.stringify(result).includes(home));
  assert.equal((await connect({ clientId: 'gemini' })).status, 'connected');
});

test('manual/absent clients never write and simultaneous requests cannot overlap', async () => {
  for (const agent of [{ id: 'opencode', available: true, manualOnly: true }, { id: 'gemini', available: false }]) {
    const connect = createClientInstaller({ paths: {}, discover: () => [agent], install: () => assert.fail('no writes') });
    await assert.rejects(() => connect({ clientId: agent.id }));
  }
  let release;
  const connect = createClientInstaller({ paths: {}, discover: () => [{ id: 'gemini', available: true }],
    install: () => new Promise((resolve) => { release = resolve; }) });
  const first = connect({ clientId: 'gemini' });
  await assert.rejects(() => connect({ clientId: 'gemini' }), /already/);
  release({ status: 'partial', message: '/private/config' });
  assert.deepEqual(await first, { id: 'gemini', status: 'partial', restartRequired: false });
});

import { discoverAgents } from '../src/setup/agents.js';
import { createClientConnectionObserver } from '../src/system/client-connection-status.js';
import { existsSync } from 'node:fs';
test('new client removal retains the previously connected row and history', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'fuli-removed-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const context = { nodePath: 'node', mcpServerPath: 'mcp.js', runtimeConfigPath: 'runtime.json' };
  const discover = (options) => discoverAgents({ ...options, platform: 'linux', env: {}, homeDir: home,
    fileExists: existsSync, commandExists: () => false }).filter(({ id }) => id === 'gemini');
  const agent = discover({ includeUnavailable: true }).find(({ id }) => id === 'gemini');
  adapter.connect(agent, context);
  const observer = createClientConnectionObserver({ discover, context, historyPath: join(home, 'observations.json') });
  assert.equal(observer.observe().clients.find(({ id }) => id === 'gemini').status, 'connected');
  rmSync(agent.configPath);
  const removed = observer.observe().clients.find(({ id }) => id === 'gemini');
  assert.equal(removed.status, 'removed');
  assert.equal(removed.detected, false);
  const restarted = createClientConnectionObserver({ discover, context, historyPath: join(home, 'observations.json') });
  assert.equal(restarted.observe().clients.find(({ id }) => id === 'gemini').previouslyConnected, true);
});
