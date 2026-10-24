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
import { historyEntries } from '../src/model-backends/settings-history-list.js';
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

// now: one second later on each read, from NOW, unless a test fixes the clock.
function stores(t, { historyPath, now = (ticks => () => new Date(NOW.getTime() + 1000 * ticks++))(0) } = {}) {
  const dir = directory();
  const configPath = join(dir, 'model-backends.json');
  const warnings = [];
  let trust = null;
  const history = createModelSettingsHistory({ path: historyPath ?? join(dir, 'model-settings-history.sqlite'),
    readConfig: () => readModelBackendConfig(configPath), readTrustRevision: role => trust.revision(role), now,
    warn: message => warnings.push(message) });
  const settings = createModelRoleSettings(configPath, { history });
  trust = createRoleTrust({ path: join(dir, 'model-trust.sqlite'), history, now, modelBackends: { operationSettings: () => null } });
  // More trust stores over the same files, as other processes would open them.
  const others = [];
  const trustStore = history => others[others.push(createRoleTrust({ path: join(dir, 'model-trust.sqlite'), history, now,
    modelBackends: { operationSettings: () => null } })) - 1];
  t.after(() => {
    for (const store of [history, trust, ...others]) store.close();
    removed(dir);
    if (historyPath) removed(join(historyPath, '..'));
  });
  const revision = () => configRevision(readModelBackendConfig(configPath));
  return { dir, configPath, history, settings, trust, trustStore, warnings, revision };
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

test('a save through one role records every role whose effective settings changed with it', (t) => {
  const s = stores(t);
  s.settings.save('bole', edit());
  s.settings.save('jefa', edit({ revision: s.revision() }));
  s.settings.save('tonborg', edit({ revision: s.revision(), connectionId: 'other' }));
  // Bole and Jefa share local-qwen; Tonborg names another connection.
  assert.deepEqual(s.settings.save('bole', edit({ revision: s.revision(), connection: { ...edit().connection, model: 'qwen-next' } })),
    { history: 'recorded' });
  const [bole] = recorded(s.history, 'bole');
  const [jefa] = recorded(s.history, 'jefa');
  assert.deepEqual([bole.via, bole.changes], [null, [{ field: 'connection.model', before: 'qwen-test', after: 'qwen-next' }]]);
  assert.deepEqual([jefa.via, jefa.changes], ['bole', [{ field: 'connection.model', before: 'qwen-test', after: 'qwen-next' }]]);
  assert.equal(jefa.toRevision, s.revision());
  assert.equal(recorded(s.history, 'tonborg').length, 1);
  // Jefa's own list is current: no marker of unrecorded changes.
  assert.deepEqual(s.history.list({ role: 'jefa' }).map(entry => entry.kind), ['settings', 'settings']);
});

test('a trust change whose commit fails records no history', { timeout: 30_000 }, (t) => {
  const s = stores(t);
  s.trust.acknowledgeWarning('tonborg', WARNING_VERSION, 0);
  // A reader holding the file shared makes the commit fail once the busy wait runs out.
  const reader = new DatabaseSync(join(s.dir, 'model-trust.sqlite'));
  try {
    reader.exec('BEGIN');
    reader.prepare('SELECT * FROM role_trust').all();
    assert.throws(() => s.trust.setSuggestionsOnly('tonborg', true, 1), /locked|busy/i);
  } finally {
    reader.exec('ROLLBACK');
    reader.close();
  }
  assert.equal(s.trust.revision('tonborg'), 1);
  assert.deepEqual(s.history.list({ role: 'tonborg' }).map(entry => entry.kind), ['warning_acknowledged']);
});

test('trust rows appended out of order are listed in revision order', (t) => {
  const s = stores(t);
  // The first process commits revision 1 but appends its row only after another process committed and appended revision 2.
  const appends = [];
  const slow = s.trustStore({ recordTrust: (...args) => { appends.push(args); return 'recorded'; } });
  const other = s.trustStore(s.history);
  slow.acknowledgeWarning('tonborg', WARNING_VERSION, 0);
  other.setSuggestionsOnly('tonborg', true, 1);
  s.history.recordTrust(...appends[0]);
  assert.deepEqual(recorded(s.history, 'tonborg').map(entry => entry.toRevision), ['2', '1']);
  assert.ok(recorded(s.history, 'tonborg')[0].changedAt > recorded(s.history, 'tonborg')[1].changedAt);
  assert.equal(s.history.list({ role: 'tonborg' })[0].kind, 'suggestions_only');
});

test('a trust change committed without its row shows as unrecorded changes, never as a change', (t) => {
  const s = stores(t);
  s.trust.acknowledgeWarning('tonborg', WARNING_VERSION, 0);
  assert.deepEqual(s.history.list({ role: 'tonborg' }).map(entry => entry.kind), ['warning_acknowledged']);
  // Committed, then the append failed (or the process stopped before it).
  const lost = s.trustStore({ recordTrust() { throw new Error('synthetic history failure'); } });
  assert.deepEqual(lost.setSuggestionsOnly('tonborg', true, 1), { history: 'not_recorded' });
  assert.equal(s.trust.revision('tonborg'), 2);
  assert.deepEqual(s.history.list({ role: 'tonborg' }).map(entry => entry.kind), ['unrecorded_changes', 'warning_acknowledged']);
  assert.deepEqual(s.history.list({ role: 'bole' }), []);
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
  // A switch to what is already set writes nothing, so the revision stays.
  assert.deepEqual(s.trust.view('tonborg', 'knowledge_review').revision, 2);
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

test('a read marks unrecorded changes, without naming a cause, and earlier changes that were never recorded', (t) => {
  const s = stores(t);
  // Configured before the history existed.
  writeFileSync(s.configPath, JSON.stringify({ version: 1, connections: { 'local-qwen': edit().connection },
    roles: { bole: { ...edit().settings, connection: 'local-qwen' } } }));
  assert.deepEqual(s.history.list({ role: 'bole' }), [{ kind: 'earlier_changes_not_recorded', changedAt: null, role: 'bole' }]);
  assert.deepEqual(s.history.list({ role: 'jefa' }), []);

  // The first recorded save starts from settings that existed before it, so earlier changes stay unrecorded.
  s.settings.save('bole', edit({ revision: s.revision(), settings: { ...edit().settings, fallbackToSession: true } }));
  assert.deepEqual(s.history.list({ role: 'bole' }).map(entry => entry.kind), ['settings', 'earlier_changes_not_recorded']);
  // Edited by hand: the newest recorded save no longer matches the file.
  const config = JSON.parse(readFileSync(s.configPath, 'utf8'));
  config.connections['local-qwen'].model = 'hand-edited';
  writeFileSync(s.configPath, JSON.stringify(config));
  assert.deepEqual(s.history.list({ role: 'bole' }).map(entry => [entry.kind, entry.changedAt === null]),
    [['unrecorded_changes', true], ['settings', false], ['earlier_changes_not_recorded', true]]);
  // The next console save starts from the file as it is now: the gap stays where it was.
  s.settings.save('bole', edit({ revision: s.revision() }));
  assert.deepEqual(s.history.list({ role: 'bole' }).map(entry => entry.kind),
    ['settings', 'unrecorded_gap', 'settings', 'earlier_changes_not_recorded']);
});

test('a first save whose record was lost leaves its earlier changes marked as not recorded', (t) => {
  const s = stores(t);
  createModelRoleSettings(s.configPath, { history: { recordSettings: () => 'not_recorded' } }).save('bole', edit());
  s.settings.save('bole', edit({ revision: s.revision(), connection: { ...edit().connection, model: 'qwen-next' } }));
  assert.deepEqual(s.history.list({ role: 'bole' }).map(entry => entry.kind), ['settings', 'earlier_changes_not_recorded']);
});

test('a save whose record failed shows as a break between the records around it', (t) => {
  const s = stores(t);
  s.settings.save('bole', edit());
  // The second save is written, but its record is lost.
  createModelRoleSettings(s.configPath, { history: { recordSettings: () => 'not_recorded' } })
    .save('bole', edit({ revision: s.revision(), settings: { ...edit().settings, fallbackToSession: true } }));
  s.settings.save('bole', edit({ revision: s.revision(), connection: { ...edit().connection, model: 'qwen-next' },
    settings: { ...edit().settings, fallbackToSession: true } }));
  assert.deepEqual(s.history.list({ role: 'bole' }).map(entry => entry.kind), ['settings', 'unrecorded_gap', 'settings']);
  assert.deepEqual(s.history.list({ role: 'bole' })[0].changes, [{ field: 'connection.model', before: 'qwen-test', after: 'qwen-next' }]);
});

test('a trust change whose record failed between two recorded ones shows as a break', (t) => {
  const s = stores(t);
  s.trust.acknowledgeWarning('tonborg', WARNING_VERSION, 0);
  s.trustStore({ recordTrust() { throw new Error('synthetic history failure'); } }).setSuggestionsOnly('tonborg', true, 1);
  s.trust.setSuggestionsOnly('tonborg', false, 2);
  assert.deepEqual(s.history.list({ role: 'tonborg' }).map(entry => [entry.kind, entry.toRevision ?? null]),
    [['suggestions_only', '3'], ['unrecorded_gap', null], ['warning_acknowledged', '1']]);
});

test('a first trust change whose record was lost after recording began shows as a break below the earliest record', (t) => {
  const s = stores(t);
  // Recording began with this save; Tonborg's trust was still at revision 0.
  s.settings.save('bole', edit());
  s.trustStore({ recordTrust() { throw new Error('synthetic history failure'); } }).acknowledgeWarning('tonborg', WARNING_VERSION, 0);
  s.trust.setSuggestionsOnly('tonborg', true, 1);
  assert.deepEqual(s.history.list({ role: 'tonborg' }).map(entry => [entry.kind, entry.toRevision ?? null]),
    [['suggestions_only', '2'], ['unrecorded_gap', null]]);
});

test('trust changes made before recording began are earlier changes, not a break', (t) => {
  const s = stores(t);
  // Changed while no history existed (an upgrade): the store's baseline is revision 1.
  s.trustStore(null).acknowledgeWarning('tonborg', WARNING_VERSION, 0);
  assert.deepEqual(s.history.list({ role: 'tonborg' }).map(entry => entry.kind), ['earlier_changes_not_recorded']);
  s.trust.setSuggestionsOnly('tonborg', true, 1);
  assert.deepEqual(s.history.list({ role: 'tonborg' }).map(entry => [entry.kind, entry.toRevision ?? null]),
    [['suggestions_only', '2'], ['earlier_changes_not_recorded', null]]);
  assert.deepEqual(s.history.list({ role: 'bole' }), []);
});

test('saves in the same millisecond list in the order they were saved, and the newest one is compared', (t) => {
  const s = stores(t, { now: () => NOW });
  for (const model of ['qwen-a', 'qwen-b', 'qwen-c', 'qwen-d']) {
    s.settings.save('bole', edit({ revision: s.revision(), connection: { ...edit().connection, model } }));
  }
  const entries = s.history.list({ role: 'bole' });
  assert.deepEqual(entries.map(entry => entry.changes.find(change => change.field === 'connection.model').after),
    ['qwen-d', 'qwen-c', 'qwen-b', 'qwen-a']);
  assert.ok(entries.every(entry => entry.changedAt === NOW.toISOString()));
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
  // One role and one plain decimal limit from 1 to 200 only.
  for (const query of ['?role=bole&role=jefa', '?role=__proto__', '?role=BOLE', '?limit=0', '?limit=', '?limit=-1', '?limit=1.5',
    '?limit=1e2', '?limit=0x10', '?limit=%205', '?limit=05', '?limit=201', '?limit=9007199254740993', '?limit=5&limit=1']) {
    assert.equal((await read(query)).status, 400, query);
  }
  assert.equal((await read('?limit=200')).status, 200);
  assert.doesNotMatch(JSON.stringify(all.body), /local-ref/);
  assert.equal((await put('/api/model-backends/history', {})).status, 405);
});

test('the history route answers 503 when no store is wired', async (t) => {
  const s = stores(t);
  const base = await route(t, { settingsHistory: null, s });
  assert.equal((await fetch(`${base}/api/model-backends/history`)).status, 503);
});

test('a save never throws after its file was written, even when its record or the warning throws', (t) => {
  const s = stores(t);
  const throwing = createModelRoleSettings(s.configPath, { history: { recordSettings() { throw new Error('synthetic throw'); } } });
  assert.deepEqual(throwing.save('bole', edit()), { history: 'not_recorded' });
  assert.equal(readModelBackendConfig(s.configPath).state, 'ok');
  // The store cannot open (a directory) and its warning output fails too.
  const loud = createModelSettingsHistory({ path: s.dir, readConfig: () => readModelBackendConfig(s.configPath),
    warn() { throw new Error('synthetic broken pipe'); } });
  assert.deepEqual(createModelRoleSettings(s.configPath, { history: loud }).save('jefa', edit({ revision: s.revision() })),
    { history: 'not_recorded' });
  assert.equal(readModelBackendConfig(s.configPath).config.roles.jefa.enabled, true);
});

test('a recorded change cannot be replaced under its id', (t) => {
  const s = stores(t);
  s.settings.save('bole', edit());
  const [row] = recorded(s.history, 'bole');
  s.history.close();
  const database = new DatabaseSync(join(s.dir, 'model-settings-history.sqlite'));
  try {
    assert.throws(() => database.prepare(`INSERT OR REPLACE INTO settings_changes
      VALUES(?, '1999-01-01T00:00:00.000Z', 'bole', 'settings', NULL, 'forged', '[]', NULL)`).run(row.changeId), /immutable/);
    assert.throws(() => database.exec('INSERT OR REPLACE INTO trust_baselines VALUES(\'bole\', 7)'), /immutable/);
    assert.deepEqual(database.prepare('SELECT to_revision FROM settings_changes').all().map(each => each.to_revision), [row.toRevision]);
  } finally { database.close(); }
});

// One instant: Tonborg's revision 1 is appended after its revision 2 and two saves.
function sameInstant(t) {
  const s = stores(t, { now: () => NOW });
  const deferred = [];
  s.trustStore({ recordTrust: (...args) => { deferred.push(args); return 'recorded'; } }).acknowledgeWarning('tonborg', WARNING_VERSION, 0);
  s.trust.setSuggestionsOnly('tonborg', true, 1);
  s.settings.save('tonborg', edit());
  s.settings.save('jefa', edit({ revision: s.revision() }));
  s.history.recordTrust(...deferred[0]);
  return s;
}

test('at one instant each role\'s trust rows keep revision order, with settings rows in save order', (t) => {
  const s = sameInstant(t);
  for (const role of [null, 'tonborg']) {
    const entries = s.history.list({ role }).filter(entry => entry.changedAt !== null);
    assert.deepEqual(entries.filter(entry => entry.kind !== 'settings').map(entry => entry.toRevision), ['2', '1'], String(role));
  }
  assert.deepEqual(s.history.list().map(entry => `${entry.role}:${entry.kind === 'settings' ? 'settings' : entry.toRevision}`),
    ['tonborg:2', 'jefa:settings', 'tonborg:settings', 'tonborg:1']);
});

test('the order is one total order: every permutation of the stored rows lists the same way', (t) => {
  const s = sameInstant(t);
  s.history.close();
  const database = new DatabaseSync(join(s.dir, 'model-settings-history.sqlite'));
  let rows;
  try { rows = database.prepare('SELECT rowid AS seq, * FROM settings_changes').all(); } finally { database.close(); }
  const permutations = items => (items.length < 2 ? [items]
    : items.flatMap((item, index) => permutations([...items.slice(0, index), ...items.slice(index + 1)]).map(rest => [item, ...rest])));
  const read = stored => JSON.stringify(historyEntries({ stored, roles: ['assistant', 'bole', 'jefa', 'tonborg'], role: null,
    baseline: () => 0, loaded: readModelBackendConfig(s.configPath), limit: 50, readTrustRevision: role => s.trust.revision(role) }));
  const expected = read(rows);
  assert.equal(rows.length, 4);
  for (const permutation of permutations(rows)) assert.equal(read(permutation), expected);
});

test('a limit never cuts one save across roles in two', (t) => {
  const s = stores(t);
  s.settings.save('bole', edit());
  s.settings.save('jefa', edit({ revision: s.revision() }));
  s.settings.save('tonborg', edit({ revision: s.revision() }));
  // One save that changes Bole, Jefa and Tonborg through their shared connection.
  s.settings.save('bole', edit({ revision: s.revision(), connection: { ...edit().connection, model: 'shared-edit' } }));
  assert.deepEqual(s.history.list({ limit: 1 }).map(entry => [entry.role, entry.via]),
    [['bole', null], ['jefa', 'bole'], ['tonborg', 'bole']]);
  assert.deepEqual(s.history.list({ limit: 2 }).map(entry => entry.role), ['bole', 'jefa', 'tonborg', 'tonborg']);
});
