import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { createCoordinatorStore } from '../packages/roundtable/src/peer/coordinator-store.js';
import { createNodeStore } from '../packages/roundtable/src/peer/node-store.js';
import { createRoundtableStore } from '../packages/roundtable/src/roundtable/store.js';
import { createStandaloneStore } from '../packages/roundtable/src/standalone/store.js';
import { AgentAppStore } from '../src/agent-apps/store.js';
import { localStoreFiles } from '../src/data-format/local-stores.js';
import { EmployeeManagementStore } from '../src/employees/management-policy.js';
import { JefaBoardStore } from '../src/employees/builtin/jefa/board-store.js';
import { JudgmentStore } from '../src/judgment/store.js';
import { createRoleTrust } from '../src/model-backends/role-trust.js';
import { RoleWorkStore } from '../src/model-backends/role-work-store.js';
import { createModelSettingsHistory } from '../src/model-backends/settings-history.js';
import { RoleSuggestionLog } from '../src/model-backends/suggestion-log.js';
import { ModelUsageLedger } from '../src/model-backends/usage-ledger.js';
import { createStandingAssignments } from '../src/standing-assignments/port.js';
import { AGENT_APPS_FIRST_RELEASE } from './fixtures/agent-apps-first-release.js';

// rec#17 D-09: every local store and the format it declares. The graph's
// counterpart is graph-provider/tests/test_graph_format.py.
const FINGERPRINTS = new URL('./fixtures/data-format-fingerprints.json', import.meta.url);

// Each SQLite store, opened through its own public entry point.
const SQLITE_STORES = {
  'agent-apps': (path) => { const store = new AgentAppStore(path); void store.database; return () => store.close(); },
  'employee-management': (path) => {
    const store = new EmployeeManagementStore(path); store.read('space', 'template'); return () => store.close();
  },
  'jefa-board': (path) => { const store = new JefaBoardStore(path); void store.database; return () => store.close(); },
  judgment: (path) => { const store = new JudgmentStore(path); return () => store.close(); },
  'model-trust': (path) => {
    const store = createRoleTrust({ path, modelBackends: {} }); store.setSuggestionsOnly('tonborg', false, 0); return () => store.close();
  },
  'model-settings-history': (path) => {
    const store = createModelSettingsHistory({ path, readConfig: () => ({ state: 'absent' }) });
    store.recordTrust('tonborg', 'suggestions_only', 0, { field: 'suggestionsOnly', before: false, after: true });
    return () => store.close();
  },
  'model-usage': (path) => { const store = new ModelUsageLedger(path); void store.db; return () => store.close(); },
  'peer-coordinator': (path) => { const store = createCoordinatorStore(path); return () => store.close(); },
  'peer-node': (path) => { const store = createNodeStore(path); return () => store.close(); },
  'role-work': (path) => { const store = new RoleWorkStore(path); void store.db; return () => store.close(); },
  'role-suggestions': (path) => { const store = new RoleSuggestionLog(path); void store.db; return () => store.close(); },
  roundtable: (path) => { const store = createRoundtableStore(path); return () => store.close(); },
  standalone: (path) => { const store = createStandaloneStore(path); return () => store.close(); },
  'standing-assignments': (path) => {
    const store = createStandingAssignments({ path });
    store.register({ personalSpaceId: 'space', projectId: 'project', leadAgentId: 'agent', terms: ['synthetic'],
      responsibility: 'Synthetic work', source: 'user' });
    return () => store.close();
  }
};

