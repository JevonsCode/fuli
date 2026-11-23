import assert from 'node:assert/strict';
import test from 'node:test';

import { agentNameFixPlan, applyAgentNameFixes, listAgentNameChanges, markAgentNameChangesSeen }
  from '../src/graphiti/agent-name-workflows.js';
import { renameProjectAgent } from '../src/graphiti/project-agent-workflows.js';
import { GraphitiProviderClient } from '../src/graphiti/provider-client.js';
import { mapHttpError } from '../src/http/error-mapping.js';

// rec#11 D-89: the shown name only, through the Provider's own rename. Synthetic Agents only.
test('a rename sends only the name, and null gives a built-in role its own name back', async () => {
  const calls = [];
  const record = (agentId, displayName) => ({ agent_id: agentId, personal_space_id: 'space-a', personal_project_id: null,
    memory_scope: 'reviewed_agent', profile: { name: 'Bole', display_name: displayName, responsibility: 'AR', status: 'active',
      capabilities: [], work_kinds: [], agent_type: 'hr' } });
  const application = { personal: { renameProjectAgent: async (agentId, body) => {
    calls.push([agentId, body]);
    return record(agentId, body.display_name ?? 'Bole');
  } } };
  const renamed = await renameProjectAgent(application, { personalSpaceId: 'space-a', agentId: 'employee.bole', displayName: '伯乐' });
  assert.equal(renamed.profile.displayName, '伯乐');
  assert.equal(renamed.profile.name, 'Bole');
  await renameProjectAgent(application, { personalSpaceId: 'space-a', agentId: 'employee.bole', displayName: null });
  assert.deepEqual(calls, [
    ['employee.bole', { personal_space_id: 'space-a', display_name: '伯乐' }],
    ['employee.bole', { personal_space_id: 'space-a', display_name: null }]
  ]);
});

test('a renamed record carries its 原名 and name history, and the renames list names who kept each name', async () => {
  const change = { name: 'Morgan Vale', until: '2026-11-23T00:00:00Z', reason: 'duplicate_name',
    kept_by_agent_id: 'morgan-a', gave_way: 'less_recent' };
  const listed = { seen_until: null, items: [{ agent_id: 'morgan-b', display_name: 'Lyra Lane', status: 'active', change,
    kept_by_name: 'Morgan Vale' }] };
  const calls = [];
  const application = { personal: {
    renameProjectAgent: async agentId => ({ agent_id: agentId, personal_space_id: 'space-a', former_name: 'Morgan Vale',
      name_history: [change], profile: { name: '开发', display_name: 'Lyra Lane', responsibility: 'Synthetic', status: 'active' } }),
    listAgentNameChanges: async () => listed,
    markAgentNameChangesSeen: async body => { calls.push(body); return { ...listed, seen_until: body.until }; }
  } };
  const renamed = await renameProjectAgent(application, { personalSpaceId: 'space-a', agentId: 'morgan-b', displayName: 'Lyra Lane' });
  assert.equal(renamed.formerName, 'Morgan Vale');
  assert.deepEqual(renamed.nameHistory, [{ name: 'Morgan Vale', until: '2026-11-23T00:00:00Z', reason: 'duplicate_name',
    keptByAgentId: 'morgan-a', gaveWay: 'less_recent' }]);
  assert.deepEqual(await listAgentNameChanges(application, { personalSpaceId: 'space-a' }), { seenUntil: null,
    items: [{ agentId: 'morgan-b', displayName: 'Lyra Lane', status: 'active', keptByName: 'Morgan Vale',
      change: renamed.nameHistory[0] }] });
  const seen = await markAgentNameChangesSeen(application, { personalSpaceId: 'space-a', until: '2026-11-23T00:00:00Z' });
  assert.equal(seen.seenUntil, '2026-11-23T00:00:00Z');
  assert.deepEqual(calls, [{ personal_space_id: 'space-a', until: '2026-11-23T00:00:00Z' }]);
});

test('settling shared names: the plan is read with the person\'s keepers, and only the agreed renames are sent', async () => {
  const sent = [];
  const plan = { renames: 1, groups: [{ name: 'Morgan Vale', members: [
    { agent_id: 'morgan-a', name: 'Morgan Vale', status: 'active', projects: ['Saturn'], keeps: true, new_name: null, gave_way: null },
    { agent_id: 'morgan-b', name: 'Morgan Vale', status: 'active', projects: ['Backup'], keeps: false, new_name: 'Nora Hill',
      gave_way: 'less_recent' }] }] };
  const application = { personal: {
    agentNameFixPlan: async (space, keep) => { sent.push(['plan', space, keep]); return plan; },
    applyAgentNameFixes: async body => { sent.push(['apply', body]); return { renames: 0, groups: [] }; }
  } };
  const read = await agentNameFixPlan(application, { personalSpaceId: 'space-a', keep: ['morgan-a'] });
  assert.deepEqual(read.groups[0].members[1], { agentId: 'morgan-b', name: 'Morgan Vale', status: 'active',
    projects: ['Backup'], keeps: false, newName: 'Nora Hill', gaveWay: 'less_recent' });
  assert.deepEqual(await applyAgentNameFixes(application, { personalSpaceId: 'space-a', keep: [],
    renames: { 'morgan-b': 'Nora Hill' } }), { renames: 0, groups: [] });
  assert.deepEqual(sent, [['plan', 'space-a', ['morgan-a']],
    ['apply', { personal_space_id: 'space-a', keep: [], renames: { 'morgan-b': 'Nora Hill' } }]]);
});

test('a refused name reaches the console with who has it and free names as fields, not only as a sentence', async () => {
  const detail = { code: 'agent_name_taken', message: 'agent_name_taken: another Agent in this personal space already '
    + 'uses this name; used by: Morgan (Vale) (agent-x) in Saturn | A; free names: Nora Lin. Choose one or propose another.',
  used_by: [{ agent_id: 'agent-x', name: 'Morgan (Vale)', projects: ['Saturn | A'] }], free_names: ['Nora Lin'] };
  const client = new GraphitiProviderClient({ baseUrl: 'http://provider.test', accessToken: 'synthetic-token',
    fetchImpl: async () => new Response(JSON.stringify({ detail }), { status: 409,
      headers: { 'content-type': 'application/json' } }) });
  const refused = await client.renameProjectAgent('agent-y', { personal_space_id: 'space-a', display_name: 'morgan (vale)' })
    .then(() => null, error => error);
  const { status, body } = mapHttpError(refused);
  assert.equal(status, 409);
  assert.equal(body.code, 'agent_name_taken');
  assert.deepEqual(body.usedBy, [{ agentId: 'agent-x', name: 'Morgan (Vale)', projects: ['Saturn | A'] }]);
  assert.deepEqual(body.freeNames, ['Nora Lin']);
  assert.match(body.error, /^agent_name_taken/u);
});
