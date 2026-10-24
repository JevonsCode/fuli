import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { mapHttpError } from '../src/http/error-mapping.js';
import { configRevision, readModelBackendConfig } from '../src/model-backends/config.js';
import { handleModelBackendApiRequest } from '../src/model-backends/http.js';
import { createModelRoleSettings } from '../src/model-backends/role-settings.js';
import { createRoleTrust } from '../src/model-backends/role-trust.js';
import { createModelSettingsHistory } from '../src/model-backends/settings-history.js';
import { listenFetchableServer } from '../src/server/listen.js';
import { WARNING_VERSION } from './fixtures/model-trust.js';

// rec#11 D-42: what changed in a role's model settings and execution mode,
// and when. Synthetic settings in a temporary directory only.

const NOW = new Date('2026-10-24T09:00:00.000Z');

function edit(overrides = {}) {
  return {
    revision: null,
    connectionId: 'local-qwen',
    connection: { protocol: 'openai_chat', endpoint: 'http://127.0.0.1:11434/v1', model: 'qwen-test', secretRef: 'local-ref',
      reasoningEffort: null, pricing: null },
    settings: { enabled: true, allowedOperations: ['knowledge_review'], egress: { approvedProjects: [], allowUnassigned: false },
      budget: { maxInputTokens: 4000, maxOutputTokens: 400, timeoutMs: 30_000, windowHours: 24, maxTokensPerWindow: 100_000,
        maxCostPerWindow: null }, fallbackToSession: false },
    ...overrides
  };
}

// Removed after the stores that use it are closed.
const directory = () => mkdtempSync(join(tmpdir(), 'fuli-model-history-'));
const removed = path => rmSync(path, { recursive: true, force: true });

function stores(t, { historyPath } = {}) {
  const dir = directory();
  const configPath = join(dir, 'model-backends.json');
  const warnings = [];
  const history = createModelSettingsHistory({ path: historyPath ?? join(dir, 'model-settings-history.sqlite'),
    readConfig: () => readModelBackendConfig(configPath), now: () => NOW, warn: message => warnings.push(message) });
  const settings = createModelRoleSettings(configPath, { history });
  const trust = createRoleTrust({ path: join(dir, 'model-trust.sqlite'), history, now: () => NOW,
    modelBackends: { operationSettings: () => null } });
  t.after(() => { history.close(); trust.close(); removed(dir); if (historyPath) removed(join(historyPath, '..')); });
  const revision = () => configRevision(readModelBackendConfig(configPath));
  return { dir, configPath, history, settings, trust, warnings, revision };
}

const recorded = (history, role) => history.list({ role }).filter(entry => entry.changedAt !== null);

test('a settings save records the fields it changed, a key reference only as changed, and nothing when nothing changed', (t) => {
  const s = stores(t);
  assert.deepEqual(s.settings.save('tonborg', edit()), { history: 'recorded' });
  const [created] = recorded(s.history, 'tonborg');
  assert.equal(created.kind, 'settings');
  assert.equal(created.changedAt, NOW.toISOString());
  assert.equal(created.fromRevision, null);
  assert.equal(created.toRevision, s.revision());
  const fields = Object.fromEntries(created.changes.map(change => [change.field, change]));
  assert.deepEqual(fields['settings.enabled'], { field: 'settings.enabled', before: null, after: true });
  assert.deepEqual(fields['settings.budget.maxOutputTokens'], { field: 'settings.budget.maxOutputTokens', before: null, after: 400 });
  assert.deepEqual(fields['connection.model'], { field: 'connection.model', before: null, after: 'qwen-test' });
  assert.deepEqual(fields['connection.secretRef'], { field: 'connection.secretRef', changed: true });
  assert.doesNotMatch(JSON.stringify(created), /local-ref/);

  const first = s.revision();
  assert.deepEqual(s.settings.save('tonborg', edit({ revision: first,
    connection: { ...edit().connection, model: 'qwen-next' },
    settings: { ...edit().settings, budget: { ...edit().settings.budget, maxOutputTokens: 800 } } })), { history: 'recorded' });
  const [changed] = recorded(s.history, 'tonborg');
  assert.deepEqual(changed.changes, [
    { field: 'settings.budget.maxOutputTokens', before: 400, after: 800 },
    { field: 'connection.model', before: 'qwen-test', after: 'qwen-next' }
  ]);
  assert.deepEqual([changed.fromRevision, changed.toRevision], [first, s.revision()]);

  // The same settings again: saved, nothing recorded.
  const current = s.revision();
  assert.deepEqual(s.settings.save('tonborg', edit({ revision: current, connection: { ...edit().connection, model: 'qwen-next' },
    settings: { ...edit().settings, budget: { ...edit().settings.budget, maxOutputTokens: 800 } } })), { history: 'unchanged' });
  assert.equal(recorded(s.history, 'tonborg').length, 2);

  // Another connection: the switch, its fields, and the key reference as changed only.
  s.settings.save('tonborg', edit({ revision: current, connectionId: 'cloud', connection: { protocol: 'anthropic_messages',
    endpoint: 'https://api.example.test/v1', model: 'qwen-next', secretRef: 'cloud-ref', reasoningEffort: null, pricing: null } }));
  const [switched] = recorded(s.history, 'tonborg');
  assert.deepEqual(switched.changes, [
    { field: 'settings.budget.maxOutputTokens', before: 800, after: 400 },
    { field: 'connection', before: 'local-qwen', after: 'cloud' },
    { field: 'connection.protocol', before: 'openai_chat', after: 'anthropic_messages' },
    { field: 'connection.endpoint', before: 'http://127.0.0.1:11434/v1', after: 'https://api.example.test/v1' },
    { field: 'connection.secretRef', changed: true }
  ]);
  assert.doesNotMatch(JSON.stringify(s.history.list()), /local-ref|cloud-ref/);
  assert.deepEqual(s.warnings, []);
});

