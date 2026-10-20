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
import { EmployeeManagementStore } from '../src/employees/management-policy.js';
import { JudgmentStore } from '../src/judgment/store.js';
import { RoleWorkStore } from '../src/model-backends/role-work-store.js';
import { ModelUsageLedger } from '../src/model-backends/usage-ledger.js';
import { TaskScheduleStore } from '../src/task-schedules/store.js';

// rec#17 D-09: every local store and the format it declares. The graph's
// counterpart is graph-provider/tests/test_graph_format.py.
const FINGERPRINTS = new URL('./fixtures/data-format-fingerprints.json', import.meta.url);

// Each SQLite store, opened through its own public entry point.
const SQLITE_STORES = {
  'agent-apps': (path) => { const store = new AgentAppStore(path); void store.database; return () => store.close(); },
  'employee-management': (path) => {
    const store = new EmployeeManagementStore(path); store.read('space', 'template'); return () => store.close();
  },
  judgment: (path) => { const store = new JudgmentStore(path); return () => store.close(); },
  'model-usage': (path) => { const store = new ModelUsageLedger(path); void store.db; return () => store.close(); },
  'peer-coordinator': (path) => { const store = createCoordinatorStore(path); return () => store.close(); },
  'peer-node': (path) => { const store = createNodeStore(path); return () => store.close(); },
  'role-work': (path) => { const store = new RoleWorkStore(path); void store.db; return () => store.close(); },
  roundtable: (path) => { const store = createRoundtableStore(path); return () => store.close(); },
  standalone: (path) => { const store = createStandaloneStore(path); return () => store.close(); },
  'task-schedules': (path) => { const store = new TaskScheduleStore(path); return () => store.close(); }
};

// The first shipped schema of each store that has migrations, as an earlier
// FULI left it: no version, no ledger, none of the later columns or tables.
const FIRST_RELEASES = {
  'task-schedules': `CREATE TABLE task_schedules(id TEXT PRIMARY KEY, space TEXT NOT NULL, project TEXT NOT NULL,
      revision INTEGER NOT NULL, enabled INTEGER NOT NULL, body TEXT NOT NULL, next_run_at TEXT NOT NULL,
      paused_reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE task_schedule_runs(schedule TEXT NOT NULL, slot TEXT NOT NULL, task_id TEXT,
      status TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(schedule, slot));`,
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
  ['packages/roundtable/src/storage/sqlite-format.js', 'the format engine'],
  ['packages/roundtable/src/storage/sqlite-backup-process.js', 'the online backup the engine runs before a migration'],
  ['src/storage/file-lock.js', 'cross-process lock files with no tables'],
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
  ['src/storage/json-format.js', 'the versioned writer itself'],
  ['src/agents/codex/lifecycle-hooks.js', 'Codex hook configuration, owned by the client'],
  ['src/setup/agents/json-mcp.js', 'MCP client configuration, owned by each client'],
  ['src/setup/claude-code-config.js', 'Claude Code configuration, owned by the client'],
  ['src/setup/claude-desktop-config.js', 'Claude Desktop configuration, owned by the client'],
  ['src/setup/cursor-config.js', 'Cursor configuration, owned by the client'],
  ['src/setup/codex-config.js', 'Codex configuration and hooks, owned by the client'],
  ['src/setup/codex-bootstrap.js', 'Codex configuration, owned by the client'],
  ['src/desktop/windows-installation-switch.js', 'installation record and shortcuts, checked by content before each replace'],
  ['src/desktop/windows-update-runtime.js', 'a byte snapshot of the installation record, restored as it was'],
  ['src/native-runtime/neo4j-lifecycle.js', 'Neo4j runtime manifest and journal; store versions are checked by neo4j-store-formats.js'],
  ['src/native-runtime/runtime.js', 'Neo4j process state of the running console'],
  ['src/setup/graph-runtime.js', 'console process state; the graph runtime config it writes is versioned'],
  ['src/system/settings-apply.js', 'the settings operation journal, and the graph runtime config restored exactly as it was read'],
  ['src/conversations/transcript-capture-gap.js',
    'per-session capture cursor: a record it cannot match only makes the session skip, never import']
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
