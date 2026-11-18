import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AUTO_CLOSE_SUMMARY } from '../src/conversations/stop-auto-close.js';
import { projectConversationProgress } from '../src/employees/project-conversation-progress.js';
import { createEmployeeFixture } from '../test-support/employee-fixture.js';

// Jefa's list_project_conversations (11-19): where each conversation of the
// projects she manages stands, read only from what FULI recorded. Synthetic
// projects, FLAs, sessions and conversations only.
const SPACE = 'synthetic-space';
const ALPHA = 'synthetic-alpha';
const BETA = 'synthetic-beta';
const GAMMA = 'synthetic-gamma';
const managed = [{ id: ALPHA, name: 'Alpha（测试）' }, { id: BETA, name: 'Beta（测试）' }];
const agent = (agentId, name, projects) => ({ agentId, profile: { name, displayName: name },
  assignments: projects.map((personalProjectId) => ({ personalProjectId, status: 'active' })) });
const AGENTS = [agent('lead-alpha', 'Ada Lead', [ALPHA]), agent('dev-alpha', 'Dev Ray', [ALPHA]),
  agent('lead-beta', 'Bea Lead', [BETA]), agent('lead-gamma', 'Gus Lead', [GAMMA]),
  { ...agent('gone-alpha', 'Old Hand', []), assignments: [{ personalProjectId: ALPHA, status: 'ended' }] }];

const minute = (n) => new Date(Date.UTC(2026, 10, 18, 15, 0) + n * 60_000).toISOString();
const conversation = (id, n, { title, sessions = [], tasks = [] } = {}) =>
  ({ id, title, last_activity: minute(n), status: 'reported', sessions, recent_tasks: tasks });
const task = (n, summary, source = null) => ({ at: minute(n), status: 'completed', summary, source });

function fakeApp(byProjectAgent) {
  const calls = [];
  return { calls,
    listProjectAgents: async () => structuredClone(AGENTS),
    getProjectAgentCoordinationPolicy: async ({ personalProjectId }) =>
      ({ team_lead_agent_id: { [ALPHA]: 'lead-alpha', [BETA]: 'lead-beta' }[personalProjectId] }),
    queryAgentConversations: async (input) => {
      calls.push(input);
      if (input.agentId === 'unreadable-agent') throw new Error('provider refused');
      const rows = [...(byProjectAgent[`${input.personalProjectId}/${input.agentId}`] ?? [])]
        .sort((left, right) => right.last_activity.localeCompare(left.last_activity) || left.id.localeCompare(right.id));
      return { conversations: structuredClone(rows.slice(input.after, input.after + input.limit)) };
    } };
}

const codexSession = { client: 'codex', session_id: 'synthetic-codex-session', last_seen: minute(30) };
const claudeSession = { client: 'claude_code', session_id: 'synthetic-claude-session', last_seen: minute(20) };
const DATA = {
  [`${ALPHA}/lead-alpha`]: [
    // Real progress at minute 23, then heartbeats and an automatic close until minute 40.
    conversation('alpha-1', 40, { title: '接任项目负责人', sessions: [codexSession, claudeSession],
      tasks: [task(10, 'Earlier result'), task(23, 'Reviewed the release notes', { sequence: 7, event_id: 'synthetic:summary',
        client: 'codex', session_id: 'synthetic-codex-session' }), task(39, AUTO_CLOSE_SUMMARY)] }),
    // Nothing but an automatic close, and no session FULI knows: no progress, sessions unknown.
    conversation('alpha-2', 35, { tasks: [task(35, AUTO_CLOSE_SUMMARY)] }),
    ...Array.from({ length: 22 }, (_, index) => conversation(`alpha-bulk-${String(index).padStart(2, '0')}`, index - 30)),
  ],
  [`${ALPHA}/dev-alpha`]: [conversation('alpha-dev-1', 38, { sessions: [claudeSession], tasks: [task(37, 'Fixed the parser')] })],
  [`${ALPHA}/gone-alpha`]: [conversation('alpha-gone', 50, { tasks: [task(50, 'Never listed')] })],
  // The same title in another project is another conversation.
  [`${BETA}/lead-beta`]: [conversation('beta-1', 12, { title: '接任项目负责人', tasks: [task(11, 'Beta handover noted')] })],
  [`${GAMMA}/lead-gamma`]: [conversation('gamma-1', 60, { tasks: [task(60, 'Gamma secret')] })],
};

test('a page of projects lists each managed project, its lead and latest conversations, never another one', async () => {
  const app = fakeApp(DATA);
  const page = await projectConversationProgress(app, { spaceId: SPACE, managedProjects: managed, args: { perProject: 2 } });
  assert.equal(page.projectCount, 2);
  assert.deepEqual(page.projects.map((entry) => [entry.project.id, entry.lead?.name]), [[ALPHA, 'Ada Lead'], [BETA, 'Bea Lead']]);
  assert.equal(JSON.stringify(page).includes('Gamma secret'), false, 'a project Jefa does not manage is not read');
  assert.equal(app.calls.some((call) => call.personalProjectId === GAMMA), false);
  assert.equal(JSON.stringify(page).includes('Never listed'), false, 'an FLA whose assignment ended is not read');
  const [alpha, beta] = page.projects;
  assert.deepEqual(alpha.conversations.map((row) => row.conversationId), ['alpha-1', 'alpha-dev-1']);
  assert.equal(alpha.moreConversations, true);
  // Same title, different projects and conversations: never merged.
  assert.deepEqual([alpha.conversations[0].title, beta.conversations[0].title], ['接任项目负责人', '接任项目负责人']);
  assert.notEqual(alpha.conversations[0].conversationId, beta.conversations[0].conversationId);
  assert.equal(beta.conversations[0].progress.summary, 'Beta handover noted');
  assert.match(page.guidance, /an automatic close is not one/);
  for (const call of app.calls) assert.deepEqual([call.mode, call.withProgress, call.ownerInspection], ['list', true, true]);
});

