import assert from 'node:assert/strict';
import test from 'node:test';
import { parseHTML } from 'linkedom';

import { applyCapabilityVisibility, hasReviewWorkspace } from '../web/js/capabilities.js';

test('personal-only mode hides unavailable public destinations', () => {
  const { document } = parseHTML(`
    <button data-view="public-projects" data-capability="browsePublicProjects"></button>
    <button data-review-navigation></button><article data-review-metric></article>
  `);

  applyCapabilityVisibility(document, {
    mode: 'personal_only',
    capabilities: { browsePublicProjects: false }
  });

  assert.equal(document.querySelector('[data-view="public-projects"]').hidden, true);
  assert.equal(document.querySelector('[data-review-navigation]').hidden, true);
  assert.equal(document.querySelector('[data-review-metric]').hidden, true);
});

test('connected mode exposes public project and review destinations', () => {
  const { document } = parseHTML(`
    <button data-view="public-projects" data-capability="browsePublicProjects" hidden></button>
    <button data-review-navigation hidden></button><article data-review-metric hidden></article>
  `);

  applyCapabilityVisibility(document, {
    mode: 'connected',
    capabilities: { browsePublicProjects: true, submitKnowledge: true }
  });

  assert.equal(document.querySelector('[data-view="public-projects"]').hidden, false);
  assert.equal(document.querySelector('[data-review-navigation]').hidden, false);
  assert.equal(document.querySelector('[data-review-metric]').hidden, false);
});

test('review workspace appears for a Maintainer even without submission capability', () => {
  assert.equal(hasReviewWorkspace({ capabilities: { reviewProposals: true } }), true);
  assert.equal(hasReviewWorkspace({ capabilities: {} }), false);
});
