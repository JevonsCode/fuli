import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { FederatedGraphApplication } from '../src/graphiti/federated-application.js';
import { suggestionSessionGeneration } from '../src/graphiti/role-suggestion-note.js';
import { handleApiRequest } from '../src/http/api-router.js';
import { mapHttpError } from '../src/http/error-mapping.js';
import { listenFetchableServer } from '../src/server/listen.js';
import { RoleSuggestionLog } from '../src/model-backends/suggestion-log.js';
import { hardDeleteLedger } from '../src/knowledge-hard-delete/delete-ledger.js';
import { knowledgeReferences } from '../src/knowledge-hard-delete/forget-references.js';

const openGate = { state: () => ({ state: 'open' }) };
const source = { sourceApplication: 'codex', sessionId: 'synthetic-session' };
const entry = (space = 'space') => ({ role: 'assistant', operation: 'project_candidate', personalSpaceId: space,
  subject: { conversationId: 'journal-not-session' }, result: { status: 'suggested', hint: 'SYNTHETIC_RECOVERY_WORDS',
    suggestion: { reason: 'SYNTHETIC_RECOVERY_WORDS' } } });
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-suggestion-recovery-'));
  const path = join(directory, 'role-suggestions.sqlite');
  const logs = [];
  const open = options => { const log = new RoleSuggestionLog(path, options); logs.push(log); return log; };
  t.after(() => { logs.forEach(log => log.close()); rmSync(directory, { recursive: true, force: true }); });
  return { directory, path, open, ledger: hardDeleteLedger(directory) };
}
test('disk suggestion reads and writes fail closed; privileged cleanup still erases actual bytes', t => {
  const f = fixture(t);
  const seeded = f.open({ recoveryGate: openGate });
  seeded.record(entry());
  seeded.close();
  const closed = f.open();
  for (const operation of [() => closed.list({ personalSpaceId: 'space' }), () => closed.record(entry())]) {
    assert.throws(operation, { code: 'knowledge_recovery_pending', status: 503 });
  }
  assert.equal(closed.forgetKnowledgeItems('space', knowledgeReferences({ itemIds: ['item'] }),
    { deletedAt: new Date().toISOString() }), 1);
  closed.close();
  assert.equal(readFileSync(f.path).includes(Buffer.from('SYNTHETIC_RECOVERY_WORDS')), false);
});
test('scoped list never reads another space body or requires its recovery proof', t => {
  const f = fixture(t);
  const seeded = f.open({ recoveryGate: openGate });
  seeded.record(entry('space')); seeded.record(entry('other'));
  seeded.close();
  const checked = [];
  const log = f.open({ recoveryGate: { state(space) { checked.push(space); return { state: space === 'space' ? 'open' : 'closed' }; } } });
  assert.deepEqual(log.list({ personalSpaceId: 'space' }).map(row => row.personalSpaceId), ['space']);
  assert.ok(checked.every(space => space === 'space'));
});
test('retention leaves a closed space row byte-for-byte unchanged until its proof opens', t => {
  const f = fixture(t);
  const seeded = f.open({ now: () => new Date('2026-01-01'), recoveryGate: openGate });
  seeded.record(entry('other'));
  const before = seeded.db.prepare('SELECT * FROM role_suggestions').get();
  seeded.close();
  let otherOpen = false;
  const log = f.open({ now: () => new Date('2026-10-01'), recoveryGate: { state(space) {
    return { state: space !== 'other' || otherOpen ? 'open' : 'closed' };
  } } });
  log.record(entry());
  assert.deepEqual(log.db.prepare("SELECT * FROM role_suggestions WHERE space = 'other'").get(), before);
  otherOpen = true;
  log.record(entry());
  assert.equal(log.db.prepare("SELECT count(*) AS n FROM role_suggestions WHERE space = 'other'").get().n, 0);
});
test('session deletion drops the entire late row, while another session and the new generation remain writable', t => {
  const f = fixture(t), log = f.open({ recoveryGate: openGate });
  const before = log.sessionGeneration('space', source);
  const other = log.sessionGeneration('space', { ...source, sessionId: 'unrelated' });
  const operation = f.ledger.begin({ spaceId: 'space', itemKind: 'episode', itemId: 'episode', itemIds: ['episode'], ...source });
  f.ledger.update(operation.id, { state: 'complete', deletionId: 'deletion', deletedAt: new Date().toISOString() });
  assert.deepEqual(log.record({ ...entry(), sessionGeneration: before }), { recorded: false, dropped: 1, reason: 'session_generation_changed' });
  assert.equal(log.db.prepare('SELECT count(*) AS n FROM role_suggestions').get().n, 0);
  log.record({ ...entry(), sessionGeneration: other });
  log.record({ ...entry(), sessionGeneration: log.sessionGeneration('space', source) });
  assert.equal(log.list({ personalSpaceId: 'space' }).length, 2);
  assert.equal(log.droppedCount, 1);
});

