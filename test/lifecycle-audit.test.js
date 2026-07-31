import assert from 'node:assert/strict';
import test from 'node:test';

import { auditLifecycleTool } from '../src/mcp/lifecycle-audit.js';

test('acceptance lifecycle audit records labels only when explicitly configured', () => {
  const writes = [];
  const append = (...args) => writes.push(args);

  assert.equal(auditLifecycleTool('begin_task_context', { append }), false);
  assert.equal(auditLifecycleTool('search_knowledge_graph', {
    auditPath: 'synthetic-audit.jsonl',
    append
  }), false);
  assert.equal(auditLifecycleTool('verify_task_checkpoint', {
    auditPath: 'synthetic-audit.jsonl',
    append
  }), true);

  assert.equal(writes.length, 1);
  assert.deepEqual(JSON.parse(writes[0][1]), {
    event: 'verify_task_checkpoint'
  });
  assert.deepEqual(writes[0][2], { encoding: 'utf8', mode: 0o600 });
});
