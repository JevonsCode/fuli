import assert from 'node:assert/strict';
import test from 'node:test';

import { readWebFile, webSource } from '../test-support/web-source.js';

test('local console keeps action feedback outside every view panel', () => {
  const html = readWebFile('index.html');
  const feedbackIndex = html.indexOf('id="feedback"');
  const firstPanelIndex = html.indexOf('data-view-panel=');

  assert.ok(feedbackIndex > 0 && feedbackIndex < firstPanelIndex);
  assert.match(html, /role="status" aria-live="polite"/);
});

test('local console shows request failures and clears stale feedback', () => {
  const app = webSource('js/actions.js', 'js/feedback.js', 'js/state.js', 'js/views.js');

  assert.match(app, /showFeedback\(`没处理成功：\$\{formatErrorMessage\(error\)\}`\)/);
  assert.match(app, /function selectView\(view\)[\s\S]*hideFeedback\(\)/);
  assert.match(app, /async function refreshState\(\)[\s\S]*hideFeedback\(\)/);
  assert.match(app, /async function observeChanges\(\)[\s\S]*hideFeedback\(\)/);
  assert.match(app, /async function reloadState\(\)[\s\S]*setRuntimeStatus\('loading'\)[\s\S]*setRuntimeStatus\('error'\)/);
  assert.match(app, /await reloadState\(\)/);
});