test('another process cannot begin deletion between the final generation check and SQLite INSERT', { timeout: 15_000 }, async t => {
  const f = fixture(t), log = f.open({ recoveryGate: openGate });
  const generation = log.sessionGeneration('space', source);
  let finished, child;
  log.db.function('during_insert', () => {
    const code = `import {writeFileSync} from 'node:fs'; import {join} from 'node:path';
      const {hardDeleteLedger} = await import(process.argv[1]); const dir = process.argv[2];
      writeFileSync(join(dir, 'attempting'), 'yes');
      hardDeleteLedger(dir).begin({spaceId:'space',itemKind:'session',itemId:'source',itemIds:[],sourceApplication:'codex',sessionId:'synthetic-session'});
      writeFileSync(join(dir, 'finished'), 'yes');`;
    child = spawn(process.execPath, ['--input-type=module', '-e', code,
      new URL('../src/knowledge-hard-delete/delete-ledger.js', import.meta.url).href, f.directory], { stdio: ['ignore', 'ignore', 'pipe'] });
    let errors = '';
    child.stderr.on('data', data => { errors += data; });
    finished = new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('exit', code => code === 0 ? resolve() : reject(new Error(errors || `child exit ${code}`)));
    });
    const deadline = Date.now() + 5000;
    const wait = new Int32Array(new SharedArrayBuffer(4));
    while (!existsSync(join(f.directory, 'attempting')) && Date.now() < deadline) Atomics.wait(wait, 0, 0, 10);
    assert.ok(existsSync(join(f.directory, 'attempting')), 'child reached ledger.begin');
    Atomics.wait(wait, 0, 0, 500);
    assert.equal(existsSync(join(f.directory, 'finished')), false, 'ledger writer waits until INSERT commits');
    return 1;
  });
  log.db.prepare('CREATE TEMP TRIGGER pause_insert BEFORE INSERT ON role_suggestions BEGIN SELECT during_insert(); END').run();
  t.after(() => { if (child?.exitCode === null) child.kill(); });
  assert.equal(log.record({ ...entry(), sessionGeneration: generation }).recorded, true);
  await finished;
  assert.ok(existsSync(join(f.directory, 'finished')));
  log.db.exec('DROP TRIGGER pause_insert');
  assert.equal(log.record({ ...entry(), sessionGeneration: generation }).recorded, false);
  assert.equal(log.db.prepare('SELECT count(*) AS n FROM role_suggestions').get().n, 1);
});

