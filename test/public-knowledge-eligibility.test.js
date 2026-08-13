import assert from 'node:assert/strict';
import test from 'node:test';

import { assertPublicKnowledgeEligible } from
  '../src/graphiti/knowledge-provider-mapping.js';

function confirmedItem(originQuadrant = 'known_known') {
  return {
    origin_quadrant: originQuadrant,
    confirmation_status: 'confirmed',
    confirmation_basis: {
      confirmed_by: { kind: 'user' },
      confirmed_at: '2026-08-12T00:00:00.000Z'
    },
    profile_aspect: null
  };
}

test('public review accepts auditable known-known project knowledge', () => {
  assert.doesNotThrow(() => assertPublicKnowledgeEligible({
    entities: [confirmedItem()],
    relationships: []
  }));
});

for (const originQuadrant of [
  'known_unknown',
  'unknown_known',
  'unknown_unknown'
]) {
  test(`public review rejects confirmed ${originQuadrant} knowledge`, () => {
    assert.throws(() => assertPublicKnowledgeEligible({
      entities: [confirmedItem(originQuadrant)],
      relationships: []
    }), /originally captured as known-known/);
  });
}
