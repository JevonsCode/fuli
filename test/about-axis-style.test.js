import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const labelGuide = readFileSync(
  'web/src/features/about/LabelGuide.vue',
  'utf8'
);

test('the discovery-source awareness axis reads upright from top to bottom', () => {
  const rule = labelGuide.match(/\.quadrant-y-axis strong\s*\{(?<body>[^}]*)\}/);

  assert.ok(rule?.groups?.body);
  assert.match(rule.groups.body, /writing-mode:\s*vertical-rl/);
  assert.match(rule.groups.body, /text-orientation:\s*upright/);
  assert.doesNotMatch(rule.groups.body, /rotate\(180deg\)/);
});