// The first shipped schema of each store that has migrations, as an earlier
// FULI left it: no version, no ledger, none of the later columns or tables.
const FIRST_RELEASES = {
  // rec#7 part 1, before presence checks: an approval with presence only.
  'agent-apps': AGENT_APPS_FIRST_RELEASE,
  roundtable: `CREATE TABLE threads (id TEXT PRIMARY KEY, space_id TEXT NOT NULL, project_id TEXT, subject TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE messages (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id), seq INTEGER NOT NULL,
      kind TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL, in_reply_to TEXT,
      from_agent TEXT, from_name TEXT, from_client TEXT, from_session TEXT,
      to_agent TEXT, to_name TEXT, to_client TEXT, to_session TEXT,
      via TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(thread_id, seq));
    INSERT INTO threads VALUES('t1', 'space', NULL, 'Synthetic thread', 'x', 'x');`,
  'peer-coordinator': `CREATE TABLE messages (id TEXT PRIMARY KEY, sender_node TEXT NOT NULL, target_node TEXT NOT NULL,
      binding_id TEXT NOT NULL, assertion_json TEXT NOT NULL, signature TEXT NOT NULL, status TEXT NOT NULL,
      attempt_id TEXT, accepted_attempt TEXT, start_attempts INTEGER NOT NULL DEFAULT 0, lease_expires_at TEXT,
      cancel_requested INTEGER NOT NULL DEFAULT 0, reply TEXT, error TEXT, via TEXT, verified INTEGER,
      expires_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`,
  'model-usage': `CREATE TABLE model_attempts(
        request_id TEXT NOT NULL, attempt_id TEXT NOT NULL, attempt_number INTEGER NOT NULL,
        purpose TEXT NOT NULL CHECK(purpose IN ('initial', 'retry', 'repair', 'format_fallback')),
        channel TEXT NOT NULL CHECK(channel IN ('model_api', 'session')),
        role TEXT NOT NULL, operation TEXT NOT NULL, personal_space_id TEXT NOT NULL, personal_project_id TEXT,
        connection_id TEXT, protocol TEXT, endpoint_host TEXT, requested_model TEXT, actual_model TEXT, output_mode TEXT,
        started_at TEXT NOT NULL, duration_ms INTEGER NOT NULL,
        outcome TEXT NOT NULL CHECK(outcome IN ('succeeded', 'failed', 'invalid_output')),
        failure_class TEXT, failure_reason TEXT,
        input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER, cached_input_tokens INTEGER,
        cache_write_input_tokens INTEGER, reasoning_tokens INTEGER, usage_definition TEXT,
        budget_ceiling_tokens INTEGER NOT NULL, estimated_cost REAL, cost_currency TEXT,
        PRIMARY KEY(request_id, attempt_id));
      CREATE INDEX model_attempts_role_time ON model_attempts(role, started_at);
      CREATE TABLE model_reservations(
        request_id TEXT NOT NULL, attempt_id TEXT NOT NULL, role TEXT NOT NULL, started_at TEXT NOT NULL,
        expires_at TEXT NOT NULL, ceiling_tokens INTEGER NOT NULL, ceiling_cost REAL, pending_attempt TEXT NOT NULL,
        PRIMARY KEY(request_id, attempt_id));
      CREATE INDEX model_reservations_role_time ON model_reservations(role, started_at);
      CREATE TRIGGER model_attempts_no_update BEFORE UPDATE ON model_attempts
        BEGIN SELECT RAISE(ABORT, 'model attempts are immutable'); END;
      CREATE TRIGGER model_attempts_no_delete BEFORE DELETE ON model_attempts
        BEGIN SELECT RAISE(ABORT, 'model attempts are immutable'); END;
    INSERT INTO model_attempts VALUES('r1', 'a1', 1, 'initial', 'model_api', 'bole', 'pick', 'space', NULL, 'local',
      'openai_chat', '127.0.0.1:11434', 'synthetic-model', 'synthetic-model', 'json_schema', 'x', 1, 'succeeded', NULL, NULL,
      1, 1, 2, NULL, NULL, NULL, 'openai_chat', 2, NULL, NULL);`,
  'peer-node': `CREATE TABLE shares (binding_id TEXT PRIMARY KEY, space_id TEXT NOT NULL, project_id TEXT NOT NULL,
      agent_id TEXT NOT NULL, clients_json TEXT NOT NULL, working_directory TEXT, created_at TEXT NOT NULL, revoked_at TEXT);
    INSERT INTO shares VALUES('b1', 'space', 'project', 'agent', '[]', NULL, 'x', NULL);`
};

