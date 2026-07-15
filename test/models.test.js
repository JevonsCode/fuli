import test from 'node:test';
import assert from 'node:assert/strict';

import { FactStatus, SpaceKind, isCurrentFact } from '../src/models.js';

test('fact is current when it has not been invalidated', () => {
  const fact = {
    id: 'fact-1',
    spaceId: 'space-1',
    subject: 'Project A',
    predicate: 'has_test_url',
    object: 'https://test.example.com',
    sourceEpisodeId: 'episode-1',
    status: FactStatus.CONFIRMED,
    validAt: new Date().toISOString(),
    invalidAt: null
  };

  assert.equal(isCurrentFact(fact), true);
});

test('space kind values are stable', () => {
  assert.equal(SpaceKind.PERSONAL, 'personal');
  assert.equal(SpaceKind.PUBLIC, 'public');
});
