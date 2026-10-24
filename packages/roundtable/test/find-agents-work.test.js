import assert from 'node:assert/strict';
import test from 'node:test';

import { ROUNDTABLE_HOST_METHODS } from '../src/host.js';
import { createAgentRoundtable } from '../src/roundtable/service.js';
import { createRoundtableStore } from '../src/roundtable/store.js';

const agent = (agentId, name, { responsibility = '项目负责人', capabilities = [], status = 'active' } = {}) => ({ agentId,
  profile: { name, displayName: name, responsibility, capabilities, allowedClients: ['codex'], status } });

// Synthetic directory order: a substring hit, the standing lead, an exact name.
const AGENTS = [agent('bo', 'Bo Hart', { capabilities: ['工时统计'] }), agent('ada', 'Ada Lane'),
  agent('exact', '工时'), agent('gone', 'Gone Lead', { status: 'retired' })];
const LEADS = { 'proj-idev': 'ada', 'proj-other': 'ada' };
const IDEV = { projectId: 'proj-idev', project: 'iDev 工时', responsibility: '每天填写 iDev 工时', matchedTerms: ['工时'] };

function roundtable({ matchWork } = {}) {
  const calls = [];
  const host = { ...Object.fromEntries(ROUNDTABLE_HOST_METHODS.map(name => [name, async () => null])),
    spaceId: () => 'space', listAgents: async () => AGENTS, recentSessions: async () => [],
    getProject: async projectId => ({ projectId, name: projectId, temporary: false, archived: false }),
    projectLeadId: async projectId => LEADS[projectId] ?? null,
    ...(matchWork ? { matchWork: async query => { calls.push(query); return matchWork(query); } } : {}) };
  return { calls, roundtable: createAgentRoundtable({ host, openStore: () => createRoundtableStore() }) };
}

const found = async (service, input) => (await service.findAgents(input)).agents
  .map(({ agentId, matchedWork }) => matchedWork ? [agentId, matchedWork] : agentId);

test('a host without matchWork finds Agents exactly as before', async () => {
  const { roundtable: service } = roundtable();
  assert.deepEqual(await found(service, { query: '工时' }), ['bo', 'exact']);
});

test('the leads the person\'s work names are found, after an exact name and before other hits', async () => {
  const { roundtable: service, calls } = roundtable({ matchWork: () => [{ agentId: 'ada', ...IDEV },
    { agentId: 'gone', projectId: 'proj-old', project: 'Old 工时' }] });
  assert.deepEqual(await found(service, { query: ' 工时 ' }), ['exact', ['ada', [IDEV]], 'bo']);
  assert.deepEqual(calls, ['工时']);
  await found(service, {});
  assert.deepEqual(calls, ['工时'], 'no query, no work matching');
});

test('several matches of one lead are all shown, each with its project', async () => {
  const project = { projectId: 'proj-other', project: '工时 Other' };
  const { roundtable: service } = roundtable({ matchWork: () => [{ agentId: 'ada', ...IDEV }, { agentId: 'ada', ...project }] });
  assert.deepEqual((await found(service, { query: '工时' }))[1], ['ada', [IDEV, project]]);
});

test('asked for one project, only that project\'s work matches its lead', async () => {
  const { roundtable: service } = roundtable({ matchWork: () => [{ agentId: 'ada', ...IDEV }] });
  assert.deepEqual(await found(service, { query: '工时', personalProjectId: 'proj-other' }), []);
  assert.deepEqual(await found(service, { query: '工时', personalProjectId: 'proj-idev' }), [['ada', [IDEV]]]);
});
