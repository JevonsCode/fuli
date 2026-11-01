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
    targets: () => [{ id: 'codex' }, { id: 'claude-code' }, { id: 'gemini' }, { id: 'antigravity' },
      { id: 'opencode', manualOnly: true, manualUrl: 'https://opencode.ai/docs/config/' }],
    customClients: { removable: () => new Set(['acme-agent']) },
    historyPath,
    now: () => new Date(clock += 60_000),
    ...options
  });
  return { home, make, historyPath, answer: (clients) => { answer = { status: 'available', clients, extensionErrors: [] }; },
    unavailable: () => { answer = { status: 'unavailable', reason: 'offline' }; } };
}
const byId = (result, id) => result.clients.find((client) => client.id === id);

test('installer states map to FULI\'s client statuses, under FULI\'s client IDs', async (t) => {
  const { make, answer } = fixture(t);
  answer([
    installerClient('codex', { state: 'connected', components: [state('mcp', 'current'), state('skills', 'current')] }),
    installerClient('claude-code', { state: 'update_available', components: [state('mcp', 'outdated'), state('hooks', 'current')] }),
    installerClient('gemini-cli', { name: 'Gemini CLI' }),
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
  assert.equal(result.scope, 'configuration');
});

test('a built-in client FULI has no writer for is the person\'s to connect', async (t) => {
  const { make, answer } = fixture(t);
  answer([installerClient('kiro')]);
  assert.equal(byId(await make().observe(), 'kiro').manualOnly, true);
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
