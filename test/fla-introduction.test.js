import assert from 'node:assert/strict';
import test from 'node:test';

import { AgentIntroductionStore } from '../src/agent-introductions/store.js';
import { checkpointTaskKnowledge } from '../src/graphiti/agent-knowledge-workflows.js';
import { FederatedGraphApplication } from '../src/graphiti/federated-application.js';
import { introductionEntry } from '../src/graphiti/task-entry-introduction.js';

// 11-17: a new FLA introduces itself once under its name in the receipt, and
// a project handed from one FLA to another says so once, naming both.
// Synthetic Provider boundary and an in-memory store; no real data or client.

const SPACE = 'synthetic-space';
const PROJECTS = { 'project-a': 'Alpha', 'project-b': 'Beta' };

function fla(agentId, name, projectIds) {
  return { agent_id: agentId, personal_space_id: SPACE, personal_project_id: null, memory_scope: 'reviewed_agent',
    updated_at: '2026-10-01T00:00:00Z',
    assignments: projectIds.map(id => ({ personal_project_id: id, status: 'active', updated_at: '2026-10-01T00:00:00Z' })),
    profile: { name: '开发', display_name: name, responsibility: '负责构建和交付，保持主干可发布', status: 'active',
      allowed_clients: ['codex', 'claude_code'], work_kinds: ['project_context'], capabilities: [], agent_type: 'durable' } };
}

const ADA = fla('ada', 'Ada Lead', ['project-a']);
const JADE = fla('jade', 'Jade Lin', ['project-a', 'project-b']);
const JAMIE = fla('jamie', 'Jamie Ash', ['project-a', 'project-b']);

// leads: the Agent each project's own routing selects; holdBy: a project whose
// lead holds a named member as the requested Agent (a helper, not the owner).
function fixture({ leads = { 'project-a': 'ada', 'project-b': 'jade' }, holdBy = {} } = {}) {
  const roster = [ADA, JADE, JAMIE];
  const tasks = [];
  let folder = 'project-a';
  const find = id => structuredClone(roster.find(agent => agent.agent_id === id));
  const assigned = (agent, project) => agent?.assignments.some(item => item.personal_project_id === project);
  const app = new FederatedGraphApplication({ version: 1, personal: { providerUrl: 'http://127.0.0.1:8787',
    accessToken: 'synthetic-test-token', principalId: 'synthetic-user', spaceId: SPACE }, workspaces: [] },
  { projectPathResolver: () => ({ status: 'matched', basis: 'repository_root', personalProjectId: folder }),
    fetchImpl: async () => { throw new Error('Unexpected Provider request'); } });
  app.agentIntroductions = new AgentIntroductionStore();
  app.taskContextRegistry = {
    current: async (session, source) => tasks.findLast(task => task.sessionId === session
      && task.sourceApplication === source) ?? null,
    begin: async input => { const task = { ...input, token: `fuli-task-synthetic-${tasks.length}` };
      tasks.push(task); return task; }
  };
  Object.assign(app.personal, {
    listPersonalProjects: async () => Object.entries(PROJECTS).map(([id, name]) => ({ project_id: id,
      scope_type: 'registered', profile: { name } })),
    getPersonalProject: async (_, id) => ({ project_id: id, scope_type: 'registered', profile: { name: PROJECTS[id] } }),
    listProjectAgents: async (_, project) => roster.filter(agent => !project || assigned(agent, project)).map(agent => structuredClone(agent)),
    getProjectAgent: async (_, project, id) => {
      const agent = find(id);
      if (!agent || (project && !assigned(agent, project))) throw Object.assign(new Error('Not found'), { status: 404 });
      return agent;
    },
    resolveProjectAgentContext: async input => {
      if (!input.agent_id) return { status: 'ready', reason: 'project_team_lead', agent: find(leads[input.personal_project_id]) };
      const agent = find(input.agent_id);
      if (!assigned(agent, input.personal_project_id)) return { status: 'agent_unavailable', reason: 'agent_unavailable' };
      const lead = holdBy[input.personal_project_id];
      return lead && lead !== agent.agent_id
        ? { status: 'ready', reason: 'project_lead_reporting', agent: find(lead), requested_agent_id: agent.agent_id }
        : { status: 'ready', reason: 'explicit_agent', agent };
    },
    getProjectAgentMemory: async input => ({ personal_space_id: SPACE, personal_project_id: input.personalProjectId,
      agent_id: input.agentId, scope: input.personalProjectId ? 'private_agent_project' : 'private_agent_global',
      revision: 0, current: null, history: [] }),
    collaborationPreferences: async (space, project, limit, agent) => ({ personal_space_id: space,
      personal_project_id: project, project_agent_id: agent, effective_preferences: [], global_preferences: [], conflicts: [] }),
    listPreferenceConflicts: async () => [],
    getProjectAgentCoordinationPolicy: async (_, project) => ({ team_lead_agent_id: leads[project] ?? null }),
    listProjectAgentAssignments: async () => [],
    listProjectAgentTasks: async () => []
  });
  app.searchKnowledge = async () => ({ facts: [], entities: [] });
  // What every client's prompt hook calls; a new session each time, so no
  // session binding or session owner change is involved.
  let sessions = 0;
  const hook = (taskPrompt, sessionId = `synthetic-session-${sessions++}`) => app.beginTaskContext({
    projectPath: '/synthetic/folder', sessionId, sourceApplication: 'claude_code', taskPrompt });
  return { app, hook, tasks, moveTo: project => { folder = project; } };
}