test('recorded changes cannot be updated or deleted', (t) => {
  const s = stores(t);
  s.settings.save('bole', edit());
  s.history.close();
  const database = new DatabaseSync(join(s.dir, 'model-settings-history.sqlite'));
  try {
    assert.throws(() => database.exec('UPDATE settings_changes SET role = \'jefa\''), /immutable/);
    assert.throws(() => database.exec('DELETE FROM settings_changes'), /immutable/);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM settings_changes').get().count, 1);
  } finally { database.close(); }
});

test('a trust switch and a warning acknowledgement record their row revisions; a repeated switch records nothing', (t) => {
  const s = stores(t);
  assert.deepEqual(s.trust.acknowledgeWarning('tonborg', WARNING_VERSION, 0), { history: 'recorded' });
  assert.deepEqual(s.trust.setSuggestionsOnly('tonborg', true, 1), { history: 'recorded' });
  assert.deepEqual(s.trust.setSuggestionsOnly('tonborg', true, 2), { history: 'unchanged' });
  assert.deepEqual(recorded(s.history, 'tonborg').map(({ kind, fromRevision, toRevision, changes }) =>
    ({ kind, fromRevision, toRevision, changes })), [
    { kind: 'suggestions_only', fromRevision: '1', toRevision: '2', changes: [{ field: 'suggestionsOnly', before: false, after: true }] },
    { kind: 'warning_acknowledged', fromRevision: '0', toRevision: '1',
      changes: [{ field: 'warningVersion', before: null, after: WARNING_VERSION }] }
  ]);
  assert.deepEqual(s.trust.view('tonborg', 'knowledge_review').revision, 3);
});

test('a change whose history cannot be written stays saved and answers not_recorded', (t) => {
  const historyPath = join(directory(), 'not-a-file');
  mkdirSync(historyPath);
  const s = stores(t, { historyPath });
  assert.deepEqual(s.settings.save('jefa', edit()), { history: 'not_recorded' });
  assert.equal(readModelBackendConfig(s.configPath).config.roles.jefa.enabled, true);
  assert.deepEqual(s.trust.setSuggestionsOnly('tonborg', true, 0), { history: 'not_recorded' });
  assert.equal(s.trust.view('tonborg', 'knowledge_review').suggestionsOnly, true);
  assert.equal(s.warnings.length, 2);
  assert.match(s.warnings[0], /settings change of jefa was saved, but its change history was not recorded/);
});

