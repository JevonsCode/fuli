import assert from 'node:assert/strict';
import test from 'node:test';

import { readWebFile, webSource } from '../test-support/web-source.js';

test('memory view keeps facts and history behind simple disclosures', () => {
  const html = readWebFile('index.html');

  assert.match(html, /data-view-panel="memory"[\s\S]*id="lens-list"/);
  assert.match(html, /<details id="facts-section" class="data-section" hidden>/);
  assert.match(html, /<summary>当前事实 <span id="fact-count"><\/span><\/summary>/);
  assert.match(html, /<details id="timeline-section" class="data-section" hidden>/);
});

test('memory view hides empty data sections and localizes timeline status', () => {
  const app = webSource('js/elements.js', 'js/render-memory.js');

  assert.match(app, /elements\.factSection\.hidden = state\.currentFacts\.length === 0/);
  assert.match(app, /elements\.timelineSection\.hidden = timelineCount === 0/);
  assert.match(app, /fact\.invalidAt \? '历史' : '当前'/);
  assert.doesNotMatch(app, />historical<|>current</);
});