test('unknown session outcome drops a row even when the deletion is later refused; other client and space do not match', t => {
  const f = fixture(t), log = f.open({ recoveryGate: openGate });
  const unrelated = log.sessionGeneration('space', { ...source, sourceApplication: 'cursor' });
  const operation = f.ledger.begin({ spaceId: 'space', itemKind: 'session', itemId: 'session-key', itemIds: [], ...source });
  const during = log.sessionGeneration('space', source);
  assert.equal(log.record({ ...entry(), sessionGeneration: during }).recorded, false);
  f.ledger.update(operation.id, { state: 'not_deleted' });
  assert.equal(log.record({ ...entry(), sessionGeneration: during }).recorded, false);
  assert.equal(log.record({ ...entry(), sessionGeneration: unrelated }).recorded, true);
  assert.equal(log.record({ ...entry('other'), sessionGeneration: log.sessionGeneration('other', source) }).recorded, true);
});

test('the session snapshot uses the verified context, never the supplied session or journal identity', async () => {
  const log = new RoleSuggestionLog();
  try {
    const application = { roleSuggestions: log, taskContextRegistry: { async context(token, client) {
      assert.equal(token, 'trusted-token'); assert.equal(client, 'codex');
      return { sourceApplication: 'codex', sessionId: 'verified-session' };
    } } };
    assert.deepEqual(await suggestionSessionGeneration(application, 'space',
      { token: 'trusted-token', sourceApplication: 'codex', sessionId: 'forged', conversationId: 'journal' }),
    { sourceApplication: 'codex', sessionId: 'verified-session', deletionId: null, blocked: false });
  } finally { log.close(); }
});

test('a deletion completing during trusted context lookup invalidates the old entry before its model runs', async t => {
  const f = fixture(t), log = f.open({ recoveryGate: openGate });
  let release;
  const application = { roleSuggestions: log, taskContextRegistry: { context: () => new Promise(resolve => { release = resolve; }) } };
  const pending = suggestionSessionGeneration(application, 'space', { token: 'old-task', sourceApplication: 'codex' });
  const operation = f.ledger.begin({ spaceId: 'space', itemKind: 'session', itemId: 'source', itemIds: [], ...source });
  f.ledger.update(operation.id, { state: 'complete', deletionId: 'new-generation', deletedAt: new Date().toISOString() });
  release({ sourceApplication: 'codex', sessionId: source.sessionId });
  const generation = await pending;
  assert.equal(log.record({ ...entry(), sessionGeneration: generation }).recorded, false);
  assert.equal(log.db.prepare('SELECT count(*) AS n FROM role_suggestions').get().n, 0);
});

test('actual suggestions HTTP prepares only the configured space and returns no body on recovery refusal', async t => {
  const f = fixture(t);
  const seeded = f.open({ recoveryGate: openGate });
  seeded.record(entry()); seeded.record(entry('other')); seeded.close();
  let ready = false;
  const refreshed = [];
  const gate = { async refresh(space) { refreshed.push(space); }, state(space) {
    return { state: ready && space === 'space' ? 'open' : 'closed' };
  } };
  const app = new FederatedGraphApplication({ version: 1,
    personal: { providerUrl: 'https://synthetic.example', accessToken: 'synthetic', principalId: 'person', spaceId: 'space' }, workspaces: [] },
  { fetchImpl: () => { throw Error('no network'); } });
  app.roleSuggestions = f.open({ recoveryGate: gate }); app.knowledgeRecoveryGate = gate; app.modelBackends = {};
  const server = createServer(async (request, response) => {
    try { await handleApiRequest({ request, response, app }); }
    catch (error) { const mapped = mapHttpError(error); response.writeHead(mapped.status, { 'content-type': 'application/json' }).end(JSON.stringify(mapped.body)); }
  });
  await listenFetchableServer(server, 0);
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/api/model-backends/suggestions?personalSpaceId=other`;
  const refused = await fetch(url);
  assert.equal(refused.status, 503);
  assert.equal((await refused.text()).includes('SYNTHETIC_RECOVERY_WORDS'), false);
  ready = true;
  const result = await (await fetch(url)).json();
  assert.deepEqual(result.suggestions.map(row => row.personalSpaceId), ['space']);
  assert.deepEqual(refreshed, ['space', 'space']);
});
