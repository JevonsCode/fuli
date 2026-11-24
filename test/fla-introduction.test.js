import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AgentIntroductionStore } from '../src/agent-introductions/store.js';
import { checkpointTaskKnowledge } from '../src/graphiti/agent-knowledge-workflows.js';
import { FederatedGraphApplication, openFederatedGraphApplication } from '../src/graphiti/federated-application.js';
import { introductionEntry } from '../src/graphiti/task-entry-introduction.js';

// 11-17: a new FLA introduces itself once under its name in the receipt, and
// a project handed from one FLA to another says so once, naming both.
// Synthetic Provider boundary and an in-memory store; no real data or client.

const SPACE = 'synthetic-space';
const PROJECTS = { 'project-a': 'Alpha', 'project-b': 'Beta' };
// Introductions began (the store was created) between an existing FLA's creation and a new one's.
const BEGAN = '2026-11-17T08:00:00.000Z';
const EXISTING = '2026-10-01T00:00:00Z';
const NEW = '2026-11-17T09:00:00Z';

function begunStore(path = ':memory:') {
  const store = new AgentIntroductionStore(path);
  store.begin(() => BEGAN);
  return store;
}

function fla(agentId, name, projectIds) {
  return { agent_id: agentId, personal_space_id: SPACE, personal_project_id: null, memory_scope: 'reviewed_agent',
    created_at: NEW, updated_at: '2026-10-01T00:00:00Z',
    assignments: projectIds.map(id => ({ personal_project_id: id, status: 'active', updated_at: '2026-10-01T00:00:00Z' })),
    profile: { name: '开发', display_name: name, responsibility: '负责构建和交付，保持主干可发布', status: 'active',
      allowed_clients: ['codex', 'claude_code'], work_kinds: ['project_context'], capabilities: [], agent_type: 'durable' } };
}

const ADA = fla('ada', 'Ada Lead', ['project-a']);
const JADE = fla('jade', 'Jade Lin', ['project-a', 'project-b']);
const JAMIE = fla('jamie', 'Jamie Ash', ['project-a', 'project-b']);

