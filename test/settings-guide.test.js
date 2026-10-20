import assert from 'node:assert/strict';
import test from 'node:test';

import { callAgentTool } from '../src/agent-tools.js';
import { DEFAULT_RUNTIME_SETTINGS } from '../src/system/runtime-settings.js';
import { describeSettings } from '../src/system/settings-guide.js';

const guide = () => describeSettings({
  settings: { ...DEFAULT_RUNTIME_SETTINGS, lanAccess: true },
  capturePolicy: { enabled: false, disabledSources: ['cursor'] },
  consoleUrl: 'http://127.0.0.1:2727',
});

test('settings guide gives current values, effects and a filtered settings link', () => {
  const { settings, guidance } = guide();
  const byKey = Object.fromEntries(settings.map((entry) => [entry.key, entry]));
  assert.deepEqual(byKey.capture.value, { enabled: false, disabledSources: ['cursor'], projectMode: 'all',
    excludedProjectIds: [], selectedProjectIds: [], unregisteredDirectories: 'capture' });
  assert.equal(byKey.lanAccess.value, true);
  assert.equal(byKey.lanAccess.restart, true);
  assert.equal(byKey.ports.settingsUrl, 'http://127.0.0.1:2727/settings?setting=ports');
  assert.equal(byKey.browser.settingsUrl, 'http://127.0.0.1:2727/settings');
  for (const entry of settings) assert.ok(entry.effect.length > 20, entry.key);
  assert.match(guidance, /update_capture_policy/);
});

test('only capture is changeable by an Agent; device settings stay with the person', () => {
  const changers = guide().settings.map(({ key, changedBy }) => [key, changedBy]);
  assert.deepEqual(changers.filter(([, by]) => by !== 'person'), [['capture', 'agent:update_capture_policy']]);
});

test('explain_settings reads through the app and is unavailable without a local installation', async () => {
  const explained = await callAgentTool({ explainSettings: () => guide() }, 'explain_settings', {});
  assert.equal(explained.settings[0].key, 'capture');
  assert.throws(() => callAgentTool({}, 'explain_settings', {}), /local installation/);
});

test('the capture setting explains which projects are recorded (rec#5 C2)', () => {
  const { settings } = describeSettings({ settings: DEFAULT_RUNTIME_SETTINGS, consoleUrl: 'http://127.0.0.1:2727',
    capturePolicy: { enabled: true, disabledSources: [], projectMode: 'selected', selectedProjectIds: ['thesis'],
      excludedProjectIds: [], unregisteredDirectories: 'skip' } });
  const capture = settings.find(entry => entry.key === 'capture');
  assert.deepEqual([capture.value.projectMode, capture.value.selectedProjectIds, capture.value.unregisteredDirectories],
    ['selected', ['thesis'], 'skip']);
  assert.match(capture.effect, /selectedProjectIds/);
});
