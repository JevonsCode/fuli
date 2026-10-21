import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { connectMcp } from '../test-support/mcp-client.js';
import { loadProjectAgentContinuity } from '../src/graphiti/project-agent-task-entry.js';
import { upsertProjectAgent } from '../src/graphiti/project-agent-workflows.js';
import { listenFetchableServer } from '../src/server/listen.js';

const SPACE = 'personal-1';
const AGENT = 'engineer-x';
const REASON = 'Reported finished work without running the test suite, twice.';
const LESSON = 'Run the relevant test suite before reporting a task as done.';
const STAMP = '2026-10-20T08:00:00Z';

test('Bole dismisses through one MCP tool: a real reason in, lessons and a handoff kept, a compact receipt out', async (t) => {
  const requests = [];
  const graph = await fakeProvider((request) => {
    requests.push(request);
    if (request.path === '/health') return { status: 'ready', providerId: 'personal' };
    if (request.path === `/v1/project-agents/${AGENT}` && request.method === 'GET') return agentRecord();
    if (request.path === `/v1/project-agents/${AGENT}/memory`) return memoryView(request.query.personal_project_id ?? null);
    if (request.path === `/v1/project-agents/${AGENT}/dismissal` && request.method === 'POST') return {
      dismissal_id: 'dismissal-1', agent_id: AGENT, agent_name: 'Synthetic engineer', employee_number: '000012',
      occupation_role: 'engineering', project_ids: ['project-a'], lesson_count: 1,
      handoff_filename: request.body.handoff.filename, handoff_characters: request.body.handoff.markdown.length,
      dismissed_at: STAMP, replayed: false
    };
    if (request.path === `/v1/project-agents/${AGENT}/dismissal`) return {
      dismissal_id: 'dismissal-1', agent_id: AGENT, agent_name: 'Synthetic engineer', employee_number: '000012',
      occupation_role: 'engineering', occupation_tags: [], project_ids: ['project-a'], reason: REASON,
      lessons: [LESSON], handoff: { filename: 'handoff.md', markdown: '# Handoff\n' },
      source_application: 'claude_code', source_session_id: null, dismissed_at: STAMP
    };
    if (request.path === '/v1/project-agent-dismissal-lessons') return { total: 1, items: [{
      dismissal_id: 'dismissal-1', agent_id: AGENT, agent_name: 'Synthetic engineer', employee_number: '000012',
      occupation_role: 'engineering', project_ids: ['project-a'], reason: REASON, lessons: [LESSON],
      dismissed_at: STAMP, matched_by: ['occupation']
    }] };
    return {};
  });
  t.after(() => new Promise(resolve => graph.server.close(resolve)));
  const connection = await connectMcp(runtimeConfig(graph.url), { sourceApplication: 'claude_code' });
  t.after(() => connection.close());
  const call = (name, args) => connection.client.callTool({ name, arguments: args });

  const tools = new Map((await connection.client.listTools()).tools.map(tool => [tool.name, tool]));
  assert.equal(tools.has('delete_project_agent'), false);
  const dismiss = tools.get('dismiss_project_agent');
  assert.match(dismiss.description, /ask the user why/i);
  assert.match(dismiss.description, /never call this without/i);
  assert.match(dismiss.description, /initiates or approves/i);
  assert.deepEqual(dismiss.inputSchema.required, ['personalSpaceId', 'agentId', 'reason']);
  assert.ok(tools.has('list_agent_dismissal_lessons') && tools.has('get_agent_handoff'));

  const archivedByUpsert = await call('upsert_project_agent', { personalSpaceId: SPACE, agentId: AGENT,
    profile: { name: 'Synthetic engineer', responsibility: 'Maintain the sample.', status: 'archived' } });
  assert.equal(archivedByUpsert.isError, true);
  for (const reason of [undefined, '   ', 'n/a', 'archived by user', '没有理由', 'Archived.']) {
    const refused = await call('dismiss_project_agent', { personalSpaceId: SPACE, agentId: AGENT,
      ...(reason === undefined ? {} : { reason }) });
    assert.equal(refused.isError, true, String(reason));
  }
  assert.equal(requests.some(({ method, path }) => method !== 'GET' && path.startsWith('/v1/project-agents')), false);

  const dismissed = await call('dismiss_project_agent', { personalSpaceId: SPACE, agentId: AGENT,
    reason: `  ${REASON}  `, lessons: [LESSON] });
  assert.equal(dismissed.isError, undefined, JSON.stringify(dismissed));
  const [write] = requests.filter(({ method, path }) => method === 'POST' && path.endsWith('/dismissal'));
  assert.equal(write.body.personal_space_id, SPACE);
  assert.equal(write.body.reason, REASON);
  assert.deepEqual(write.body.lessons, [LESSON]);
  assert.equal(write.body.source_application, 'claude_code');
  assert.match(write.body.handoff.filename, /^fuli-engineer-x-handoff\.md$/);
  for (const text of ['Synthetic engineer', REASON, LESSON, 'Global notes kept.', 'Project notes kept.', 'project-a']) {
    assert.ok(write.body.handoff.markdown.includes(text), text);
  }
  const receipt = dismissed.structuredContent;
  assert.equal(receipt.status, 'dismissed');
  assert.equal(receipt.dismissalId, 'dismissal-1');
  assert.equal(receipt.lessonCount, 1);
  assert.equal(receipt.handoff.characters, write.body.handoff.markdown.length);
  assert.match(receipt.summary, /Synthetic engineer.*FLA 000012/);
  assert.equal(JSON.stringify(receipt).includes('Project notes kept.'), false, 'the receipt never carries the handoff');

  const found = await call('list_agent_dismissal_lessons', { personalSpaceId: SPACE,
    occupations: ['engineering'], personalProjectId: 'project-a' });
  assert.equal(found.isError, undefined, JSON.stringify(found));
  const lookup = requests.find(({ path }) => path === '/v1/project-agent-dismissal-lessons');
  assert.deepEqual(lookup.query, { personal_space_id: SPACE, occupation: 'engineering',
    personal_project_id: 'project-a' });
  assert.deepEqual(found.structuredContent.lessons[0], { dismissalId: 'dismissal-1', agentId: AGENT,
    name: 'Synthetic engineer', employeeNumber: '000012', occupation: 'engineering', projectIds: ['project-a'],
    reason: REASON, lessons: [LESSON], dismissedAt: STAMP, matchedBy: ['occupation'] });

  const handoff = await call('get_agent_handoff', { personalSpaceId: SPACE, agentId: AGENT });
  assert.equal(handoff.isError, undefined, JSON.stringify(handoff));
  assert.equal(handoff.structuredContent.reason, REASON);
  assert.deepEqual(handoff.structuredContent.handoff, { format: 'markdown', filename: 'handoff.md', markdown: '# Handoff\n' });
});

