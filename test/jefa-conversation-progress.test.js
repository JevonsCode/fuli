import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AUTO_CLOSE_SUMMARY, AUTO_KEEP_REASON } from '../src/conversations/stop-auto-close.js';
import { safeConversationContent } from '../src/graphiti/agent-conversations.js';
import { parseConversationProgressArgs, projectConversationProgress } from '../src/employees/project-conversation-progress.js';
import { projectAgentCoordinationPolicyRecord } from '../src/graphiti/project-agent-mapping.js';
import { createEmployeeFixture } from '../test-support/employee-fixture.js';

// Jefa's list_project_conversations (11-19): where each conversation of the
// projects she manages stands, read only from what FULI recorded. Synthetic
// projects, FLAs, sessions and conversations only.
const SPACE = 'synthetic-space';
const ALPHA = 'synthetic-alpha';
const BETA = 'synthetic-beta';
const GAMMA = 'synthetic-gamma';
const managed = [{ id: ALPHA, name: 'Alpha（测试）' }, { id: BETA, name: 'Beta（测试）' }];
const agent = (agentId, name, projects, employeeNumber) => ({ agentId, profile: { name: `${name} role`, displayName: name },
  ...(employeeNumber ? { employeeNumber } : {}),
  assignments: projects.map((personalProjectId) => ({ personalProjectId, status: 'active' })) });
const AGENTS = [agent('lead-alpha', 'Ada Lead', [ALPHA], 'FLA-0007'), agent('dev-alpha', 'Dev Ray', [ALPHA]),
  agent('lead-beta', 'Bea Lead', [BETA], 'FLA-0012'), agent('lead-gamma', 'Gus Lead', [GAMMA]),
  { ...agent('gone-alpha', 'Old Hand', []), assignments: [{ personalProjectId: ALPHA, status: 'ended' }] }];
const LEADS = { [ALPHA]: 'lead-alpha', [BETA]: 'lead-beta' };

const minute = (n) => new Date(Date.UTC(2026, 10, 18, 15, 0) + n * 60_000).toISOString();
// What the Provider answers for a list with_progress (store_agent_conversations.py _with_progress).
const conversation = (id, n, { title, sessions = [], progress = null, activity = null } = {}) =>
  ({ id, title, last_activity: minute(n), status: 'reported', sessions, progress, task_activity: activity });
const checkpoint = (n, summary, source = null) => ({ at: minute(n), status: 'completed', summary, source });
const receipt = (n, summary, client, sessionId, agentId, eventId, extra = {}) => ({ at: minute(n), status: 'running', summary,
  source: { client, session_id: sessionId, task_id: 'synthetic-task', event_id: eventId, agent_id: agentId }, ...extra });

// A Provider double that pages like the real list: newest first, then id, after a keyset position.
function fakeApp(byProjectAgent, { agents = AGENTS, policy } = {}) {
  const calls = [];
  const app = { calls, policyReads: 0, agentReads: 0, inFlight: 0, maxInFlight: 0,
    listProjectAgents: async () => { app.agentReads += 1; return structuredClone(agents); },
    // The real port's answer: projectAgentCoordinationPolicyRecord over the Provider's record.
    getProjectAgentCoordinationPolicy: policy ?? (async ({ personalProjectId }) => {
      app.policyReads += 1;
      return projectAgentCoordinationPolicyRecord({ personal_project_id: personalProjectId,
        team_lead_agent_id: LEADS[personalProjectId] ?? null });
    }),
    queryAgentConversations: async (input) => {
      calls.push(input);
      app.inFlight += 1;
      app.maxInFlight = Math.max(app.maxInFlight, app.inFlight);
      await new Promise((resolve) => setImmediate(resolve));
      app.inFlight -= 1;
      if (input.agentId === 'unreadable-agent') throw new Error('provider refused');
      const after = input.afterPosition;
      const rows = [...(byProjectAgent[`${input.personalProjectId}/${input.agentId}`] ?? [])]
        .sort((left, right) => right.last_activity.localeCompare(left.last_activity) || (left.id < right.id ? -1 : 1))
        .filter((row) => !after || row.last_activity < after.lastActivity
          || (row.last_activity === after.lastActivity && row.id > after.id));
      return { conversations: structuredClone(rows.slice(0, input.limit)) };
    } };
  return app;
}
const read = (app, args, projects = managed) =>
  projectConversationProgress(app, { spaceId: SPACE, managedProjects: projects, request: parseConversationProgressArgs(args) });