function temporaryStore(t, name) {
  const directory = mkdtempSync(join(tmpdir(), `fuli-format-${name}-`));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, `${name}.sqlite`);
}

// Layout of the CREATE text does not matter, its content does.
const statement = (sql) => String(sql ?? '').replace(/\s+/g, ' ').replace(/\s*([(),])\s*/g, '$1').trim();

// The declared schema as SQLite stored it, without the ledger the engine owns.
function format(path) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const schema = database.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%' AND tbl_name <> 'fuli_format_ledger' ORDER BY type, name`).all()
      .map((row) => [row.type, row.name, row.tbl_name, statement(row.sql)]);
    return { version: database.prepare('PRAGMA user_version').get().user_version,
      fingerprint: createHash('sha256').update(JSON.stringify(schema)).digest('hex') };
  } finally { database.close(); }
}

test('each SQLite store keeps the schema its version declares', (t) => {
  const expected = JSON.parse(readFileSync(FINGERPRINTS, 'utf8')).sqlite;
  const actual = {};
  for (const [store, open] of Object.entries(SQLITE_STORES)) {
    const path = temporaryStore(t, store);
    open(path)();
    actual[store] = format(path);
  }
  assert.deepEqual(actual, expected, 'A schema change needs a registered migration and the next version: '
    + 'add it to the store\'s sqliteFormat() declaration, then record only the new version here. '
    + 'A shipped version\'s fingerprint never changes.');
});

// The roundtable package's standalone store lives outside a FULI data directory.
test('every SQLite store of a data directory is in its registry, so migrate status and backups see it', () => {
  const registered = localStoreFiles('data').filter((store) => store.kind === 'sqlite');
  assert.deepEqual(registered.map((store) => store.format.store).sort(),
    Object.keys(SQLITE_STORES).filter((store) => store !== 'standalone').sort());
  assert.equal(registered.find((store) => store.format.store === 'model-settings-history').label, 'model-settings-history.sqlite');
});

test('a store from its first release upgrades to exactly the schema a fresh store gets', (t) => {
  for (const [store, firstRelease] of Object.entries(FIRST_RELEASES)) {
    const fresh = temporaryStore(t, `${store}-fresh`);
    SQLITE_STORES[store](fresh)();
    const upgraded = temporaryStore(t, `${store}-upgraded`);
    const old = new DatabaseSync(upgraded);
    old.exec(firstRelease);
    old.close();
    SQLITE_STORES[store](upgraded)();
    assert.deepEqual(format(upgraded), format(fresh), store);
  }
});

const SOURCE_ROOTS = ['src', 'packages/roundtable/src'];
function sources(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return sources(path);
    return extname(entry.name) === '.js' ? [path] : [];
  });
}
const SOURCE_FILES = SOURCE_ROOTS.flatMap(sources).map((path) => [path, readFileSync(path, 'utf8')]);

// Opening SQLite outside the format engine, or changing a schema anywhere but
// a store's declaration, would bypass the version check.
const SQLITE_OUTSIDE_FORMATS = new Map([
  ['packages/roundtable/src/storage/database-format.js', 'the format engine'],
  ['packages/roundtable/src/storage/database-backup-process.js', 'the online backup the engine runs before a migration'],
  ['packages/roundtable/src/storage/database-migration.js',
    'the confirmed apply, undo and restore of a declared store, and its undo table'],
  ['src/storage/file-lock.js', 'cross-process lock files with no tables'],
  ['src/data-format/maintenance-lock.js', 'the shared/exclusive maintenance lock file of a data directory, no data'],
  ['packages/roundtable/src/roundtable/chat-store.js', 'the chat tables of the roundtable and peer-coordinator formats'],
  ['packages/roundtable/src/roundtable/attention-inbox-store.js', 'the attention tables of the roundtable format']
]);