test('an upsert can never archive an Agent, on any entry that reaches the workflow', async () => {
  const written = [];
  const application = { personal: { upsertProjectAgent: async (input) => written.push(input) } };
  await assert.rejects(upsertProjectAgent(application, { personalSpaceId: SPACE, agentId: AGENT,
    profile: { name: 'Synthetic engineer', responsibility: 'Maintain the sample.', status: 'archived' } }),
  /dismiss_project_agent/);
  assert.deepEqual(written, []);
});

test('the host refuses exactly the placeholder reasons the Provider refuses', () => {
  // The Provider model is the authority; both sides must list the same stand-ins.
  const words = (path, pattern) => [...readFileSync(new URL(path, import.meta.url), 'utf8').match(pattern)[1]
    .matchAll(/'([^']+)'/g)].map(match => match[1]).sort();
  const provider = words('../graph-provider/fuli_graph/project_agent_dismissal_models.py', /PLACEHOLDER_REASONS = frozenset\(\{([^}]*)\}\)/);
  const host = words('../src/graphiti/project-agent-dismissal.js', /PLACEHOLDER_REASONS = new Set\(\[([^\]]*)\]\)/);
  assert.ok(provider.length > 10);
  assert.deepEqual(host, provider);
});

test('task start reports only a count and the query for earlier dismissal lessons', async () => {
  for (const total of [2, 0]) {
    const lookups = [];
    const application = continuityApplication(async (input) => {
      lookups.push(input);
      return { total, items: [] };
    });
    const context = await loadProjectAgentContinuity(application, {
      projectId: 'project-a', agent: newcomer(), includeKnowledge: false, includeTeam: false
    });
    assert.deepEqual(lookups, [{ personalSpaceId: SPACE, occupations: ['engineering'],
      personalProjectId: 'project-a', limit: 0 }]);
    assert.equal(context.status, 'ready');
    if (!total) {
      assert.equal('dismissal_lessons' in context, false);
      continue;
    }
    assert.deepEqual(context.dismissal_lessons, { count: 2, tool: 'list_agent_dismissal_lessons',
      arguments: { personalSpaceId: SPACE, occupations: ['engineering'], personalProjectId: 'project-a' },
      guidance: context.dismissal_lessons.guidance });
    assert.match(context.dismissal_lessons.guidance, /only when/i);
  }
  const unavailable = await loadProjectAgentContinuity(continuityApplication(async () => {
    throw new Error('Provider is older than dismissal lessons');
  }), { projectId: 'project-a', agent: newcomer(), includeKnowledge: false, includeTeam: false });
  assert.equal(unavailable.status, 'ready', 'an unavailable hint never degrades task entry');
  assert.equal('dismissal_lessons' in unavailable, false);
});