test('a read marks changes made outside the console and earlier changes that were never recorded', (t) => {
  const s = stores(t);
  // Configured before the history existed.
  writeFileSync(s.configPath, JSON.stringify({ version: 1, connections: { 'local-qwen': edit().connection },
    roles: { bole: { ...edit().settings, connection: 'local-qwen' } } }));
  assert.deepEqual(s.history.list({ role: 'bole' }), [{ kind: 'earlier_changes_not_recorded', changedAt: null, role: 'bole' }]);
  assert.deepEqual(s.history.list({ role: 'jefa' }), []);

  s.settings.save('bole', edit({ revision: s.revision(), settings: { ...edit().settings, fallbackToSession: true } }));
  assert.deepEqual(s.history.list({ role: 'bole' }).map(entry => entry.kind), ['settings']);
  // Edited by hand: the newest recorded save no longer matches the file.
  const config = JSON.parse(readFileSync(s.configPath, 'utf8'));
  config.connections['local-qwen'].model = 'hand-edited';
  writeFileSync(s.configPath, JSON.stringify(config));
  assert.deepEqual(s.history.list({ role: 'bole' }).map(entry => [entry.kind, entry.changedAt === null]),
    [['changed_outside_console', true], ['settings', false]]);
  // The next console save starts from the file as it is now.
  s.settings.save('bole', edit({ revision: s.revision() }));
  assert.deepEqual(s.history.list({ role: 'bole' }).map(entry => entry.kind), ['settings', 'settings']);
});

test('a read is newest first, filtered by role and limited, and creates no file', (t) => {
  const s = stores(t);
  assert.deepEqual(s.history.list(), []);
  assert.throws(() => readFileSync(join(s.dir, 'model-settings-history.sqlite')), { code: 'ENOENT' });
  s.settings.save('bole', edit());
  s.settings.save('jefa', edit({ revision: s.revision() }));
  s.trust.setSuggestionsOnly('tonborg', true, 0);
  assert.deepEqual(s.history.list().map(entry => entry.role), ['tonborg', 'jefa', 'bole']);
  assert.deepEqual(s.history.list({ limit: 2 }).map(entry => entry.role), ['tonborg', 'jefa']);
  assert.deepEqual(s.history.list({ role: 'bole' }).map(entry => entry.role), ['bole']);
});

async function route(t, { settingsHistory, s }) {
  const server = createHttpServer(async (request, response) => {
    try {
      if (!await handleModelBackendApiRequest({ request, response, url: new URL(request.url, 'http://local'),
        modelBackends: { roles: () => ({ state: 'ok', roles: [], connections: {} }), localBuild: () => null },
        roleSettings: s.settings, modelTrust: s.trust, automaticOperations: { tonborg: 'knowledge_review' },
        settingsHistory })) response.writeHead(404).end();
    } catch (error) {
      const mapped = mapHttpError(error);
      response.writeHead(mapped.status, { 'content-type': 'application/json' }).end(JSON.stringify(mapped.body));
    }
  });
  await listenFetchableServer(server, 0);
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('the history route reads by role and limit, GET only, and each save answers whether it was recorded', async (t) => {
  const s = stores(t);
  const base = await route(t, { settingsHistory: s.history, s });
  const put = (path, body) => fetch(`${base}${path}`, { method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body) });
  assert.equal((await (await put('/api/model-backends/roles/bole', edit())).json()).history, 'recorded');
  assert.equal((await (await put('/api/model-backends/roles/tonborg/trust', { expectedRevision: 0, suggestionsOnly: true })).json())
    .history, 'recorded');
  assert.equal((await (await put('/api/model-backends/roles/tonborg/trust', { expectedRevision: 1, suggestionsOnly: true })).json())
    .history, 'unchanged');

  const read = async query => {
    const response = await fetch(`${base}/api/model-backends/history${query}`);
    return { status: response.status, body: await response.json() };
  };
  const all = await read('');
  assert.equal(all.status, 200);
  assert.deepEqual(all.body.entries.map(entry => [entry.role, entry.kind]), [['tonborg', 'suggestions_only'], ['bole', 'settings']]);
  assert.deepEqual((await read('?role=bole')).body.entries.map(entry => entry.role), ['bole']);
  assert.deepEqual((await read('?limit=1')).body.entries.map(entry => entry.role), ['tonborg']);
  assert.equal((await read('?role=astro')).status, 400);
  assert.equal((await read('?limit=0')).status, 400);
  assert.doesNotMatch(JSON.stringify(all.body), /local-ref/);
  assert.equal((await put('/api/model-backends/history', {})).status, 405);
});

test('the history route answers 503 when no store is wired', async (t) => {
  const s = stores(t);
  const base = await route(t, { settingsHistory: null, s });
  assert.equal((await fetch(`${base}/api/model-backends/history`)).status, 503);
});
