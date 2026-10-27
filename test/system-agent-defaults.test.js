import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { agentProfileMessages } from '../web/src/i18n/messages/agent-profiles.ts';

// The console shows a built-in Agent's default responsibility in its own
// language only while the stored text is still the Provider's default. The
// Chinese copy in the console must stay word for word what the Provider
// stores, or the default stops being recognized.
const provider = readFileSync(new URL('../graph-provider/fuli_graph/system_agents.py', import.meta.url), 'utf8');

function providerResponsibility(functionName) {
  const body = provider.slice(provider.indexOf(`def ${functionName}(`));
  const match = /responsibility=\(?\s*((?:'[^']*'\s*)+)\)?,/.exec(body);
  assert.ok(match, functionName);
  return [...match[1].matchAll(/'([^']*)'/g)].map(part => part[1]).join('');
}

test('the console\'s Chinese defaults are the Provider\'s built-in responsibilities, word for word', () => {
  const zh = agentProfileMessages['zh-CN'].systemResponsibility;
  const en = agentProfileMessages['en-US'].systemResponsibility;
  assert.deepEqual({
    jefa: providerResponsibility('coordinator_profile'),
    bole: providerResponsibility('hr_profile'),
    tonborg: providerResponsibility('judgment_profile'),
    assistant: providerResponsibility('assistant_profile')
  }, zh);
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort());
});