test('progress is the latest reported result, not the latest activity; an automatic close only moves the time', async () => {
  const app = fakeApp(DATA);
  const { conversations } = await projectConversationProgress(app, { spaceId: SPACE, managedProjects: managed,
    args: { projectId: ALPHA, limit: 3 } });
  const [first, dev, second] = conversations;
  assert.deepEqual([first.lastActivity, first.progress.at], [minute(40), minute(23)], 'activity at :40, progress at :23');
  assert.deepEqual(first.progress, { at: minute(23), status: 'completed', summary: 'Reviewed the release notes',
    reportedBy: { agentId: 'lead-alpha', name: 'Ada Lead' },
    source: { sequence: 7, event_id: 'synthetic:summary', client: 'codex', session_id: 'synthetic-codex-session' },
    locator: { conversationId: 'alpha-1', at: minute(23) } });
  // Two clients wrote to one FULI conversation: each is named with its own native session.
  assert.deepEqual(first.sessions.map((session) => [session.client, session.sessionId]),
    [['codex', 'synthetic-codex-session'], ['claude_code', 'synthetic-claude-session']]);
  assert.deepEqual(first.handledBy, { agentId: 'lead-alpha', name: 'Ada Lead' });
  assert.deepEqual([dev.conversationId, dev.handledBy.name, dev.progress.reportedBy.name], ['alpha-dev-1', 'Dev Ray', 'Dev Ray']);
  // Only an automatic close and no session FULI recorded: no progress, sessions unknown, nothing guessed.
  assert.deepEqual([second.conversationId, second.progress, second.sessions, second.lastActivity], ['alpha-2', null, [], minute(35)]);
});

test('a project with more than 20 conversations pages on, without repeats or gaps', async () => {
  const app = fakeApp(DATA);
  const seen = [];
  let cursor;
  do {
    const page = await projectConversationProgress(app, { spaceId: SPACE, managedProjects: managed,
      args: { projectId: ALPHA, limit: 20, ...(cursor ? { cursor } : {}) } });
    seen.push(...page.conversations.map((row) => row.conversationId));
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(seen.length, 25, 'all 24 of the lead (alpha-1, alpha-2 and 22 more) and the one of the developer');
  assert.equal(new Set(seen).size, seen.length);
  assert.deepEqual(seen.slice(0, 3), ['alpha-1', 'alpha-dev-1', 'alpha-2']);
  // A page of projects pages on too.
  const projects = await projectConversationProgress(app, { spaceId: SPACE, managedProjects: managed, args: { limit: 1 } });
  assert.deepEqual([projects.projects.map((entry) => entry.project.id), projects.nextCursor], [[ALPHA], 'p:1']);
  const next = await projectConversationProgress(app, { spaceId: SPACE, managedProjects: managed, args: { limit: 1, cursor: 'p:1' } });
  assert.deepEqual([next.projects.map((entry) => entry.project.id), next.nextCursor], [[BETA], undefined]);
});

test('a project Jefa does not manage, or a cursor this list never gave, is refused', async () => {
  const app = fakeApp(DATA);
  await assert.rejects(projectConversationProgress(app, { spaceId: SPACE, managedProjects: managed, args: { projectId: GAMMA } }),
    { code: 'project_not_managed', status: 403 });
  await assert.rejects(projectConversationProgress(app, { spaceId: SPACE, managedProjects: managed, args: { cursor: 'c:3' } }),
    { code: 'invalid_cursor' });
  assert.equal(app.calls.length, 0, 'nothing is read for a refused request');
});

test('an FLA whose conversations cannot be read is named as unreadable, not left out silently', async () => {
  const app = fakeApp(DATA);
  const agents = [...AGENTS, agent('unreadable-agent', 'Una Known', [BETA])];
  app.listProjectAgents = async () => agents;
  const view = await projectConversationProgress(app, { spaceId: SPACE, managedProjects: managed, args: { projectId: BETA } });
  assert.deepEqual(view.unreadable, [{ agentId: 'unreadable-agent', name: 'Una Known' }]);
  assert.deepEqual(view.conversations.map((row) => row.conversationId), ['beta-1']);
});

test('Jefa offers it as a read over the projects she manages, from any of them', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fuli-jefa-conversations-'));
  const app = createEmployeeFixture({ runtimeConfigPath: join(root, 'host/graph-runtime.json') });
  t.after(async () => { await app.close(); rmSync(root, { recursive: true, force: true }); });
  await app.employees.recruit({ templateId: 'jefa' });
  const reads = [];
  app.queryAgentConversations = async (input) => { reads.push(input.personalProjectId); return { conversations: [] }; };
  const call = (args, personalProjectId = 'employee-qa') =>
    app.employees.callTool({ templateId: 'jefa', personalProjectId, tool: 'list_project_conversations', arguments: args });
  const page = await call({});
  assert.equal(page.projectCount, 3, 'the same projects summarize_projects names: no archived or temporary one');
  assert.deepEqual(page.projects.map((entry) => entry.project.id).sort(), ['employee-qa', 'employee-qa-design', 'employee-qa-research']);
  await assert.rejects(call({ projectId: 'employee-qa-archive' }), { code: 'project_not_managed' });
  assert.ok(page.collaboration_receipt, 'the call carries Jefa\'s receipt like her other tools');
});
