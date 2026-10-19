import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { RecallPolicyStore, recallPolicyPathForRuntime } from '../src/graphiti/recall-policy.js';
import { handleGraphApiRequest } from '../src/http/graph-api-router.js';

test('answering from confirmed knowledge is on until a person turns it off, and the choice persists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fuli-recall-policy-'));
  try {
    const path = recallPolicyPathForRuntime(join(dir, 'graph-runtime.json'));
    assert.equal(path, join(dir, 'recall-policy.json'));
    const store = new RecallPolicyStore(path, { now: () => '2026-10-19T15:00:00.000Z' });
    assert.deepEqual(store.read(), { answerFromConfirmed: true, updatedAt: null });
    assert.deepEqual(store.update({ answerFromConfirmed: false }),
      { answerFromConfirmed: false, updatedAt: '2026-10-19T15:00:00.000Z' });
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).version, 1);
    assert.equal(new RecallPolicyStore(path).read().answerFromConfirmed, false);
    assert.throws(() => store.update({ answerFromConfirmed: 'no' }), /must be a boolean/);
    writeFileSync(path, '{"version":2}');
    assert.throws(() => store.read(), /invalid/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function call(method, body, app) {
  const request = Object.assign(Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []), {
    method, headers: { 'content-type': 'application/json' } });
  const sent = {};
  const response = { setHeader() {}, writeHead(status) { sent.status = status; },
    end(text) { sent.body = text ? JSON.parse(text) : null; } };
  return handleGraphApiRequest({ request, response, url: new URL('http://127.0.0.1/api/recall-policy'), app })
    .then(handled => ({ handled, ...sent }));
}

test('the console reads and changes the recall policy', async () => {
  const store = new RecallPolicyStore();
  const app = { getRecallPolicy: () => store.read(), updateRecallPolicy: input => store.update(input) };
  assert.equal((await call('GET', null, app)).body.answerFromConfirmed, true);
  assert.equal((await call('PATCH', { answerFromConfirmed: false }, app)).body.answerFromConfirmed, false);
  assert.equal(store.read().answerFromConfirmed, false);
});