const codexSession = { client: 'codex', session_id: 'synthetic-shared-session', last_seen: minute(30) };
const claudeSession = { client: 'claude_code', session_id: 'synthetic-shared-session', last_seen: minute(20) };
const DATA = {
  [`${ALPHA}/lead-alpha`]: [
    // Real progress at minute 23, then automatic closes and heartbeats until minute 40.
    conversation('alpha-1', 40, { title: '接任项目负责人', sessions: [codexSession, claudeSession],
      progress: checkpoint(23, 'Reviewed the release notes', { client: 'codex', session_id: 'synthetic-shared-session',
        sequence: 7, event_id: 'synthetic:summary' }) }),
    // Nothing reported yet, and no session FULI knows: no progress, sessions unknown.
    conversation('alpha-2', 35),
  ],
  [`${ALPHA}/dev-alpha`]: [conversation('alpha-dev-1', 38, { sessions: [claudeSession],
    progress: checkpoint(30, 'Fixed the parser'),
    activity: receipt(37, 'Running the parser suite', 'claude_code', 'synthetic-shared-session', 'dev-alpha', 'synthetic-event-1') })],
  [`${ALPHA}/gone-alpha`]: [conversation('alpha-gone', 50, { progress: checkpoint(50, 'Never listed') })],
  // The same title in another project is another conversation.
  [`${BETA}/lead-beta`]: [conversation('beta-1', 12, { title: '接任项目负责人', progress: checkpoint(11, 'Beta handover noted'),
    activity: receipt(5, 'An older receipt', 'codex', 'synthetic-beta-session', 'lead-beta', 'synthetic-event-2') })],
  [`${GAMMA}/lead-gamma`]: [conversation('gamma-1', 60, { progress: checkpoint(60, 'Gamma secret') })],
};

test('a page of projects lists each managed project, its lead by name and number, and latest conversations', async () => {
  const app = fakeApp(DATA);
  const page = await read(app, { perProject: 2 });
  assert.equal(page.projectCount, 2);
  assert.deepEqual(page.projects.map((entry) => [entry.project.id, entry.lead]),
    [[ALPHA, { agentId: 'lead-alpha', name: 'Ada Lead', employeeNumber: 'FLA-0007' }],
      [BETA, { agentId: 'lead-beta', name: 'Bea Lead', employeeNumber: 'FLA-0012' }]]);
  assert.equal(JSON.stringify(page).includes('Gamma secret'), false, 'a project Jefa does not manage is not read');
  assert.equal(app.calls.some((call) => call.personalProjectId === GAMMA), false);
  assert.equal(JSON.stringify(page).includes('Never listed'), false, 'an FLA whose assignment ended is not read');
  const [alpha, beta] = page.projects;
  assert.deepEqual(alpha.conversations.map((row) => row.conversationId), ['alpha-1', 'alpha-dev-1']);
  assert.ok(alpha.nextCursor, 'a project with more conversations hands a cursor for them');
  const rest = await read(app, { projectId: ALPHA, cursor: alpha.nextCursor });
  assert.deepEqual(rest.conversations.map((row) => row.conversationId), ['alpha-2']);
  // Same title, different projects and conversations: never merged.
  assert.deepEqual([alpha.conversations[0].title, beta.conversations[0].title], ['接任项目负责人', '接任项目负责人']);
  assert.equal(beta.conversations[0].progress.summary, 'Beta handover noted', 'the later evidence wins');
  for (const call of app.calls) assert.deepEqual([call.mode, call.withProgress, call.ownerInspection], ['list', true, true]);
});

