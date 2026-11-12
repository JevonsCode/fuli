import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createClientConnectionObserver } from '../src/system/client-connection-status.js';

// agent-installer's answers are synthetic; only a temporary history file is written.
const state = (component, value, paths) => ({ component, state: value, ...(paths ? { paths } : {}) });
function installerClient(id, { name = id, builtin = true, detected = true, state: clientState = 'not_connected',
  components = [state('mcp', 'missing')], platformSupported = true } = {}) {
  return { id, name, builtin, detected, evidence: [], components: components.map(({ component }) => component),
    platformSupported, state: clientState, componentStates: components };
}

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'fuli-client-status-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  let clock = Date.parse('2026-10-13T08:00:00Z');
  let answer = { status: 'available', clients: [], extensionErrors: [] };
  const historyPath = join(home, 'data', 'client-connection-observations.json');
  const make = (options = {}) => createClientConnectionObserver({
    installer: { status: async () => answer },
    customClients: { removable: () => new Set(['acme-agent']) },
    historyPath,
    now: () => new Date(clock += 60_000),
    ...options
  });
  return { home, make, historyPath, answer: (clients) => { answer = { status: 'available', clients, extensionErrors: [] }; },
    unavailable: () => { answer = { status: 'unavailable', reason: 'offline' }; } };
}
const byId = (result, id) => result.clients.find((client) => client.id === id);

test('installer states map to FULI\'s client statuses', async (t) => {
  const { make, answer } = fixture(t);
  answer([
    installerClient('codex', { state: 'connected', components: [state('mcp', 'current'), state('skills', 'current')] }),
    installerClient('claude-code', { state: 'update_available', components: [state('mcp', 'outdated'), state('hooks', 'current')] }),
    installerClient('gemini', { name: 'Gemini CLI' }),
    installerClient('antigravity', { name: 'Antigravity', detected: false }),
    installerClient('claude-desktop', { platformSupported: false, state: 'unsupported', components: [] }),
    installerClient('opencode', { state: 'manual' })
  ]);
  const result = await make().observe();
  assert.equal(result.available, true);
  assert.deepEqual(result.clients.map(({ id, status }) => [id, status]), [['codex', 'connected'], ['claude-code', 'changed'],
    ['gemini', 'not_connected'], ['antigravity', 'not_detected'], ['opencode', 'not_connected']]);
  assert.equal(byId(result, 'gemini').label, 'Gemini CLI');
  assert.deepEqual(byId(result, 'claude-code').components, { mcp: 'outdated', hooks: 'current' });
  assert.equal(byId(result, 'codex').manualOnly, false);
  assert.equal(byId(result, 'opencode').manualOnly, true);
  assert.equal(byId(result, 'opencode').manualUrl, 'https://opencode.ai/docs/config/');
  // The client as FULI's other records name it, so the console matches client links without its own mapping.
  assert.deepEqual([byId(result, 'codex').sourceApplication, byId(result, 'claude-code').sourceApplication, byId(result, 'gemini').sourceApplication],
    ['codex', 'claude_code', null]);
  assert.equal(result.scope, 'configuration');
});

test('DeepSeek Harness, which has no MCP file, is told apart by its plugin bundle', async (t) => {
  const { make, answer } = fixture(t);
  const dsh = (pluginState, skillsState, clientState) => installerClient('dsh', { name: 'DeepSeek Harness', state: clientState,
    components: [state('mcp', 'unsupported'), state('skills', skillsState), state('plugin', pluginState)] });
  answer([dsh('outdated', 'current', 'update_available')]);
  const outdated = byId(await make().observe(), 'dsh');
  assert.equal(outdated.status, 'changed');
  assert.equal(outdated.sourceApplication, 'dsh');
  answer([dsh('current', 'current', 'connected')]);
  assert.equal(byId(await make().observe(), 'dsh').status, 'connected');
  answer([dsh('missing', 'missing', 'not_connected')]);
  assert.equal(byId(await make().observe(), 'dsh').status, 'removed');
  // Another product's plugins/fuli: FULI cannot call it its own, so it is unknown, not an update to retry.
  answer([dsh('conflict', 'current', 'conflict')]);
  assert.equal(byId(await make().observe(), 'dsh').status, 'unknown');
});

test('every built-in client agent-installer writes is FULI\'s to connect; only its manual ones are the person\'s', async (t) => {
  const { make, answer } = fixture(t);
  answer([installerClient('kiro'), installerClient('qwen-code', { state: 'manual' })]);
  const result = await make().observe();
  assert.deepEqual([byId(result, 'kiro').manualOnly, byId(result, 'qwen-code').manualOnly], [false, true]);
  assert.equal(byId(result, 'qwen-code').manualUrl, undefined);
});

