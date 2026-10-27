import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { createRoundtableStore } from '../packages/roundtable/src/roundtable/store.js';
import { runMigrateCommand } from '../src/cli/migrate-command.js';
import { writeFirstReleaseAgentApps } from './fixtures/agent-apps-first-release.js';

// rec#17 D-09: `fuli migrate status` is read only. Every fixture is
// synthetic; each test hashes the whole data directory before and after.

function dataDir(t) {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-migrate-status-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function sqlite(path, sql) {
  mkdirSync(join(path, '..'), { recursive: true });
  const database = new DatabaseSync(path);
  database.exec(sql);
  database.close();
}

function json(path, value) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

// Every file and its bytes; a new -wal/-shm or backup shows up as a new name.
function snapshot(root, { skip = () => false } = {}) {
  const files = {};
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (!skip(entry.name)) files[relative(root, path)] = createHash('sha256').update(readFileSync(path)).digest('hex');
    }
  };
  walk(root);
  return files;
}

const GRAPH_REPORT = { store: 'graph', kind: 'neo4j', version: 8, target: 10, state: 'pending_confirmation', ledger: [],
  steps: [{ id: 'graph/9-group-id-separators', state: 'pending_confirmation', detail: '1 records need this step' }] };

async function status(root, { json: asJson = true, fetchImpl } = {}) {
  const lines = [];
  const result = await runMigrateCommand(['status', ...(asJson ? ['--json'] : []), '--data-dir', root],
    { env: {}, write: (line) => lines.push(line), fetchImpl: fetchImpl ?? (async (url) => {
      assert.equal(url, 'http://127.0.0.1:1/health/data-format');
      return new Response(JSON.stringify(GRAPH_REPORT), { status: 200 });
    }) });
  return { ...result, output: lines.join('\n') };
}

const byLabel = (report) => Object.fromEntries(report.stores.map((store) => [store.label, store]));

function legacyDataDir(root) {
  json(join(root, 'graph-runtime.json'), { version: 1, personal: { providerUrl: 'http://127.0.0.1:1' }, workspaces: [] });
  // Unversioned, from the first Agent app release, with apps: a backfill waits for a person.
  writeFirstReleaseAgentApps(join(root, 'agent-apps', 'registry.sqlite'));
  // Unversioned WAL store with no live log: read as immutable, no -wal/-shm left.
  sqlite(join(root, 'agent-roundtable.sqlite'), `PRAGMA journal_mode = WAL;
    CREATE TABLE threads(id TEXT PRIMARY KEY, space_id TEXT NOT NULL, project_id TEXT, subject TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`);
  // Written by a newer FULI.
  sqlite(join(root, 'judgment.sqlite'), 'CREATE TABLE judgment_settings(space TEXT); PRAGMA user_version = 9;');
  // A migration that started and never finished.
  sqlite(join(root, 'model-usage.sqlite'), `CREATE TABLE fuli_format_ledger(seq INTEGER PRIMARY KEY AUTOINCREMENT,
      migration_id TEXT NOT NULL, from_version INTEGER NOT NULL, to_version INTEGER NOT NULL, kind TEXT NOT NULL,
      status TEXT NOT NULL, backup_ref TEXT, detail TEXT, recorded_at TEXT NOT NULL);
    INSERT INTO fuli_format_ledger(migration_id, from_version, to_version, kind, status, recorded_at)
      VALUES('model-usage/2-synthetic', 1, 2, 'rewrite', 'started', 'synthetic');
    PRAGMA user_version = 1;`);
  json(join(root, 'external-knowledge', 'bindings.json'), { version: 1, bindings: [] });
  json(join(root, 'runtime-settings.json'), { version: 2 });
  json(join(root, 'capture-policy.json'), { version: 2, enabled: true });
  json(join(root, 'capture-session-pause', 'a.json'), { version: 1 });
  json(join(root, 'capture-session-pause', 'b.json'), { version: 3 });
  json(join(root, 'capture-session-pause', 'pins', 'on', 'c.json'), { version: 1, sourceApplication: 'codex' });
  json(join(root, 'capture-session-pause', 'pins', 'off', 'd.json'), { version: 2, sourceApplication: 'codex' });
}

