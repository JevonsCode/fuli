import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const settingsPage = readFileSync('web/src/pages/SettingsPage.vue', 'utf8');

test('settings switches center their knob vertically in both states', () => {
  const baseRule = settingsPage.match(
    /\.setting-row input\[role='switch'\]::after\s*\{(?<body>[^}]*)\}/
  );
  const checkedRule = settingsPage.match(
    /\.setting-row input\[role='switch'\]:checked::after\s*\{(?<body>[^}]*)\}/
  );

  assert.ok(baseRule?.groups?.body);
  assert.ok(checkedRule?.groups?.body);
  assert.match(baseRule.groups.body, /top:\s*50%/);
  assert.match(baseRule.groups.body, /transform:\s*translateY\(-50%\)/);
  assert.match(checkedRule.groups.body, /transform:\s*translate\(17px,\s*-50%\)/);
});
