import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { callAgentTool } from '../src/agent-tools.js';
import { interfaceForRequest, interfaceForRoute } from '../src/agent-tools/interface-catalog.js';
import { handleOldDataRequest } from '../src/http/old-data-api-router.js';
import { createOldDataConsole } from '../src/old-data/console-actions.js';
import { createOldDataShelf } from '../src/old-data/port.js';
import { resolveSetupPaths } from '../src/setup/paths.js';
import { reachableModules } from '../test-support/module-graph.js';

// rec#80 group B 旧数据: the copies FULI keeps before a change, listed with
// their sizes, read read-only by the person's AI, restored or deleted in the
// console. Synthetic data directories only.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_BYTES = 10_000_000;
const SQLITE_BACKUP = 'format-backups/judgment.sqlite.v1-2026-11-01T08-00-00-000Z.sqlite';
const JSON_BACKUP = 'format-backups/runtime-settings.json.v2-2026-11-02T08-00-00-000Z.json';
const NEO4J_EXPORT = 'backups/graph/before-neo4j-5.26.28-2026-10-30T09-00-00-000Z';

function dataDirectory(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'fuli-old-data-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  return { dataDir, paths: resolveSetupPaths({ dataDir, platform: 'linux', env: {}, homeDir: dataDir }) };
}