test('progress keeps its own time and source while activity moves on; the later evidence wins', async () => {
  const app = fakeApp(DATA);
  const { conversations } = await read(app, { projectId: ALPHA, limit: 3 });
  const [first, dev, second] = conversations;
  assert.deepEqual([first.lastActivity, first.progress.at], [minute(40), minute(23)], 'activity at :40, progress at :23');
  assert.deepEqual(first.progress, { kind: 'checkpoint', at: minute(23), status: 'completed', summary: 'Reviewed the release notes',
    source: { client: 'codex', sessionId: 'synthetic-shared-session', sequence: 7, eventId: 'synthetic:summary' },
    reportedBy: { agentId: 'lead-alpha', name: 'Ada Lead', employeeNumber: 'FLA-0007' } });
  // Two clients share one session ID string: each is named with its own client, never merged.
  assert.deepEqual(first.sessions.map((session) => [session.client, session.sessionId]),
    [['codex', 'synthetic-shared-session'], ['claude_code', 'synthetic-shared-session']]);
  // An earlier checkpoint and a later task-activity receipt of the same native session: the receipt.
  assert.deepEqual([dev.conversationId, dev.progress.kind, dev.progress.at, dev.progress.source],
    ['alpha-dev-1', 'task_activity', minute(37), { client: 'claude_code', sessionId: 'synthetic-shared-session',
      taskId: 'synthetic-task', eventId: 'synthetic-event-1' }]);
  assert.deepEqual(dev.handledBy, { agentId: 'dev-alpha', name: 'Dev Ray', employeeNumber: null });
  assert.deepEqual([second.conversationId, second.progress, second.sessions, second.lastActivity], ['alpha-2', null, [], minute(35)]);
});

test('a member reporting on a lead conversation is named as the reporter, beside the holder and the lead', async () => {
  // What the Provider links (store_agent_conversations.py _linked_task_activity): the lead's Codex
  // session, a later receipt the member recorded there; another one in the same second keeps its ID.
  const data = { [`${ALPHA}/lead-alpha`]: [conversation('alpha-held', 45, { sessions: [codexSession],
    progress: checkpoint(20, 'Planned the release'),
    activity: receipt(44, 'Ran the release checks', 'codex', 'synthetic-shared-session', 'dev-alpha', 'synthetic-event-b',
      { same_second_event_ids: ['synthetic-event-a'] }) })] };
  const view = await read(fakeApp(data), { projectId: ALPHA });
  const [row] = view.conversations;
  assert.deepEqual(view.lead, { agentId: 'lead-alpha', name: 'Ada Lead', employeeNumber: 'FLA-0007' });
  assert.deepEqual(row.handledBy, { agentId: 'lead-alpha', name: 'Ada Lead', employeeNumber: 'FLA-0007' });
  assert.deepEqual(row.progress.reportedBy, { agentId: 'dev-alpha', name: 'Dev Ray', employeeNumber: null });
  assert.deepEqual(row.progress.source, { client: 'codex', sessionId: 'synthetic-shared-session', taskId: 'synthetic-task',
    eventId: 'synthetic-event-b', sameSecondEventIds: ['synthetic-event-a'] });
  await assert.rejects(read(fakeApp(data), { projectId: GAMMA }), { code: 'project_not_managed', status: 403 });
});

test('the Provider knows the Stop hook\'s automatic-close texts exactly, as the hook writes them', () => {
  const python = readFileSync(new URL('../graph-provider/fuli_graph/conversation_context.py', import.meta.url), 'utf8');
  const block = /AUTOMATIC_CLOSE_SUMMARIES = frozenset\(\{([\s\S]*?)\}\)/.exec(python)[1];
  const texts = [...block.matchAll(/'([^']*)'/g)].map((match) => match[1]).sort();
  assert.deepEqual(texts, [AUTO_CLOSE_SUMMARY, AUTO_KEEP_REASON].sort());
  // The append stores what safeConversationContent returns: the same text.
  for (const text of texts) assert.equal(safeConversationContent(text), text);
});

test('525 conversations of two FLAs page to the end, each once, at the same cost per page', async () => {
  const data = { [`${ALPHA}/lead-alpha`]: [], [`${ALPHA}/dev-alpha`]: [] };
  for (let index = 0; index < 525; index += 1) {
    // Pairs share a minute, so ties are broken by ID across FLAs.
    data[`${ALPHA}/${index % 2 ? 'dev-alpha' : 'lead-alpha'}`].push(conversation(`c-${String(index).padStart(3, '0')}`, -Math.floor(index / 2)));
  }
  const app = fakeApp(data);
  const seen = [];
  let cursor;
  let pages = 0;
  do {
    const before = app.calls.length;
    const page = await read(app, { projectId: ALPHA, limit: 20, ...(cursor ? { cursor } : {}) });
    const calls = app.calls.slice(before);
    assert.equal(calls.length, 2, 'one read per FLA per page');
    assert.ok(calls.every((call) => call.limit === 21), 'each read asks for one page and one more row');
    seen.push(...page.conversations.map((row) => row.conversationId));
    cursor = page.nextCursor;
    pages += 1;
  } while (cursor);
  assert.equal(pages, 27);
  assert.equal(seen.length, 525);
  assert.equal(new Set(seen).size, 525);
  assert.deepEqual(seen.slice(0, 3), ['c-000', 'c-001', 'c-002']);
  assert.equal(seen.at(-1), 'c-524');
});

