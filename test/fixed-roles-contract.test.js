import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { FIXED_ROLES } from '../src/employees/fixed-roles.js';
import { employeeAgentId, employeeCapability } from '../src/employees/manifest.js';
import { ROLE_AGENT_IDS } from '../web/src/features/agent-profile/fixed-roles.ts';
import { isBuiltInRole, mentionKind } from '../web/src/features/agent-profile/fla-mention.ts';

// Jefa, Bole, Tonborg and Astro are declared three times, once per side that
// cannot import the others: Node (src/employees/fixed-roles.js), the Provider
// (graph-provider/fuli_graph/fixed_roles.py) and the console
// (web/src/features/agent-profile/fixed-roles.ts). The console's fla-mention.ts
// spells them once more, since Node tests load it and it can import nothing.
// A role added, renamed or retyped in one place only fails here.
const provider = name => readFileSync(new URL(`../graph-provider/fuli_graph/${name}.py`, import.meta.url), 'utf8');
const nodeIds = Object.values(FIXED_ROLES).map(role => role.agentId).sort();

test('the Provider declares the same four fixed role IDs as Node', () => {
  const declared = [...provider('fixed_roles').matchAll(/^SYSTEM_[A-Z]+_AGENT_ID = '([^']+)'$/gm)].map(match => match[1]);
  assert.deepEqual(declared.sort(), nodeIds);
});

test('the console declares the same four fixed role IDs as Node', () => {
  assert.deepEqual(Object.values(ROLE_AGENT_IDS).sort(), nodeIds);
});

test('the console calls by name exactly the four fixed roles, each known by its own capability', () => {
  const record = (agentId, capabilities) => ({ agentId, profile: { agentType: 'durable', status: 'active', capabilities } });
  for (const role of Object.values(FIXED_ROLES)) {
    assert.equal(isBuiltInRole(role.agentId), true, role.agentId);
    assert.equal(mentionKind(record(role.agentId, [role.capability])), 'role', role.agentId);
    // The ID alone is an Agent reusing it, not FULI's own role.
    assert.equal(mentionKind(record(role.agentId, [])), null, role.agentId);
  }
  assert.equal(isBuiltInRole('employee.someone'), false);
});

test('a fixed role\'s ID and capability are its package\'s, and each one ships in the built-in catalog', () => {
  for (const [id, role] of Object.entries(FIXED_ROLES)) {
    assert.equal(role.agentId, employeeAgentId(id));
    assert.equal(role.capability, employeeCapability(id));
    const manifest = JSON.parse(readFileSync(new URL(`../src/employees/catalog/${id}.json`, import.meta.url), 'utf8'));
    assert.equal(manifest.id, id);
  }
});

test('each fixed role has the Agent type the Provider provisions it with', () => {
  // The profile function of each role in system_agents.py; a profile that
  // names no agent_type takes ProjectAgentProfile's default.
  const profiles = { jefa: 'coordinator_profile', bole: 'hr_profile', tonborg: 'judgment_profile', assistant: 'assistant_profile' };
  const source = provider('system_agents');
  const fallback = /^\s+agent_type: ProjectAgentType = '([a-z_]+)'$/m.exec(provider('project_agent_models'))?.[1];
  assert.ok(fallback, 'ProjectAgentProfile.agent_type default');
  for (const [id, functionName] of Object.entries(profiles)) {
    const start = source.indexOf(`def ${functionName}(`);
    assert.notEqual(start, -1, functionName);
    const body = source.slice(start, source.indexOf('\n\n\n', start));
    assert.equal(/agent_type='([a-z_]+)'/.exec(body)?.[1] ?? fallback, FIXED_ROLES[id].agentType, id);
  }
});
