// What a checkpoint's capture receipt says about older knowledge the capture
// replaced or may have made stale. Synthetic Provider answers only.
import assert from 'node:assert/strict';
import test from 'node:test';

import { taskCaptureReceipt, taskCaptureReviewPaths } from '../src/graphiti/task-knowledge-routing.js';

const input = { personalProjectId: 'aurora' };
const committed = extra => ({ status: 'committed', episode_id: 'episode-1', entity_ids: ['entity-new'],
  relationship_ids: ['port-4000'], ...extra });

test('a receipt names the keyed values a capture ended and the items waiting for the person', () => {
  const receipt = taskCaptureReceipt('current_project', input, committed({
    superseded: [{ item_kind: 'relationship', item_id: 'port-3000', extra: 'dropped' }],
    possibly_outdated: [{ item_kind: 'entity', item_id: 'old-runbook' }] }));
  assert.deepEqual(receipt.superseded, [{ item_kind: 'relationship', item_id: 'port-3000' }]);
  assert.deepEqual(receipt.possibly_outdated, [{ item_kind: 'entity', item_id: 'old-runbook' }]);
  const [withPaths] = taskCaptureReviewPaths('space', [receipt]);
  assert.deepEqual(withPaths.possibly_outdated, receipt.possibly_outdated, 'the stored receipt keeps them');
});

test('a receipt with nothing replaced spends no bytes on it', () => {
  const receipt = taskCaptureReceipt('current_project', input, committed({ superseded: [], possibly_outdated: [] }));
  assert.equal('superseded' in receipt, false);
  assert.equal('possibly_outdated' in receipt, false);
  assert.equal('superseded' in taskCaptureReceipt('current_project', input, committed()), false,
    'an older Provider that does not say is read the same way');
});
