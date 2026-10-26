import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { knowledgeHardDelete } from '../src/knowledge-hard-delete/console-port.js';
import { hardDeleteLedger } from '../src/knowledge-hard-delete/delete-ledger.js';
import { createAgentDirectorySnapshots } from '../src/agents/directory-snapshots.js';

const digest = 'a'.repeat(64);
const scope = { agent_id: 'synthetic-agent', personal_project_id: null, revisions: [2], current_revision: 3 };
const deletion = { deletion_id: 'synthetic-delete', item_kind: 'episode', item_id: 'source',
  deleted_at: '2026-10-01T00:00:00.000Z', deleted_item_ids: ['source'],
  source_application: 'codex', fuli_session_id: 'synthetic-session', memory_scopes: [scope],
  counts: { memory_checkpoints: 1, memory_later_revisions: 0 } };
const input = { personalSpaceId: 'space', itemKind: 'episode', itemId: 'source', previewId: digest, confirmation: '删除' };

function directory(t) {
  const path = mkdtempSync(join(tmpdir(), 'fuli-memory-cleanup-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
function send(path) {
  const preview = { ...deletion, preview_id: digest, default_items: [], affected_items: [],
    removed_episodes: [{ episode_id: 'source' }], agent_memory: { scrubbed: [{ ...scope, current: false }], later: [] } };
  return Promise.resolve({ ok: true, payload: path.endsWith('/preview') ? preview
    : path.endsWith('/hard-deletions') ? [deletion]
      : path.endsWith('/status') ? { state: 'deleted', deletion } : deletion });
}

test('snapshot cleanup is part of local_pending and retries the exact persisted revisions after restart', async t => {
  const dataDir = directory(t); const calls = []; let busy = true;
  const agentSnapshots = { scrubMemory(value) { calls.push(value); return { status: busy ? 'busy' : 'current' }; } };
  const options = { send, localStores: [], agentSnapshots, personalSpaceId: () => 'space' };
  const first = await knowledgeHardDelete(dataDir, options).confirm(input);
  assert.equal(first.outcome, 'local_pending');
  const saved = hardDeleteLedger(dataDir).find('space', 'source');
  assert.equal(saved.state, 'graph_deleted');
  assert.deepEqual(saved.memoryScopes, [{ agentId: 'synthetic-agent', personalProjectId: null,
    revisions: [2], currentRevision: 3 }]);
  busy = false;
  const restarted = await knowledgeHardDelete(dataDir, options).status(input);
  assert.equal(restarted.outcome, 'complete');
  assert.deepEqual(calls.at(-1), { personalSpaceId: 'space', agentId: 'synthetic-agent', personalProjectId: null,
    revisions: [2], currentRevision: 3 });
});

test('a lost ledger reconstructs snapshot cleanup from the graph receipt without initiating deletion', async t => {
  const dataDir = directory(t); const calls = [];
  const port = knowledgeHardDelete(dataDir, { send: async (...args) => {
    assert.ok(args[0].endsWith('/hard-deletions')); return send(...args);
  }, localStores: [], personalSpaceId: () => 'space',
  agentSnapshots: { scrubMemory(value) { calls.push(value); return { status: 'current' }; } } });
  const results = await port.reconcile();
  assert.equal(results[0].outcome, 'complete');
  assert.deepEqual(calls[0].revisions, [2]);
  await port.reconcile();
  assert.equal(calls.length, 2, 'a restored file is cleaned even beside an already-complete ledger');
});

test('missing snapshot capability cannot claim completion for a memory deletion', async t => {
  const result = await knowledgeHardDelete(directory(t), { send, localStores: [] }).confirm(input);
  assert.equal(result.outcome, 'local_pending');
  assert.equal(result.local_stores.find(row => row.store === 'agent-memory-snapshots').status, 'failed');
});

test('confirmed source deletion clears actual MEMORY.md and recleans an independently restored snapshot', async t => {
  const dataDir = directory(t);
  const snapshots = createAgentDirectorySnapshots({ root: join(dataDir, 'agents'), providerIdentity: 'https://synthetic.example' });
  const agent = { agentId: 'synthetic-agent', memoryScope: 'reviewed_agent', profile: { name: 'Synthetic' } };
  const layer = { personalProjectId: null, revision: 2, current: { revision: 2,
    memory: { summary: 'SYNTHETIC_ERASE_THIS_MEMORY', decisions: [], openThreads: [], nextActions: [] } } };
  const materialized = snapshots.materialize({ personalSpaceId: 'space', agent, layers: [layer] });
  const file = join(dataDir, materialized.path, 'MEMORY.md');
  const manifest = join(dataDir, materialized.path, '.fuli-snapshot.json');
  const original = readFileSync(file); const originalManifest = readFileSync(manifest);
  assert.ok(original.includes(Buffer.from('SYNTHETIC_ERASE_THIS_MEMORY')));
  const port = knowledgeHardDelete(dataDir, { send, localStores: [], agentSnapshots: snapshots, personalSpaceId: () => 'space' });
  assert.equal((await port.confirm(input)).outcome, 'complete');
  assert.ok(!readFileSync(file).includes(Buffer.from('SYNTHETIC_ERASE_THIS_MEMORY')));
  snapshots.materialize({ personalSpaceId: 'space', agent, layers: [layer] });
  assert.ok(!readFileSync(file).includes(Buffer.from('SYNTHETIC_ERASE_THIS_MEMORY')), 'late pre-delete view stays scrubbed');
  writeFileSync(file, original); writeFileSync(manifest, originalManifest);
  await port.reconcile();
  assert.ok(!readFileSync(file).includes(Buffer.from('SYNTHETIC_ERASE_THIS_MEMORY')));
  assert.equal(hardDeleteLedger(dataDir).find('space', 'source').state, 'complete');
});
