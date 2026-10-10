import test from 'node:test';
import assert from 'node:assert/strict';
import { JudgmentStore } from '../src/judgment/store.js';

test('pins preserve an explicitly empty list and reject stale writes', () => {
  const store = new JudgmentStore();
  try {
    let pins = store.pins('space');
    assert.deepEqual(pins.agentIds, ['employee.bole', 'employee.jefa', 'employee.tonborg']);
    for (const agentId of pins.agentIds) pins = store.pin('space', agentId, false, pins.revision);
    assert.deepEqual(store.pins('space').agentIds, []);
    assert.throws(() => store.pin('space', 'member', true, 0), { status: 409 });
    assert.equal(store.pins('another-space').agentIds.length, 3);
  } finally { store.close(); }
});

test('policy inherits without silently expanding autonomy; project override can be removed', () => {
  const store = new JudgmentStore();
  try {
    assert.equal(store.policy('s', 'p').mode, 'manual');
    store.setPolicy('s', '', { mode: 'shared', quality: 'quality', client: 'codex' }, 0);
    assert.equal(store.policy('s', 'p').inherited, true);
    assert.equal(store.policy('s', 'p').mode, 'shared');
    store.setPolicy('s', 'p', { mode: 'autonomous', quality: 'balanced', client: 'codex' }, 0);
    assert.equal(store.policy('s', 'p').mode, 'autonomous');
    assert.throws(() => store.setPolicy('s', 'p', { mode: 'manual' }, 0), { status: 409 });
    store.setPolicy('s', 'p', null, 1);
    assert.equal(store.policy('s', 'p').mode, 'shared');
    assert.equal(store.policy('s', 'p').revision, 2);
  } finally { store.close(); }
});

test('immutable decisions retain feedback history, scoped memory, and execution state', () => {
  const store = new JudgmentStore();
  try {
    const record = store.record('s', { personalProjectId: 'p', kind: 'routing', target: 'job', summary: 'Use available client', outcome: 'recommend', evidence: ['capability'], policy: { mode: 'shared' } }, 'request-1');
    assert.equal(store.record('s', { summary: 'changed' }, 'request-1').id, record.id);
    assert.equal(store.records('s', { personalProjectId: 'other' }).length, 0);
    store.feedback('s', record.id, 'down', 'Prefer continuity', 0);
    assert.throws(() => store.feedback('s', record.id, 'up', '', 0), { status: 409 });
    store.feedback('s', record.id, null, '', 1);
    assert.equal(store.get('s', record.id).feedbackHistory.length, 2);
    assert.equal(store.get('s', record.id).summary, 'Use available client');
    assert.throws(() => store.get('another', record.id), { status: 404 });
    store.execute('s', record.id, 'applied', { effect: 'selection returned' });
    assert.equal(store.get('s', record.id).execution.status, 'applied');
    assert.equal(store.get('s', record.id).feedback.vote, null);
  } finally { store.close(); }
});

test('one active judgment per scope; token owns lease release', () => {
  const store = new JudgmentStore();
  try {
    const lease = store.claim('s', 'p');
    assert.throws(() => store.claim('s', 'p'), { status: 409 });
    store.release('s', 'p', 'wrong');
    assert.throws(() => store.claim('s', 'p'), { status: 409 });
    store.release('s', 'p', lease);
    assert.ok(store.claim('s', 'p'));
  } finally { store.close(); }
});