test('leftover Skills, a removal and an unreadable entry are told apart, with bounded history', async (t) => {
  const { make, answer, historyPath } = fixture(t);
  const observer = make();
  answer([installerClient('codex', { state: 'update_available', components: [state('mcp', 'outdated')] })]);
  assert.equal(byId(await observer.observe(), 'codex').status, 'changed');
  answer([installerClient('codex', { state: 'update_available', components: [state('mcp', 'conflict'), state('skills', 'current')] })]);
  const unknown = byId(await observer.observe(), 'codex');
  assert.equal(unknown.status, 'unknown');
  assert.equal(unknown.lastKnownStatus, 'changed');
  assert.deepEqual(unknown.changes, [], 'an unreadable entry records no transition');
  answer([installerClient('codex', { state: 'update_available', components: [state('mcp', 'missing'), state('skills', 'outdated')] })]);
  assert.equal(byId(await observer.observe(), 'codex').status, 'skills_left');
  answer([installerClient('codex')]);
  // A fresh observer reads persisted history, as after a console restart.
  const removed = byId(await make().observe(), 'codex');
  assert.equal(removed.status, 'removed');
  assert.equal(removed.previouslyConnected, true);
  assert.deepEqual(removed.changes.map(({ from, to }) => [from, to]), [['changed', 'skills_left'], ['skills_left', 'removed']]);
  for (let index = 0; index < 8; index += 1) {
    answer([installerClient('codex', index % 2 ? {} : { state: 'connected', components: [state('mcp', 'current')] })]);
    await observer.observe();
  }
  assert.equal(byId(await observer.observe(), 'codex').changes.length, 5);
  writeFileSync(historyPath, 'not json');
  answer([installerClient('codex', { detected: false })]);
  const fresh = byId(await make().observe(), 'codex');
  assert.deepEqual([fresh.status, fresh.previouslyConnected, fresh.changes], ['not_detected', false, []]);
});

test('stored history is rebuilt from allowed fields and nothing else leaves', async (t) => {
  const { make, answer, historyPath } = fixture(t);
  mkdirSync(join(historyPath, '..'), { recursive: true });
  writeFileSync(historyPath, JSON.stringify({ version: 1, clients: {
    codex: { status: 'removed', previouslyConnected: true, since: 'SYNTHETIC_BAD_TIME', extra: 'SYNTHETIC_EXTRA',
      changes: [{ from: 'SYNTHETIC_UNSAFE_FIELD', to: 'removed', detectedAt: 'invalid' }] },
    'claude-code': { status: 'removed', previouslyConnected: 'yes', since: null, changes: null },
    SYNTHETIC_CLIENT: { status: 'connected', previouslyConnected: true }
  } }));
  answer([installerClient('codex', { detected: false }), installerClient('claude-code', { detected: false })]);
  const result = await make().observe();
  assert.equal(JSON.stringify(result).includes('SYNTHETIC'), false);
  assert.deepEqual([byId(result, 'codex').status, byId(result, 'codex').since], ['removed', null]);
  assert.equal(byId(result, 'claude-code').status, 'not_detected', 'a removal without a proven connection is not trusted');
});

test('an observation that cannot be saved is kept for this observer and reported as unsaved', async (t) => {
  const { home, make, answer } = fixture(t);
  writeFileSync(join(home, 'blocked'), '');
  const observer = make({ historyPath: join(home, 'blocked', 'client-connection-observations.json') });
  answer([installerClient('codex', { state: 'update_available', components: [state('mcp', 'outdated')] })]);
  assert.equal((await observer.observe()).historySaved, false);
  answer([installerClient('codex')]);
  const removed = await observer.observe();
  assert.equal(removed.historySaved, false);
  assert.equal(byId(removed, 'codex').status, 'removed', 'the just-observed connection is not forgotten');
});

test('clients described by hand are listed apart, with where their MCP entry goes', async (t) => {
  const { make, answer } = fixture(t);
  answer([
    installerClient('codex'),
    installerClient('acme-agent', { name: 'Acme Agent', builtin: false,
      components: [state('mcp', 'current', ['~/.acme/mcp.json'])], state: 'connected' }),
    installerClient('team-client', { name: 'Team', builtin: false, detected: false,
      components: [state('mcp', 'missing', ['~/.team/mcp.json']), state('hooks', 'unsupported')] })
  ]);
  const result = await make().observe();
  assert.deepEqual(result.clients.map(({ id }) => id), ['codex']);
  assert.deepEqual(result.customClients, [
    { id: 'acme-agent', label: 'Acme Agent', detected: true, status: 'connected', mcpPaths: ['~/.acme/mcp.json'], removable: true },
    { id: 'team-client', label: 'Team', detected: false, status: 'not_detected', mcpPaths: ['~/.team/mcp.json'], removable: false }
  ]);
});

test('without agent-installer nothing is claimed about any client', async (t) => {
  const { make, unavailable, historyPath } = fixture(t);
  unavailable();
  const result = await make().observe();
  assert.deepEqual({ ...result, observedAt: undefined }, { scope: 'configuration', observedAt: undefined, available: false,
    historySaved: true, clients: [], customClients: [] });
  assert.equal(existsSync(historyPath), false, 'no history is written from nothing');
});

test('a connected client says how many open sessions wait for a restart', async (t) => {
  const { make, answer } = fixture(t);
  answer([installerClient('claude-code', { state: 'connected', components: [state('mcp', 'current'), state('skills', 'current')] }),
    installerClient('codex', { state: 'connected', components: [state('mcp', 'current')] })]);
  const result = await make({ awaitingRestart: () => [{ sourceApplication: 'claude_code', count: 2 }] }).observe();
  assert.equal(byId(result, 'claude-code').status, 'connected');
  assert.equal(byId(result, 'claude-code').restartSessions, 2);
  assert.equal(byId(result, 'codex').restartSessions, 0);
});