test('arguments are checked before anything is read; a cursor is opaque and only good where it was given', async () => {
  const app = fakeApp(DATA);
  await assert.rejects(read(app, { projectId: GAMMA }), { code: 'project_not_managed', status: 403 });
  assert.throws(() => parseConversationProgressArgs({ cursor: 'c:3' }), { code: 'invalid_cursor' });
  assert.throws(() => parseConversationProgressArgs({ limit: 11 }), { code: 'invalid_input' });
  assert.throws(() => parseConversationProgressArgs({ projectId: ALPHA, limit: 0 }), { code: 'invalid_input' });
  assert.throws(() => parseConversationProgressArgs({ perProject: 2.5 }), { code: 'invalid_input' });
  assert.throws(() => parseConversationProgressArgs({ projectId: '  ' }), { code: 'invalid_input' });
  const forged = Buffer.from(JSON.stringify(['c', ALPHA, 'not a time', 'x'])).toString('base64url');
  assert.throws(() => parseConversationProgressArgs({ projectId: ALPHA, cursor: forged }), { code: 'invalid_cursor' });
  const { nextCursor } = await read(app, { projectId: ALPHA, limit: 1 });
  assert.throws(() => parseConversationProgressArgs({ projectId: BETA, cursor: nextCursor }), { code: 'invalid_cursor' },
    'a cursor of one project is refused for another');
  assert.throws(() => parseConversationProgressArgs({ cursor: nextCursor }), { code: 'invalid_cursor' });
  const pastTheEnd = Buffer.from(JSON.stringify(['p', 9])).toString('base64url');
  const reads = app.calls.length;
  await assert.rejects(read(app, { cursor: pastTheEnd }), { code: 'invalid_cursor' });
  assert.equal(app.calls.length, reads, 'nothing is read for a refused request');
  const projects = await read(app, { limit: 1 });
  const next = await read(app, { limit: 1, cursor: projects.nextCursor });
  assert.deepEqual([projects.projects[0].project.id, next.projects[0].project.id, next.nextCursor], [ALPHA, BETA, undefined]);
});

test('an unreadable FLA marks the page incomplete; an unreadable policy marks the lead unknown', async () => {
  const agents = [...AGENTS, agent('unreadable-agent', 'Una Known', [BETA], 'FLA-0099')];
  const app = fakeApp(DATA, { agents, policy: async () => { throw new Error('policy unavailable'); } });
  const view = await read(app, { projectId: BETA });
  assert.deepEqual(view.unreadable, [{ agentId: 'unreadable-agent', name: 'Una Known', employeeNumber: 'FLA-0099' }]);
  assert.equal(view.incomplete, true);
  assert.deepEqual(view.lead, { unknown: true });
  assert.deepEqual(view.conversations.map((row) => row.conversationId), ['beta-1']);
  const noLead = fakeApp(DATA, { policy: async () => projectAgentCoordinationPolicyRecord({}) });
  assert.equal((await read(noLead, { projectId: BETA })).lead, null, 'no lead set reads null, not unknown');
});

test('reads across projects and FLAs run at most four at a time', async () => {
  const projects = Array.from({ length: 10 }, (_, index) => ({ id: `synthetic-p${index}`, name: `P${index}` }));
  const agents = projects.flatMap((project, index) => [0, 1, 2].map((n) => agent(`fla-${index}-${n}`, `F${index}${n}`, [project.id])));
  const app = fakeApp({}, { agents });
  const page = await read(app, { limit: 10 }, projects);
  assert.equal(page.projects.length, 10);
  assert.equal(app.calls.length, 30);
  assert.ok(app.maxInFlight <= 4, `at most 4 in flight, saw ${app.maxInFlight}`);
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
  const before = reads.length;
  await assert.rejects(call({ cursor: 'p:1' }), { code: 'invalid_cursor' });
  assert.equal(reads.length, before, 'a refused argument reads no conversation');
  assert.ok(page.collaboration_receipt, 'the call carries Jefa\'s receipt like her other tools');
});
