import assert from 'node:assert/strict';
import test from 'node:test';

import { readWebFile, webSource } from '../test-support/web-source.js';

test('pending view is always reachable and keeps zero counts quiet', () => {
  const html = readWebFile('index.html');
  const app = webSource('js/elements.js', 'js/render.js');

  assert.match(html, /data-view="pending" aria-pressed="false"/);
  assert.doesNotMatch(html, /data-view="pending"[^>]*hidden/);
  assert.match(app, /elements\.pendingNavCount\.textContent = pendingCandidates\.length \? `\$\{pendingCandidates\.length\}` : ''/);
  assert.match(app, /elements\.candidateCount\.textContent = pendingCandidates\.length \? `\$\{pendingCandidates\.length\}` : ''/);
});

test('pending decisions use human labels with stable protocol values', () => {
  const app = readWebFile('js/render-candidates.js');

  assert.match(app, /data-decision="sync">记到项目<\/button>/);
  assert.match(app, /data-decision="personal_only">只记给我<\/button>/);
  assert.match(app, /data-decision="ignore">不要记<\/button>/);
  assert.doesNotMatch(app, /candidate\.status.*pill/);
  assert.match(app, /candidate\.targetSpaceId\s*\?/);
});

test('pending view renders a calm empty state and action feedback', () => {
  const app = webSource('js/actions.js', 'js/render-candidates.js', 'js/feedback.js');

  assert.match(app, /暂无待确认内容/);
  assert.match(app, /showFeedback\(formatCandidateDecision\(result\.candidate\)\)/);
  assert.match(app, /已忽略/);
});