test('status reports legacy, pending, newer and half-applied stores without changing a byte', async (t) => {
  const root = dataDir(t);
  legacyDataDir(root);
  const before = snapshot(root);

  const { exitCode, output } = await status(root);
  const text = await status(root, { json: false });

  assert.deepEqual(snapshot(root), before);
  assert.equal(exitCode, 0);
  const stores = byLabel(JSON.parse(output));
  assert.equal(stores['agent-apps/registry.sqlite'].state, 'pending_confirmation');
  assert.deepEqual(stores['agent-apps/registry.sqlite'].steps.map((step) => [step.id, step.state]), [
    ['agent-apps/1-baseline', 'detected'], ['agent-apps/2-approval-presence', 'automatic'],
    ['agent-apps/3-presence-challenges', 'automatic'], ['agent-apps/4-owner-lease', 'automatic'],
    ['agent-apps/5-instances', 'automatic'], ['agent-apps/6-token-instance', 'automatic'],
    ['agent-apps/7-identity-keys', 'pending_confirmation']]);
  assert.equal(stores['agent-roundtable.sqlite'].state, 'upgrade_on_open');
  assert.equal(stores['agent-roundtable.sqlite'].steps[0].state, 'automatic');
  assert.deepEqual([stores['judgment.sqlite'].state, stores['judgment.sqlite'].version], ['newer_format', 9]);
  assert.equal(stores['model-usage.sqlite'].state, 'half_applied');
  assert.deepEqual(stores['model-usage.sqlite'].steps.map((step) => step.id), ['model-usage/2-synthetic']);
  assert.deepEqual(stores['model-usage.sqlite'].ledger.map((entry) => entry.status), ['started']);
  assert.equal(stores['external-knowledge/bindings.json'].state, 'pending_confirmation');
  assert.equal(stores['external-knowledge/bindings.json'].steps[0].id, 'external-knowledge/2-binding-targets');
  assert.equal(stores['runtime-settings.json'].state, 'newer_format');
  assert.equal(stores['capture-policy.json'].state, 'current');
  assert.equal(stores['capture-session-pause'].state, 'newer_format');
  assert.equal(stores['capture-session-pause/pins/on'].state, 'current');
  assert.equal(stores['capture-session-pause/pins/off'].state, 'newer_format');
  assert.equal(stores['role-work.sqlite'].state, 'absent');
  assert.equal(stores['graph (personal)'].state, 'pending_confirmation');
  assert.match(text.output, /step agent-apps\/7-identity-keys: pending_confirmation/);
  assert.match(text.output, /step graph\/9-group-id-separators: pending_confirmation/);
  assert.doesNotMatch(output + text.output, /sentinel/, 'no record content is reported');
});

test('a store opened and migrated by FULI reports current with its ledger', async (t) => {
  const root = dataDir(t);
  const live = createRoundtableStore(join(root, 'agent-roundtable.sqlite'));
  let output;
  try {
    // The live store's WAL index is shared memory readers use; the files are compared.
    const before = snapshot(root, { skip: (name) => name.endsWith('-shm') });
    ({ output } = await status(root, { fetchImpl: async () => { throw new Error('offline'); } }));
    assert.deepEqual(snapshot(root, { skip: (name) => name.endsWith('-shm') }), before);
  } finally { live.close(); }
  const store = byLabel(JSON.parse(output))['agent-roundtable.sqlite'];
  assert.deepEqual([store.state, store.version, store.target], ['current', 4, 4]);
  assert.deepEqual(store.ledger.map((entry) => [entry.migrationId, entry.status]), [['roundtable/created', 'created']]);
});

test('a store that cannot be read without writing fails the command and stays untouched', async (t) => {
  const root = dataDir(t);
  json(join(root, 'graph-runtime.json'), { version: 1, personal: { providerUrl: 'http://127.0.0.1:1' }, workspaces: [] });
  const path = join(root, 'judgment.sqlite');
  sqlite(path, 'PRAGMA journal_mode = WAL; CREATE TABLE judgment_settings(space TEXT);');
  // A write-ahead log without its index: reading it would create the index.
  writeFileSync(`${path}-wal`, '');
  const before = snapshot(root);

  const { exitCode, output } = await status(root, { json: false });

  assert.equal(exitCode, 2);
  assert.match(output, /judgment\.sqlite .* unavailable .*write-ahead log has no index/);
  assert.match(output, /Could not read judgment\.sqlite without writing; nothing was changed\./);
  assert.deepEqual(snapshot(root), before);
});

test('a graph whose provider is not running is reported, not guessed', async (t) => {
  const root = dataDir(t);
  json(join(root, 'graph-runtime.json'), { version: 1, personal: { providerUrl: 'http://127.0.0.1:1' }, workspaces: [] });

  const { exitCode, output } = await status(root, { fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });

  assert.equal(exitCode, 2);
  const graph = byLabel(JSON.parse(output))['graph (personal)'];
  assert.deepEqual([graph.state, graph.note], ['unavailable', 'its provider is not answering; start FULI to inspect the graph']);
  assert.ok(statSync(join(root, 'graph-runtime.json')));
});