function write(dataDir, path, content, at = null) {
  const file = join(dataDir, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  if (at) utimesSync(file, new Date(at), new Date(at));
  return file;
}

// One of each kind FULI writes, plus what is not old data.
function filledDirectory(t) {
  const directory = dataDirectory(t);
  const { dataDir } = directory;
  write(dataDir, SQLITE_BACKUP, Buffer.from([0x53, 0x51, 0, 1, 2, 3]));
  write(dataDir, JSON_BACKUP, '{"version":2,"ports":{"console":2727}}\n');
  write(dataDir, 'format-operations.json', JSON.stringify({ version: 1, events: [{ kind: 'applied',
    store: 'judgment', label: 'judgment.sqlite', backupRef: SQLITE_BACKUP, fromVersion: 1, toVersion: 2,
    at: '2026-11-01T08:00:01.000Z' }] }));
  write(dataDir, `${NEO4J_EXPORT}/manifest.json`, JSON.stringify({ format: 'fuli-neo4j-backup', version: 1,
    createdAt: '2026-10-30T09:00:00.000Z', instances: [{ id: 'personal', file: 'personal.dump' }] }));
  write(dataDir, `${NEO4J_EXPORT}/personal.dump`, Buffer.alloc(64 * 1024, 1));
  write(dataDir, 'backups/graph/container-to-native-2026-09-01/personal.dump', 'x', '2026-09-01T00:00:00.000Z');
  write(dataDir, 'backups/graph/unfinished.partial-1234/personal.dump', 'x');
  write(dataDir, 'backups/settings/runtime-settings-2026-10-01T00-00-00-000Z.json', '{"ports":{}}',
    '2026-10-01T00:00:00.000Z');
  write(dataDir, 'backups/agents/codex/legacy-hooks/hooks.json-2026-10-02', '{"hooks":{}}');
  for (const [path, at] of [['backups/graph/container-to-native-2026-09-01', '2026-09-01'], ['backups/agents/codex', '2026-10-02']]) {
    utimesSync(join(dataDir, path), new Date(at), new Date(at));
  }
  write(dataDir, 'logs/runtime.log', 'current\n');
  write(dataDir, 'logs/runtime.log.1', 'older\n'.repeat(8000), '2026-10-20T00:00:00.000Z');
  write(dataDir, 'logs/runtime.log.2', 'oldest\n', '2026-10-10T00:00:00.000Z');
  return directory;
}

function shelfFor(paths, measured = []) {
  return createOldDataShelf({ paths, measure: async (path) => { measured.push(path); return DATA_BYTES; } });
}

test('an empty data directory has no old data and all of it is live', async (t) => {
  const { paths } = dataDirectory(t);
  const listed = await shelfFor(paths).list();
  assert.deepEqual(listed.items, []);
  assert.deepEqual({ ...listed.summary, measuredAt: undefined },
    { liveBytes: DATA_BYTES, oldBytes: 0, totalBytes: DATA_BYTES, measuredAt: undefined });
});

test('every kind is listed with what left it, its size and whether the console restores it', async (t) => {
  const { paths } = filledDirectory(t);
  const measured = [];
  const shelf = shelfFor(paths, measured);
  const { items, summary } = await shelf.list();

  assert.deepEqual(items.map(({ id, kind, restorable, restoreCommand }) => ({ id, kind, restorable, restoreCommand })), [
    { id: `format_backup:${JSON_BACKUP}`, kind: 'format_backup', restorable: true, restoreCommand: null },
    { id: `format_backup:${SQLITE_BACKUP}`, kind: 'format_backup', restorable: true, restoreCommand: null },
    { id: `graph_export:${NEO4J_EXPORT}`, kind: 'graph_export', restorable: false,
      restoreCommand: 'fuli graph import --input <folder>' },
    { id: 'log_archive:logs/runtime.log', kind: 'log_archive', restorable: false, restoreCommand: null },
    { id: 'client_config_backup:backups/agents/codex', kind: 'client_config_backup', restorable: false, restoreCommand: null },
    { id: 'settings_backup:backups/settings/runtime-settings-2026-10-01T00-00-00-000Z.json', kind: 'settings_backup',
      restorable: false, restoreCommand: null },
    { id: 'graph_export:backups/graph/container-to-native-2026-09-01', kind: 'graph_export', restorable: false,
      restoreCommand: null }
  ]);
  const byId = new Map(items.map((item) => [item.id, item]));
  assert.equal(byId.get(`format_backup:${SQLITE_BACKUP}`).left.zh, '升级数据格式前的 judgment.sqlite（v1→v2）');
  assert.equal(byId.get(`format_backup:${JSON_BACKUP}`).left.en, 'runtime-settings.json before a data format change (v2)');
  assert.equal(byId.get(`format_backup:${SQLITE_BACKUP}`).createdAt, '2026-11-01T08:00:00.000Z');
  assert.equal(byId.get(`graph_export:${NEO4J_EXPORT}`).left.zh, '升级 Neo4j 5.26.28 前的图谱');
  assert.equal(byId.get(`graph_export:${NEO4J_EXPORT}`).createdAt, '2026-10-30T09:00:00.000Z');
  assert.equal(byId.get('log_archive:logs/runtime.log').createdAt, '2026-10-20T00:00:00.000Z');
  // Newest first; no absolute path leaves the port.
  assert.deepEqual(items.map(({ createdAt }) => createdAt), items.map(({ createdAt }) => createdAt).sort().reverse());
  // Sizes are the disk each takes, as the data directory is measured: a tiny file may take none.
  assert.ok(items.every((item) => Number.isSafeInteger(item.bytes) && !('targets' in item) && !item.path.startsWith('/')));
  assert.ok(byId.get(`graph_export:${NEO4J_EXPORT}`).bytes >= 64 * 1024);

  assert.equal(summary.oldBytes, items.reduce((sum, item) => sum + item.bytes, 0));
  assert.equal(summary.liveBytes, DATA_BYTES - summary.oldBytes);
  assert.equal(summary.totalBytes, DATA_BYTES);
  // The data directory is measured once a minute, again after a change.
  await shelf.list();
  assert.equal(measured.length, 1);
  shelf.forgetMeasurement();
  await shelf.list();
  assert.deepEqual(measured, [paths.dataDir, paths.dataDir]);
});

test('the live size never goes below zero when the old data outweighs a stale measurement', async (t) => {
  const { paths } = filledDirectory(t);
  const { summary } = await createOldDataShelf({ paths, measure: async () => 1 }).list();
  assert.equal(summary.liveBytes, 0);
  assert.equal(summary.totalBytes, summary.oldBytes);
});

test('the person\'s AI reads a backup\'s listed text files only, bounded', async (t) => {
  const { dataDir, paths } = filledDirectory(t);
  const app = { oldData: shelfFor(paths) };
  const read = (input) => callAgentTool(app, 'read_old_data', input);

  const listed = await read({});
  assert.equal(listed.items.length, 7);
  const exported = await read({ id: `graph_export:${NEO4J_EXPORT}` });
  assert.deepEqual(exported.files.map(({ path }) => path), ['manifest.json', 'personal.dump']);
  assert.equal(exported.item.kind, 'graph_export');
  assert.match((await read({ id: `graph_export:${NEO4J_EXPORT}`, path: 'manifest.json' })).content, /fuli-neo4j-backup/);
  const logs = await read({ id: 'log_archive:logs/runtime.log' });
  assert.deepEqual(logs.files.map(({ path }) => path), ['runtime.log.1', 'runtime.log.2']);
  assert.equal((await read({ id: `format_backup:${JSON_BACKUP}`, path: JSON_BACKUP.split('/')[1] })).content,
    '{"version":2,"ports":{"console":2727}}\n');

  for (const [input, code] of [
    [{ id: `graph_export:${NEO4J_EXPORT}`, path: 'personal.dump' }, 'old_data_binary'],
    [{ id: `format_backup:${SQLITE_BACKUP}`, path: SQLITE_BACKUP.split('/')[1] }, 'old_data_binary'],
    [{ id: `graph_export:${NEO4J_EXPORT}`, path: '../../../judgment.sqlite' }, 'old_data_file_not_found'],
    [{ id: 'log_archive:logs/runtime.log', path: 'runtime.log' }, 'old_data_file_not_found'],
    [{ id: 'graph_export:judgment.sqlite' }, 'old_data_not_found'],
    [{ path: 'manifest.json' }, 'invalid_input']
  ]) {
    await assert.rejects(read(input), (error) => error.code === code, JSON.stringify(input));
  }

  // A text file with a NUL byte is binary; a long one is cut at 32 KB without half a character.
  write(dataDir, 'backups/agents/codex/legacy-hooks/config.toml-2026-10-02', 'a\u0000b');
  await assert.rejects(read({ id: 'client_config_backup:backups/agents/codex', path: 'legacy-hooks/config.toml-2026-10-02' }),
    (error) => error.code === 'old_data_binary');
  write(dataDir, 'backups/agents/codex/settings.json-2026-10-03', `x${'记'.repeat(20_000)}`);
  const long = await read({ id: 'client_config_backup:backups/agents/codex', path: 'settings.json-2026-10-03' });
  assert.equal(long.truncated, true);
  assert.ok(Buffer.byteLength(long.content) <= 32 * 1024);
  assert.equal(long.content.includes('�'), false);
  assert.equal(long.bytes, 1 + 3 * 20_000);
});

test('恢复 runs the console\'s whole-store restore for a format backup and nothing else', async (t) => {
  const { paths } = filledDirectory(t);
  const calls = [];
  const restore = {
    describe: (label, ref) => { calls.push(['describe', label, ref]); return { currentDigest: 'digest-now' }; },
    start: (input) => { calls.push(['start', input]); return { id: 'r1', status: 'stopping' }; }
  };
  const actions = createOldDataConsole({ shelf: shelfFor(paths), restore });

  assert.deepEqual(await actions.restore(`format_backup:${SQLITE_BACKUP}`),
    { id: `format_backup:${SQLITE_BACKUP}`, restore: { id: 'r1', status: 'stopping' } });
  assert.deepEqual(calls, [['describe', 'judgment.sqlite', SQLITE_BACKUP],
    ['start', { label: 'judgment.sqlite', backupRef: SQLITE_BACKUP, currentDigest: 'digest-now' }]]);
  await assert.rejects(actions.restore(`graph_export:${NEO4J_EXPORT}`),
    (error) => error.code === 'old_data_not_restorable' && /fuli graph import/.test(error.message));
  await assert.rejects(actions.restore('log_archive:logs/runtime.log'), (error) => error.code === 'old_data_not_restorable');
  await assert.rejects(createOldDataConsole({ shelf: shelfFor(paths) }).restore(`format_backup:${SQLITE_BACKUP}`),
    (error) => error.code === 'old_data_not_restorable');
  assert.equal(calls.length, 2);
});

test('立即删除 removes one item, keeps a log and a backup an undo needs, and logs a format backup', async (t) => {
  const { dataDir, paths } = filledDirectory(t);
  const shelf = shelfFor(paths);
  const actions = createOldDataConsole({ shelf, now: () => new Date('2026-11-04T00:00:00.000Z') });

  const log = await actions.delete('log_archive:logs/runtime.log');
  assert.ok(log.freedBytes > 0);
  assert.equal(existsSync(join(dataDir, 'logs/runtime.log')), true);
  assert.equal(existsSync(join(dataDir, 'logs/runtime.log.1')), false);
  await actions.delete(`graph_export:${NEO4J_EXPORT}`);
  assert.equal(existsSync(join(dataDir, NEO4J_EXPORT)), false);

  await actions.delete(`format_backup:${SQLITE_BACKUP}`);
  assert.equal(existsSync(join(dataDir, SQLITE_BACKUP)), false);
  const events = JSON.parse(readFileSync(join(dataDir, 'format-operations.json'), 'utf8')).events;
  assert.deepEqual(events.at(-1), { kind: 'pruned', store: 'judgment', label: 'judgment.sqlite', backupRef: SQLITE_BACKUP,
    version: 1, bytes: events.at(-1).bytes, reason: 'deleted now by the person', at: '2026-11-04T00:00:00.000Z' });

  // An interrupted change still names its own backup, so pruning keeps every one; so does delete-now.
  write(dataDir, 'runtime-settings.json.format-intent.json', '{}');
  await assert.rejects(actions.delete(`format_backup:${JSON_BACKUP}`), (error) => error.code === 'old_data_needed');
  assert.equal(existsSync(join(dataDir, JSON_BACKUP)), true);
  assert.deepEqual((await shelf.list()).items.map(({ kind }) => kind).sort(),
    ['client_config_backup', 'format_backup', 'graph_export', 'settings_backup']);
});

function response() {
  return { headers: {}, setHeader(name, value) { this.headers[name] = value; },
    writeHead(status) { this.status = status; return this; }, end(body) { this.body = body ? JSON.parse(body) : null; } };
}

function request(method, remoteAddress = '127.0.0.1') {
  return { method, headers: {}, socket: { remoteAddress } };
}

async function route(method, path, options, remoteAddress) {
  const answer = response();
  const handled = await handleOldDataRequest({ request: request(method, remoteAddress), response: answer,
    url: new URL(`http://127.0.0.1${path}`), ...options });
  return { handled, ...answer };
}

test('the console routes list, restore and delete on this computer only', async (t) => {
  const { paths } = filledDirectory(t);
  const shelf = shelfFor(paths);
  const started = [];
  const restore = { describe: () => ({ currentDigest: 'd' }), start: (input) => { started.push(input); return { status: 'stopping' }; } };
  const encoded = encodeURIComponent(`format_backup:${SQLITE_BACKUP}`);

  const listed = await route('GET', '/api/old-data', { shelf, restore });
  assert.equal(listed.status, 200);
  assert.equal(listed.headers['Cache-Control'], 'no-store');
  assert.equal(listed.body.items.length, 7);
  assert.equal((await route('POST', `/api/old-data/${encoded}/restore`, { shelf, restore })).body.restore.status, 'stopping');
  assert.equal(started.length, 1);
  const deleted = await route('POST', `/api/old-data/${encodeURIComponent('log_archive:logs/runtime.log')}/delete`, { shelf, restore });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.id, 'log_archive:logs/runtime.log');

  assert.equal((await route('GET', '/api/old-data', { shelf, restore }, '192.168.1.20')).status, 403);
  assert.equal((await route('POST', `/api/old-data/${encoded}/delete`, { shelf, restore }, '192.168.1.20')).status, 403);
  assert.equal((await route('DELETE', `/api/old-data/${encoded}/delete`, { shelf, restore })).status, 405);
  assert.equal((await route('POST', '/api/old-data', { shelf, restore })).status, 405);
  assert.equal((await route('GET', '/api/old-data', { shelf: null, restore })).status, 503);
  assert.equal((await route('GET', '/api/old-database', { shelf, restore })).handled, false);
});

test('restoring is delegable with the settings permission; deleting now stays the person\'s', () => {
  const restore = interfaceForRoute('POST /api/old-data/:id/restore');
  assert.equal(restore.access, 'agent_delegable');
  assert.equal(restore.category, 'settings');
  const remove = interfaceForRoute('POST /api/old-data/:id/delete');
  assert.equal(remove.access, 'local_user_only');
  assert.match(remove.reason, /person/);
  const id = encodeURIComponent(`format_backup:${SQLITE_BACKUP}`);
  assert.equal(interfaceForRequest('POST', `/api/old-data/${id}/restore`).route, 'POST /api/old-data/:id/restore');
  assert.equal(interfaceForRequest('POST', `/api/old-data/${id}/delete`).route, 'POST /api/old-data/:id/delete');
});

test('no MCP or Agent tool module reaches the old-data restore and delete', () => {
  const changing = ['src/old-data/console-actions.js', 'src/http/old-data-api-router.js'].map((path) => join(ROOT, path));
  for (const entry of ['src/mcp-server.js', 'src/agent-tools.js', 'src/mcp/create-mcp-server.js']) {
    const modules = reachableModules(join(ROOT, entry));
    assert.deepEqual(changing.filter((path) => modules.has(path)), [], entry);
  }
});