// leads: the Agent each project's own routing selects, and reasons why
// (default: the project's lead); holdBy: a project whose lead holds a named
// member as the requested Agent (a helper, not the owner); existing: FLAs
// created before introductions began.
function fixture({ leads = { 'project-a': 'ada', 'project-b': 'jade' }, reasons = {}, holdBy = {}, existing = [] } = {}) {
  const roster = [ADA, JADE, JAMIE].map(agent => existing.includes(agent.agent_id) ? { ...agent, created_at: EXISTING } : agent);
  const tasks = [];
  let folder = 'project-a';
  const find = id => structuredClone(roster.find(agent => agent.agent_id === id));
  const assigned = (agent, project) => agent?.assignments.some(item => item.personal_project_id === project);
  const app = new FederatedGraphApplication({ version: 1, personal: { providerUrl: 'http://127.0.0.1:8787',
    accessToken: 'synthetic-test-token', principalId: 'synthetic-user', spaceId: SPACE }, workspaces: [] },
  { projectPathResolver: () => ({ status: 'matched', basis: 'repository_root', personalProjectId: folder }),
    fetchImpl: async () => { throw new Error('Unexpected Provider request'); } });
  app.agentIntroductions = begunStore();
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
      if (!input.agent_id) return { status: 'ready', reason: reasons[input.personal_project_id] ?? 'project_team_lead',
        agent: find(leads[input.personal_project_id]) };
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
  project = 'fuli', projectId = 'project', store = begunStore() } = {}) {
  const application = { config: { personal: { spaceId: SPACE } }, agentIntroductions: store };
  return introductionEntry(application, { resolution: { personalProjectId: projectId },
    selection: { agent: { agentId, createdAt: NEW }, reason: 'project_team_lead' }, context: { role: { name, responsibility }, project_brief: project ? { name: project } : null },
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
    const store = begunStore();
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

// Review of PR 1031, item 1: Codex runs its prompt hook again in the same turn
// for input arriving mid-turn, and an Agent may call get_collaboration_preferences
// after the hook; the newer receipt is the one the reply copies.
test('a second entry of the same turn repeats the introduction; the next turn signs plainly', async () => {
  const { app } = fixture();
  const entry = (taskPrompt, turnId) => app.beginTaskContext({ projectPath: '/synthetic/folder', sessionId: 'synthetic-turns',
    sourceApplication: 'codex', taskPrompt, turnId });
  const first = introduction(await entry('看看构建', 'turn-1'));
  assert.match(first, /Ada Lead/);
  assert.equal(introduction(await entry('补充一句', 'turn-1')), first, 'the hook run again in the same turn');
  const asked = await app.getCollaborationPreferences({ projectPath: '/synthetic/folder', sessionId: 'synthetic-turns',
    sourceApplication: 'codex', taskPrompt: '补充一句', agentInvocation: true, agentToolName: 'get_collaboration_preferences' });
  assert.equal(introduction(asked), first, 'the Agent\'s own entry after the hook');
  assert.equal(introduction(await entry('下一件事', 'turn-2')), null);
});

// Item 2: only a new FLA meets the person; the ones they had keep quiet, but
// a project passing between two of them still says so.
test('an FLA created before introductions began is not introduced; a hand-off between such FLAs still is', async () => {
  const leads = { 'project-a': 'ada', 'project-b': 'jade' };
  const { hook } = fixture({ leads, existing: ['ada', 'jade'] });
  assert.equal(introduction(await hook('看看构建')), null);
  leads['project-a'] = 'jade';
  const handed = introduction(await hook('继续'));
  assert.match(handed, /Ada Lead/);
  assert.match(handed, /#FLA Jade Lin。$/);
  assert.equal(introduction(await hook('再继续')), null);
  // The moment is kept from the first begin: a later one does not move it.
  const store = begunStore();
  store.begin(() => '2030-01-01T00:00:00.000Z');
  assert.match(introduce({ agentId: 'created-after-the-first-begin', store }), /Lyra North/);
});

// Item 3: the session's owner-change notice already names both FLAs.
test('a session continuing into a project whose lead changed says it once, in the owner-change notice', async () => {
  const leads = { 'project-a': 'ada', 'project-b': 'jade' };
  const { hook } = fixture({ leads, existing: ['ada', 'jade'] });
  await hook('看看构建', 'synthetic-same-session');
  leads['project-a'] = 'jade';
  const moved = await hook('继续', 'synthetic-same-session');
  assert.equal(moved.owner_change.from_agent_id, 'ada');
  assert.match(moved.agent_receipt.markdown, /上一个任务由 Ada Lead 负责，这次起由 Jade Lin 负责/);
  assert.equal(introduction(moved), null);
  // The project's new owner was still recorded: another session hears nothing more.
  assert.equal(introduction(await hook('别的会话')), null);

  // A new FLA taking over that way still meets the person, without a hand-off line.
  const freshLeads = { 'project-a': 'ada', 'project-b': 'jade' };
  const fresh = fixture({ leads: freshLeads, existing: ['ada'] });
  await fresh.hook('看看构建', 'synthetic-same-session');
  freshLeads['project-a'] = 'jade';
  const met = introduction(await fresh.hook('继续', 'synthetic-same-session'));
  assert.match(met, /Jade Lin/);
  assert.doesNotMatch(met, /Ada Lead/);
});

// Item 4: a member routed for its work kind does not take the project over.
test('members picked by work kind alternating in one project get no hand-off line', async () => {
  const leads = { 'project-a': 'jade', 'project-b': 'jade' };
  const { hook } = fixture({ leads, reasons: { 'project-a': 'project_team_member' }, existing: ['ada', 'jade', 'jamie'] });
  for (const member of ['jade', 'jamie', 'jade', 'jamie']) {
    leads['project-a'] = member;
    const entry = await hook('改一处');
    assert.equal(entry.context.project_agent_id, member);
    assert.equal(introduction(entry), null, member);
  }
});

// Item 6: a store that cannot be opened introduces nobody and fails nothing.
test('an entry completes without an introduction when the store cannot be opened', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fuli-introductions-'));
  try {
    const f = fixture();
    f.app.agentIntroductions = new AgentIntroductionStore(directory);
    const entry = await f.hook('看看构建');
    assert.match(entry.taskContextToken, /^fuli-task-synthetic-/);
    assert.match(entry.agent_receipt.markdown, /^FULI Agent：\[Ada Lead/);
    assert.equal(introduction(entry), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// An entry still running after its hook's deadline closed the application
// (codex/lifecycle-event.js) introduces nobody and does not reopen the file:
// on Windows an open file keeps its data directory from being removed.
test('an entry that runs on after its application closed reopens no introductions file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fuli-introductions-'));
  try {
    const f = fixture();
    f.app.agentIntroductions = begunStore(join(directory, 'agent-introductions.sqlite'));
    f.app.agentIntroductions.close();
    const entry = await f.hook('看看构建');
    assert.match(entry.taskContextToken, /^fuli-task-synthetic-/);
    assert.equal(introduction(entry), null);
    assert.equal(f.app.agentIntroductions.database, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// Second review, item 1: without a turn ID only the same task prompt is the
// same turn, so a client whose turns are never checkpointed does not carry
// the line on.
test('without a turn ID, only the same prompt repeats the introduction of an unfinished task', async () => {
  const { app } = fixture();
  const ask = (sessionId, taskPrompt) => app.getCollaborationPreferences({ projectPath: '/synthetic/folder', sessionId,
    sourceApplication: 'codex', taskPrompt, agentInvocation: true, agentToolName: 'get_collaboration_preferences' });
  const first = introduction(await ask('synthetic-hookless', '看看构建'));
  assert.match(first, /Ada Lead/);
  assert.equal(introduction(await ask('synthetic-hookless', '下一件事')), null, 'a new prompt is a new turn');
  assert.equal(introduction(await ask('synthetic-hookless', '再下一件事')), null);

  const again = fixture();
  const repeatAsk = taskPrompt => again.app.getCollaborationPreferences({ projectPath: '/synthetic/folder',
    sessionId: 'synthetic-repeat', sourceApplication: 'codex', taskPrompt, agentInvocation: true,
    agentToolName: 'get_collaboration_preferences' });
  const said = introduction(await repeatAsk('看看构建'));
  assert.match(said, /Ada Lead/);
  assert.equal(introduction(await repeatAsk('  看看构建\n')), said, 'the same prompt is the same turn');
  assert.doesNotMatch(again.tasks.at(-1).agentAssignment.match_basis.join('\n'), /看看/, 'the marker keeps a hash, not the prompt');
});

// Second review, item 2: a new installation meets every FLA, built-in ones
// included; an upgraded one keeps the FLAs it had quiet.
test('a new data directory introduces an FLA created before the store; one with earlier FULI data does not', async () => {
  const config = { version: 1, workspaces: [], personal: { providerUrl: 'http://127.0.0.1:8787',
    accessToken: 'synthetic-test-token', principalId: 'synthetic-user', spaceId: SPACE } };
  const meetAstro = async dataDir => {
    const app = openFederatedGraphApplication({ runtimeConfigPath: join(dataDir, 'graph-runtime.json'), env: {}, config,
      fetchImpl: async () => { throw new Error('Unexpected Provider request'); } });
    try {
      return introductionEntry(app, { resolution: { personalProjectId: null },
        selection: { agent: { agentId: 'employee.astro', createdAt: EXISTING } },
        context: { role: { name: 'Astro', responsibility: '会话助理：先接住还没归项目的会话' } },
        input: { agentInvocation: true, agentToolName: 'begin_task_context', taskPrompt: '你好' } })?.line ?? null;
    } finally {
      await app.close();
    }
  };
  const fresh = await mkdtemp(join(tmpdir(), 'fuli-introductions-fresh-'));
  const upgraded = await mkdtemp(join(tmpdir(), 'fuli-introductions-upgraded-'));
  try {
    assert.match(await meetAstro(fresh), /Astro/);
    // An earlier FULI kept per-session records here.
    await mkdir(join(upgraded, 'preference-delivery'));
    assert.equal(await meetAstro(upgraded), null);
  } finally {
    await rm(fresh, { recursive: true, force: true });
    await rm(upgraded, { recursive: true, force: true });
  }
});
