import assert from 'node:assert/strict';
import test from 'node:test';

import { contentHash } from '../packages/roundtable/src/canonical-json.js';
import { JefaBoardStore } from '../src/employees/builtin/jefa/board-store.js';

test('a seven-table move retains every revision and request, and a later move merges immutable history', t => {
  const source = new JefaBoardStore(':memory:'), target = new JefaBoardStore(':memory:');
  t.after(() => { source.close(); target.close(); });
  const scope = { spaceId: 'synthetic', projectId: 'sample' };
  const other = { ...scope, projectId: 'other' };
  const input = { requestId: 'create', actor: 'agent', tasks: [{ title: 'Sample', dueDate: '2026-11-06' }] };
  const empty = source.exportForMove(scope);
  assert.deepEqual(empty.tables.map(x => x.count), [0,0,0,0,0,0,0]);
  const [task] = source.create(scope, input);
  target.create(other, input);
  const untouched = target.exportForMove(other).digest;
  for (let i = 0; i < 27; i++) {
    source.setStatus(scope, task.id, i % 2 ? 'active' : 'blocked', undefined, { relayedBy: 'sample', personWords: 'Proceed' });
  }
  source.configureProjectBoard(scope, { requestId: 'manager', request: { expectedRevision: 0 } },
    () => ({ managerAgentId: 'sample' }));
  source.setSharing(scope, true);
  source.saveTitleRecord(scope, { requestId: 'title', request: {}, sourceApplication: 'sample', sessionId: 'thread' },
    (_previous, updatedAt) => ({ id: 'title', sourceApplication: 'sample', sessionId: 'thread', revision: 1, updatedAt }));
  const before = source.exportForMove(scope);
  assert.ok(before.tables.every(table => table.count > 0));
  assert.equal(before.tables.find(row => row.name === 'jefa_work_item_revisions').count, 28);
  assert.equal(target.rehearseMove(scope, before), before.digest);
  assert.equal(target.exportForMove(scope).digest, empty.digest);
  assert.equal(target.installForMove(scope, before), before.digest);
  assert.equal(target.installForMove(scope, before, { installedDigest: before.digest }), before.digest);
  assert.deepEqual(target.create(scope, input), source.create(scope, input));
  assert.deepEqual(target.exportForMove(scope), before);
  source.setStatus(scope, task.id, 'review');
  const next = source.exportForMove(scope);
  assert.throws(() => target.installForMove(scope, next), { code: 'board_target_not_empty' });
  const broken = structuredClone(next);
  const revisions = broken.tables.find(table => table.name === 'jefa_work_item_revisions');
  revisions.rows[0][revisions.columns.indexOf('actor')] = 'person';
  const { digest, ...body } = broken;
  broken.digest = contentHash(body);
  assert.throws(() => target.installForMove(scope, broken, { baselineDigest: before.digest }), { code: 'board_history_conflict' });
  assert.equal(target.exportForMove(scope).digest, before.digest);
  assert.equal(target.installForMove(scope, next, { baselineDigest: before.digest }), next.digest);
  assert.equal(target.exportForMove(other).digest, untouched);
});

test('rehearsal and installation reject links already shared by another target project', t => {
  const source = new JefaBoardStore(':memory:');
  const target = new JefaBoardStore(':memory:');
  t.after(() => { source.close(); target.close(); });
  const scope = { spaceId: 'space', projectId: 'incoming' };
  const other = { ...scope, projectId: 'existing' };
  source.setSharing(scope, true);
  target.setSharing(other, true);
  const shared = target.exportForMove(other).tables[0];
  const snapshot = source.exportForMove(scope);
  const project = snapshot.tables[0];
  project.rows[0][project.columns.indexOf('share_slug')] = shared.rows[0][shared.columns.indexOf('share_slug')];
  const { digest, ...body } = snapshot;
  snapshot.digest = contentHash(body);
  const empty = target.exportForMove(scope);
  for (const action of ['rehearseMove', 'installForMove']) {
    assert.throws(() => target[action](scope, snapshot), { code: 'board_share_conflict' });
    assert.deepEqual(target.exportForMove(scope), empty);
  }
});
