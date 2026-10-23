import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { JudgmentStore } from '../src/judgment/store.js';
import { knowledgeHardDelete } from '../src/knowledge-hard-delete/console-port.js';
import { HARD_DELETE_LEDGER_FILE } from '../src/knowledge-hard-delete/delete-ledger.js';
import { runMigrateCommand } from '../src/cli/migrate-command.js';
import { reconcileLocalKnowledge } from '../src/knowledge-hard-delete/reconcile-local.js';
import { syntheticGraph, PREVIEW_ID } from '../test-support/hard-delete-graph.js';

const SPACE = 'personal-space';
const SECRET = 'SYNTHETIC-CROSS-PROCESS-SOURCE';

test('console deletion and independent Agent reader share fences and CLI repairs an old backup', { timeout: 30_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'fuli-recovery-process-'));
  let child;
  try {
    const seed = new JudgmentStore(join(dataDir, 'judgment.sqlite'), { recoveryGate: { state: () => ({ state: 'open' }) } });
    seed.record(SPACE, { kind: 'review', target: 'entity:item-2', title: SECRET, evidence: [] }, 'seed'); seed.close();
    const graph = syntheticGraph();
    const port = knowledgeHardDelete(dataDir, { send: graph.send, personalSpaceId: () => SPACE });
    await port.reconcile();
    const old = readFileSync(join(dataDir, HARD_DELETE_LEDGER_FILE));
    let online = true, extra = false;
    child = fork(new URL('../test-support/knowledge-recovery-reader.js', import.meta.url), [dataDir, SPACE], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let sequence = 0; const pending = new Map();
    const ready = new Promise(resolve => child.on('message', message => {
      if (message.ready) resolve();
      else if (message.watermarkId) child.send({ watermarkId: message.watermarkId, ...(online ? { value: {
        count: Number(graph.deleted) + Number(extra), latest_deleted_at: graph.deleted || extra ? graph.record().deleted_at : null
      } } : { error: true }) });
      else { pending.get(message.id)?.(message); pending.delete(message.id); }
    }));
    const call = (action, values = {}) => new Promise(resolve => { const id = ++sequence; pending.set(id, resolve); child.send({ id, action, ...values }); });
    await ready;
    assert.equal((await call('refresh')).value.state, 'open');
    assert.match(JSON.stringify((await call('read')).value), new RegExp(SECRET));
    await port.confirm({ personalSpaceId: SPACE, itemKind: 'entity', itemId: 'item-2', previewId: PREVIEW_ID, confirmation: '删除' });
    const fenced = await call('read');
    assert.equal(fenced.error.code, 'knowledge_recovery_pending');
    assert.doesNotMatch(JSON.stringify(fenced), new RegExp(SECRET));
    await port.reconcile();
    assert.equal((await call('refresh')).value.state, 'open');
    assert.doesNotMatch(JSON.stringify((await call('read')).value), new RegExp(SECRET));
    online = false;
    for (let i = 0; i < 2; i++) {
      assert.equal((await call('refresh')).value.state, 'closed');
      assert.equal((await call('write', { key: `offline-${i}` })).error.code, 'knowledge_recovery_pending');
    }
    online = true; extra = true;
    assert.equal((await call('refresh')).value.state, 'closed');
    extra = false;
    writeFileSync(join(dataDir, HARD_DELETE_LEDGER_FILE), old);
    assert.equal((await call('refresh')).value.state, 'closed');
    const lines = [];
    const cli = await runMigrateCommand(['reconcile-knowledge', '--data-dir', dataDir], {
      env: {}, write: line => lines.push(line),
      reconcileKnowledge: paths => reconcileLocalKnowledge(paths, {
        readConfig: () => ({ personal: { spaceId: SPACE, providerUrl: 'http://127.0.0.1:1', accessToken: 'synthetic' } }),
        createReconciler: () => port,
        fetchImpl: async (url, request) => {
          assert.equal(new URL(url).pathname, '/v1/knowledge/hard-deletions/watermark');
          assert.equal(request.headers['x-fuli-human-review-token'], undefined);
          return Response.json({ count: 1, latest_deleted_at: graph.record().deleted_at });
        }
      })
    });
    assert.equal(cli.exitCode, 0);
    assert.doesNotMatch(lines.join('\n'), new RegExp(SECRET));
    assert.equal((await call('refresh')).value.state, 'open');
    assert.doesNotMatch(JSON.stringify((await call('read')).value), new RegExp(SECRET));
    const exited = once(child, 'exit'); await call('close'); await exited; child = null;
  } finally {
    if (child) { const exited = once(child, 'exit'); child.kill(); await exited; }
    rmSync(dataDir, { recursive: true, force: true });
  }
});
