import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('organizer rows keep fixed badge columns on a phone so badges line up', () => {
  const page = readFileSync('web/src/pages/KnowledgeOrganizerPage.vue', 'utf8');
  const phone = page.slice(page.indexOf('@media (max-width: 560px)'));
  const columns = phone.match(/grid-template-columns: ([^;]+);/)?.[1];
  assert.ok(columns, 'phone breakpoint sets the row columns');
  // Every row is its own grid, so an `auto` column sizes per row and badges drift apart.
  assert.doesNotMatch(columns, /\bauto\b/);
  assert.match(columns, /^minmax\(0, 1fr\) \d+px \d+px$/);
  assert.match(phone, /\.review-chip \{[^}]*text-overflow: ellipsis;/);
});