function continuityApplication(listProjectAgentDismissalLessons) {
  return { config: { personal: { spaceId: SPACE } }, personal: {
    getProjectAgentMemory: async ({ personalProjectId }) => ({ personal_space_id: SPACE,
      personal_project_id: personalProjectId, agent_id: 'newcomer', revision: 0, current: null, history: [],
      scope: personalProjectId ? 'private_agent_project' : 'private_agent_global', work_log: [] }),
    getPersonalProject: async () => ({ project_id: 'project-a', profile: { name: 'Synthetic project' } }),
    listProjectAgentTasks: async () => [],
    listProjectAgentDismissalLessons
  } };
}

function newcomer() {
  return { agentId: 'newcomer', memoryScope: 'reviewed_agent', occupation: { role: 'engineering', tags: [] },
    profile: { name: 'Newcomer', responsibility: 'Maintain the sample.', initialPreferences: [], status: 'active' } };
}

function agentRecord() {
  return { agent_id: AGENT, employee_number: '000012', personal_space_id: SPACE, personal_project_id: null,
    profile: { name: 'Synthetic engineer', responsibility: 'Maintain the sample.', capabilities: ['coding'],
      initial_preferences: [], status: 'active', agent_type: 'durable', allowed_clients: ['claude_code'] },
    memory_scope: 'reviewed_agent',
    assignments: [{ assignment_id: 'assignment-a', personal_space_id: SPACE, personal_project_id: 'project-a',
      agent_id: AGENT, responsibility: 'Maintain the sample.', reason: 'Synthetic assignment', status: 'active',
      revision: 0, assigned_at: STAMP, updated_at: STAMP }],
    occupation: { role: 'engineering', tags: [], updated_at: STAMP },
    created_at: STAMP, updated_at: STAMP };
}

function memoryView(projectId) {
  const record = { checkpoint_id: `checkpoint-${projectId ?? 'global'}`, personal_space_id: SPACE,
    personal_project_id: projectId, agent_id: AGENT, revision: 1, source_application: 'claude_code',
    created_at: STAMP, memory: { summary: projectId ? 'Project notes kept.' : 'Global notes kept.',
      decisions: [], open_threads: [], next_actions: [] } };
  return { personal_space_id: SPACE, personal_project_id: projectId, agent_id: AGENT, revision: 1,
    scope: projectId ? 'private_agent_project' : 'private_agent_global', current: record, history: [record],
    work_log: [] };
}

function runtimeConfig(providerUrl) {
  const path = join(mkdtempSync(join(tmpdir(), 'fuli-dismissal-')), 'runtime.json');
  writeFileSync(path, JSON.stringify({ version: 1, personal: { providerUrl, accessToken: 'personal-access',
    principalId: 'principal-personal', spaceId: SPACE }, workspaces: [] }));
  return path;
}

async function fakeProvider(handler) {
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const url = new URL(request.url, 'http://localhost');
    const payload = handler({ path: url.pathname, query: Object.fromEntries(url.searchParams),
      method: request.method, body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(payload));
  });
  await listenFetchableServer(server, 0);
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}