const introduction = entry => entry.agent_receipt.markdown.split('\n')[1] ?? null;

async function checkpointOf(begun) {
  let checkpoint = null;
  const task = () => ({ token: begun.token, sessionId: begun.sessionId, personalProjectId: begun.personalProjectId,
    projectAgentId: begun.projectAgentId, sourceApplication: 'claude_code', agentAssignment: begun.agentAssignment,
    projectScope: null, workLogRequired: false, checkpoint });
  const app = { config: { personal: { spaceId: SPACE } }, getCapturePolicy: () => ({ enabled: true }),
    taskContextRegistry: { context: async () => task(),
      prepare: async (_token, value) => { checkpoint = { ...value, phase: 'prepare' }; return task(); },
      checkpoint: async (_token, value) => { checkpoint = { ...checkpoint, ...value, phase: 'complete' }; return task(); } },
    personal: { conversation: async () => ({ status: 'saved', conversation_id: 'synthetic-conversation' }),
      getProjectAgent: async () => ADA } };
  return checkpointTaskKnowledge(app, { taskContextToken: begun.token, sourceApplication: 'claude_code',
    disposition: 'retain_nothing', reason: 'Synthetic work done', collaborators: [] });
}

test('a new FLA introduces itself under its name once; the next task signs plainly', async () => {
  const { hook } = fixture();
  const first = await hook('看看构建');
  const [identity, line, ...rest] = first.agent_receipt.markdown.split('\n');
  assert.match(identity, /^FULI Agent：\[Ada Lead/);
  assert.deepEqual(rest, []);
  assert.match(line, /^\p{Extended_Pictographic}/u);
  assert.match(line, /Ada Lead/);
  assert.match(line, /Alpha 的事/);
  assert.match(line, /负责构建和交付/);
  assert.match(line, /消息开头写 #FLA Ada Lead。$/);
  assert.doesNotMatch(line, /[@?？]|同事/);
  assert.equal(introduction(await hook('再看看测试')), null);
});

test('a project passed to another FLA says so once, naming both; a new owner\'s hand-off replaces its first meeting', async () => {
  const leads = { 'project-a': 'ada', 'project-b': 'jade' };
  const { hook } = fixture({ leads });
  await hook('看看构建');
  leads['project-a'] = 'jade';
  const handed = introduction(await hook('继续'));
  assert.match(handed, /Alpha/);
  assert.match(handed, /Ada Lead/);
  assert.match(handed, /Jade Lin/);
  assert.match(handed, /#FLA Jade Lin。$/);
  assert.equal(introduction(await hook('再继续')), null);
});

test('an FLA met through a hand-off is not introduced again in another project; handing back says so once', async () => {
  const leads = { 'project-a': 'ada', 'project-b': 'jade' };
  const f = fixture({ leads });
  await f.hook('看看构建');
  leads['project-a'] = 'jade';
  await f.hook('继续');
  f.moveTo('project-b');
  assert.equal(introduction(await f.hook('看看 Beta')), null);
  f.moveTo('project-a');
  leads['project-a'] = 'ada';
  const back = introduction(await f.hook('回到 Alpha'));
  assert.match(back, /Jade Lin/);
  assert.match(back, /#FLA Ada Lead。$/);
});

test('only the owner introduces itself: a held member, a named FLA\'s visit and a roundtable wake do not', async () => {
  const f = fixture({ holdBy: { 'project-a': 'ada' } });
  // Jamie is asked for by name, but Ada holds the task: only Ada speaks.
  const held = await f.hook('#FLA Jamie Ash 看看构建');
  assert.equal(held.context.project_agent_id, 'ada');
  assert.match(introduction(held), /Ada Lead/);
  assert.doesNotMatch(introduction(held), /Jamie/);
  // Named in another project, Jamie owns that task and meets the person there,
  // without taking the project over from its lead.
  f.moveTo('project-b');
  const named = await f.hook('#FLA Jamie Ash 看看 Beta');
  assert.equal(named.context.project_agent_id, 'jamie');
  assert.match(introduction(named), /Jamie Ash/);
  assert.doesNotMatch(introduction(named), /Jade/);
  assert.match(introduction(await f.hook('看看 Beta 的发布')), /Jade Lin/, 'Beta\'s own lead still meets the person first');

  const woken = fixture();
  woken.app.roundtable = { taskEntryDelegation: () => ({ token: 'synthetic-delegation' }), pending: () => [] };
  assert.equal(introduction(await woken.hook('圆桌唤醒的任务')), null);
  woken.app.roundtable = undefined;
  assert.match(introduction(await woken.hook('人自己的任务')), /Ada Lead/, 'the wake recorded nothing');
});

test('the checkpoint receipt that replaces the entry\'s carries the same introduction that turn', async () => {
  const { hook, tasks } = fixture();
  const entry = await hook('看看构建');
  const result = await checkpointOf(tasks.at(-1));
  assert.match(introduction(entry), /Ada Lead/);
  assert.equal(introduction(result), introduction(entry));
  assert.doesNotMatch(result.agent_receipt.markdown, /fla_introduction/);
  await hook('下一件事');
  assert.equal(introduction(await checkpointOf(tasks.at(-1))), null);
});

// The pure line, through the entry's own decision with an in-memory store.
function introduce({ agentId = 'agent', name = 'Lyra North', responsibility = '负责 fuli 的开发和交付，还有发布',
  project = 'fuli', projectId = 'project', store = new AgentIntroductionStore() } = {}) {
  const application = { config: { personal: { spaceId: SPACE } }, agentIntroductions: store };
  return introductionEntry(application, { resolution: { personalProjectId: projectId },
    selection: { agent: { agentId } }, context: { role: { name, responsibility }, project_brief: project ? { name: project } : null },
    input: { agentInvocation: true, agentToolName: 'begin_task_context' } })?.line ?? null;
}

// What a person reads: the Markdown escapes and entities undone.
const visible = line => line.replace(/\\(.)/gu, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

test('every variant stays one line within 100 characters, escaped, and the same agent always gets the same one', () => {
  const long = 'Ｗ'.repeat(200);
  const firsts = new Set();
  const handoffs = new Set();
  for (let index = 0; index < 64; index += 1) {
    const agentId = `synthetic-agent-${index}`;
    const first = introduce({ agentId, name: long, responsibility: long, project: long });
    assert.ok([...visible(first)].length <= 100, `${[...visible(first)].length}: ${first}`);
    assert.doesNotMatch(first, /\n/);
    assert.match(first, /消息开头写 #FLA。$/, 'a name too long to show whole is addressed by the picker');
    firsts.add(first);
    const store = new AgentIntroductionStore();
    introduce({ agentId: 'earlier', name: long, store });
    const handoff = introduce({ agentId, name: long, project: long, store });
    assert.ok([...visible(handoff)].length <= 100, `${[...visible(handoff)].length}: ${handoff}`);
    handoffs.add(handoff.replace(/Ｗ+…?/gu, 'W'));
    assert.equal(introduce({ agentId, name: long, responsibility: long, project: long }), first, 'same agent, same wording');
  }
  assert.equal(new Set([...firsts].map(line => line.replace(/Ｗ+…?/gu, 'W'))).size, 4, 'four first-meeting variants');
  assert.equal(handoffs.size, 4, 'four hand-off variants');

  const marked = introduce({ name: '*Star_[x]*', project: 'a|b`c', responsibility: '<b>x</b> & (y)' });
  assert.match(marked, /\\\*Star\\_\\\[x\\\]\\\*/);
  assert.match(marked, /a\\\|b\\`c/);
  assert.match(marked, /（&lt;b&gt;x&lt;\/b&gt; &amp; \\\(y\\\)）/);
  assert.match(marked, /#FLA \\\*Star\\_\\\[x\\\]\\\*。$/);
});

test('an owner outside any project is introduced for what is not in a project yet', () => {
  const line = introduce({ agentId: 'employee.astro', name: 'Astro', responsibility: '会话助理：先接住还没归项目的会话',
    project: null, projectId: null });
  assert.match(line, /还没归项目的事/);
  assert.match(line, /（会话助理）/);
  assert.match(line, /#FLA Astro。$/);
});