test('SQLite is opened and shaped only through a declared store format', () => {
  const offenders = SOURCE_FILES.flatMap(([path, source]) => {
    if (SQLITE_OUTSIDE_FORMATS.has(path)) return [];
    const opens = /new DatabaseSync\(/.test(source);
    const shapes = /\b(?:CREATE|ALTER|DROP)\s+(?:TABLE|INDEX|UNIQUE INDEX|TRIGGER)\b/.test(source);
    return opens || (shapes && !source.includes('sqliteFormat({')) ? [path] : [];
  });
  assert.deepEqual(offenders, []);
});

// FULI's JSON data files refuse to overwrite a newer FULI's file
// (writeVersionedJsonFileAtomic). These write JSON that is not FULI data.
const UNVERSIONED_JSON_WRITERS = new Map([
  ['src/setup/agents/client-pack-change.js', 'client-owned configuration and byte backups; package state uses the versioned client-packs store'],
  ['src/storage/json-format.js', 'the versioned writer itself'],
  ['src/agents/directory-snapshots.js', 'generated Markdown views and their manifest, regenerated from the database'],
  ['src/conversations/transcript-guard.js', 'a hook\'s per-session handoff state that expires within a minute'],
  ['src/agents/codex/lifecycle-hooks.js', 'Codex hook configuration, owned by the client'],
  ['src/setup/agents/json-mcp.js', 'MCP client configuration, owned by each client'],
  ['src/setup/claude-code-config.js', 'Claude Code configuration, owned by the client'],
  ['src/setup/claude-desktop-config.js', 'Claude Desktop configuration, owned by the client'],
  ['src/setup/cursor-config.js', 'Cursor configuration, owned by the client'],
  ['src/setup/agents/opencode/config-writer.js', 'OpenCode configuration and FULI\'s plugin file, owned by the client'],
  ['src/setup/codex-config.js', 'Codex configuration and hooks, owned by the client'],
  ['src/setup/codex-bootstrap.js', 'Codex configuration, owned by the client'],
  ['src/desktop/windows-installation-switch.js', 'installation record and shortcuts, checked by content before each replace'],
  ['src/desktop/windows-update-runtime.js', 'a byte snapshot of the installation record, restored as it was'],
  ['src/native-runtime/neo4j-lifecycle.js', 'Neo4j runtime manifest and journal; store versions are checked by neo4j-store-formats.js'],
  ['src/native-runtime/runtime.js', 'Neo4j process state of the running console'],
  ['src/setup/graph-runtime.js', 'console process state; the graph runtime config it writes is versioned'],
  ['src/system/settings-apply.js', 'the settings operation journal, and the graph runtime config restored exactly as it was read'],
  ['src/system/detached-job.js', 'the journal of a console operation that restarts FULI (a restore, an update), read back afterwards'],
  ['src/graphiti/capture-policy.js',
    'its plain writes of the settings and their generation run only inside updateVersionedJsonFileAtomic, under the format lock and guard'],
  ['src/graphiti/capture-session-pause.js',
    'its plain write runs only inside updateVersionedJsonFileAtomic, under the format lock and guard'],
  ['src/model-backends/role-settings.js',
    'its plain write of model-backends.json runs only inside updateVersionedJsonFileAtomic, under the format lock and guard']
]);

test('every JSON data file FULI writes is written through the format guard', () => {
  const offenders = SOURCE_FILES
    .filter(([path, source]) => /\bwrite(?:Json|Text)FileAtomic\b/.test(source)
      && !UNVERSIONED_JSON_WRITERS.has(path)
      && path !== 'src/storage/json-file.js')
    .map(([path]) => path);
  assert.deepEqual(offenders, [], 'Write FULI data with writeVersionedJsonFileAtomic and a store name, '
    + 'or list the file here with the reason it is not FULI data');
});
