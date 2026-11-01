import assert from 'node:assert/strict';
import test from 'node:test';

import { checkpointTaskKnowledge } from '../src/graphiti/agent-knowledge-workflows.js';
import { FederatedGraphApplication } from '../src/graphiti/federated-application.js';
import { parseFlaMention } from '../src/graphiti/fla-mention.js';
import { compactTaskContext } from '../src/conversations/task-context-view.js';
import { CONSOLE_LOCALES, consoleConversationPhrasings, consolePhrasings } from '../test-support/console-mention-phrasings.js';

// rec#54: continue one of the person's FLAs by name in the current session,
// from any folder, with a native choice instead of copied names or IDs.
// Synthetic Provider boundary only; no real data, client or model.

const SPACE = 'synthetic-space';
const PROJECTS = { 'project-a': 'Alpha', 'project-b': 'Beta', 'project-c': 'Gamma' };
// The folder this session works in belongs to project-a, whose lead is Ada.
const FOLDER = { status: 'matched', basis: 'repository_root', personalProjectId: 'project-a' };

function fla(agentId, name, role, projectId, { updated = '2026-10-01T00:00:00Z', status = 'active',
  clients = ['codex', 'claude_code'], type = 'durable' } = {}) {
  return { agent_id: agentId, personal_space_id: SPACE, personal_project_id: null, memory_scope: 'reviewed_agent',
    updated_at: updated, assignments: projectId ? [{ personal_project_id: projectId, status: 'active', updated_at: updated }] : [],
    profile: { name: role, display_name: name, responsibility: `Synthetic ${role} work`, status,
      allowed_clients: clients, work_kinds: ['project_context'], capabilities: [], agent_type: type } };
}

const ADA = fla('ada', 'Ada Lead', '负责人', 'project-a', { updated: '2026-10-25T00:00:00Z' });
const JAMIE = fla('jamie', 'Jamie Ash', '开发', 'project-b', { updated: '2026-10-20T00:00:00Z' });
const JAMIE_C = fla('jamie-c', 'Jamie Ash', '测试', 'project-c', { updated: '2026-10-10T00:00:00Z' });
const JADE = fla('jade', 'Jade Lin', '设计', 'project-c', { updated: '2026-10-15T00:00:00Z' });
const JEFA = fla('employee.jefa', 'Jefa', '项目经理', null, { updated: '2026-10-26T00:00:00Z' });
const TEMP = fla('temp-1', 'Jamie Temp', '临时', 'project-b', { type: 'temporary' });
// The Agent each project's entry selects when nobody is named.
const LEADS = { 'project-a': 'ada', 'project-b': 'jamie', 'project-c': 'jade' };

// holdBy: projects whose lead holds a named member as the requested Agent.
function fixture({ roster = [ADA, JAMIE, JADE, JEFA, TEMP], leads = LEADS, holdBy = {}, refuse = null } = {}) {
  const calls = [];
  const tasks = [];
  const agents = () => roster.map(agent => structuredClone(agent));
  const find = id => agents().find(agent => agent.agent_id === id);
  const assigned = (agent, project) => agent.assignments.some(item => item.personal_project_id === project
    && item.status === 'active');
  const app = new FederatedGraphApplication({ version: 1, personal: { providerUrl: 'http://127.0.0.1:8787',
    accessToken: 'synthetic-test-token', principalId: 'synthetic-user', spaceId: SPACE }, workspaces: [] },
  { projectPathResolver: () => FOLDER, fetchImpl: async () => { throw new Error('Unexpected Provider request'); } });
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
    listProjectAgents: async (_, project) => {
      calls.push(['roster', project]);
      return project ? agents().filter(agent => assigned(agent, project)) : agents();
    },
    getProjectAgent: async (_, project, id) => {
      calls.push(['agent', project, id]);
      if (refuse?.(id)) throw Object.assign(new Error('Synthetic refusal'), { status: 403 });
      const agent = find(id);
      if (!agent || (project && !assigned(agent, project))) throw Object.assign(new Error('Not found'), { status: 404 });
      return agent;
    },
    resolveProjectAgentContext: async input => {
      calls.push(['resolve', input.personal_project_id, input.agent_id]);
      if (refuse?.(input.agent_id)) throw Object.assign(new Error('Synthetic refusal'), { status: 403 });
      if (!input.agent_id) return { status: 'ready', reason: 'project_team_lead', agent: find(leads[input.personal_project_id]) };
      const agent = find(input.agent_id);
      if (!agent || !assigned(agent, input.personal_project_id)) return { status: 'agent_unavailable', reason: 'agent_unavailable' };
      // As the Provider: a member asked for by name is held by the project's lead.
      const lead = holdBy[input.personal_project_id];
      return lead && lead !== agent.agent_id
        ? { status: 'ready', reason: 'project_lead_reporting', agent: find(lead), requested_agent_id: agent.agent_id }
        : { status: 'ready', reason: 'explicit_agent', agent };
    },
    getProjectAgentMemory: async input => {
      calls.push(['memory', input.personalProjectId, input.agentId]);
      return { personal_space_id: SPACE, personal_project_id: input.personalProjectId, agent_id: input.agentId,
        scope: input.personalProjectId ? 'private_agent_project' : 'private_agent_global', revision: 0, current: null, history: [] };
    },
    collaborationPreferences: async (space, project, limit, agent) => {
      calls.push(['preferences', project, agent]);
      return { personal_space_id: space, personal_project_id: project, project_agent_id: agent,
        effective_preferences: [], global_preferences: [], conflicts: [] };
    },
    listPreferenceConflicts: async () => [],
    getProjectAgentCoordinationPolicy: async (_, project) => ({ team_lead_agent_id: leads[project] ?? null }),
    listProjectAgentAssignments: async () => [],
    listProjectAgentTasks: async () => []
  });
  app.searchKnowledge = async input => { calls.push(['search', input.personalProjectId, input.projectAgentId ?? null]);
    return { facts: [], entities: [] }; };
  const run = (taskPrompt, extra = {}) => app.getCollaborationPreferences({ projectPath: '/synthetic/alpha',
    sessionId: 'synthetic-session', sourceApplication: 'codex', taskPrompt,
    agentInvocation: true, agentToolName: 'get_collaboration_preferences', ...extra });
  // What every client's prompt hook calls (Claude Code, Codex, OpenCode).
  const hook = (taskPrompt, extra = {}) => app.beginTaskContext({ projectPath: '/synthetic/alpha',
    sessionId: 'synthetic-hook-session', sourceApplication: 'claude_code', taskPrompt, ...extra });
  const memoryReads = () => calls.filter(([kind]) => kind === 'memory').map(([, project, agent]) => `${agent}@${project}`);
  return { app, run, hook, calls, tasks, memoryReads };
}

const owner = entry => [entry.context.personal_project_id, entry.context.project_agent_id];
const bytes = value => Buffer.byteLength(JSON.stringify(compactTaskContext(value)));

test('parsing: leading @name, #FLA at a start or after a request word, release and choice; emails, decorators and scopes are not FLAs, @FLG is a group', () => {
  assert.deepEqual(parseFlaMention('@Jamie Ash 继续刚才的任务'), { explicit: false, query: 'Jamie Ash 继续刚才的任务' });
  assert.deepEqual(parseFlaMention('  #FLA 小林 测试 继续'), { explicit: true, query: '小林 测试 继续' });
  assert.deepEqual(parseFlaMention('背景在上面\n  #FLA Jamie Ash 继续'), { explicit: true, query: 'Jamie Ash 继续' });
  // After a request word `#FLA` takes an exact name only (inline): it never opens the picker.
  for (const [prompt, query] of [['请让 #FLA Jamie Ash 看一下', 'Jamie Ash 看一下'], ['帮我 #FLA 小林 看下数据', '小林 看下数据'],
    ['麻烦，#FLA Bole 招一个前端', 'Bole 招一个前端'], ['please #FLA Jamie Ash review this', 'Jamie Ash review this'],
    ['Could you ask #FLA Jamie Ash', 'Jamie Ash']]) {
    assert.deepEqual(parseFlaMention(prompt), { explicit: true, query, inline: true }, prompt);
  }
  // rec#58: prose, quotes, code and questions about the syntax are text.
  for (const text of ['希望内置角色也可以用 #FLA Bole，解释一下这些写法', '`#FLA Bole` 是什么意思？',
    '“#FLA Bole” 和 @Bole 有什么区别？', '请让 "#FLA Jamie Ash" 看一下', '请让「#FLA Jamie Ash」看一下',
    'fix the parser for #FLA', 'the outlet #FLA Jamie', '改一下\n```\n#FLA Jamie Ash\n```']) {
    assert.equal(parseFlaMention(text), null, text);
  }
  assert.deepEqual(parseFlaMention('@FLA'), { explicit: true, query: '' });
  assert.deepEqual(parseFlaMention('#fla 2'), { choice: 2 });
  for (const release of ['@FLA 结束', '#FLA end', '@fla release。']) assert.deepEqual(parseFlaMention(release), { release: true });
  assert.deepEqual(parseFlaMention('@{Team%20%2F%20x} 请接手'), { handoff: 'Team / x' });
  for (const text of ['jamie@example.com 发邮件', '@jamie@example.com', '@scope/pkg 升级', '@Override 是什么意思',
    '@Component(selector) 报错', '@app.route 怎么写', '@README.md 看看', '请让 @Jamie Ash 继续',
    '`@Jamie Ash`', '#FLAG 不是关键词']) {
    assert.equal(parseFlaMention(text), null, text);
  }
  assert.deepEqual(parseFlaMention('@FLG 讨论一下'), { group: { query: '讨论一下' } });
});

test('excluded prompts keep the folder\'s owner and never read the roster', async () => {
  for (const prompt of ['@Override 这个注解什么意思', '@scope/pkg 升级到最新', 'mail jamie@example.com',
    '请让 @Jamie Ash 继续']) {
    const { run, calls } = fixture({ roster: [ADA, JAMIE, fla('override', 'Override', '开发', 'project-b')] });
    const entry = await run(prompt);
    assert.deepEqual(owner(entry), ['project-a', 'ada'], prompt);
    assert.equal(entry.fla, undefined);
    assert.equal(calls.some(([kind, project]) => kind === 'roster' && project === null), false, prompt);
  }
});

test('a unique name continues that FLA in its own project from another project\'s folder', async () => {
  const { run, tasks, calls, memoryReads } = fixture();
  const entry = await run('@Jamie Ash 继续刚才的任务');
  assert.deepEqual(owner(entry), ['project-b', 'jamie']);
  assert.equal(entry.context.project_resolution.basis, 'explicit_fla');
  assert.equal(entry.project_agent_context.project_agent_id, 'jamie');
  assert.equal(entry.fla.status, 'continuing');
  assert.equal(entry.fla.notice, '本会话由 Jamie Ash 继续项目 Beta 的工作');
  assert.match(entry.fla.guidance, /resume_agent_conversation/);
  assert.equal(entry.agent_receipt.owner.agent_id, 'jamie');
  assert.ok(entry.agent_receipt.markdown.endsWith(' · 本会话由 Jamie Ash 继续项目 Beta 的工作'));
  assert.deepEqual(memoryReads(), ['jamie@project-b', 'jamie@null']);
  assert.ok(calls.filter(([kind]) => kind === 'search').every(([, project, agent]) => project === 'project-b'
    && (agent === null || agent === 'jamie')));
  assert.ok(calls.filter(([kind]) => kind === 'preferences').every(([, project, agent]) => project === 'project-b' && agent === 'jamie'));
  assert.equal(tasks[0].personalProjectId, 'project-b');
  assert.equal(tasks[0].projectAgentId, 'jamie');
  assert.doesNotMatch(JSON.stringify(entry), /fla_binding|fla_choice/, 'routing markers never reach the client');
});

test('#FLA, case-insensitive names, Chinese names and the longest name match the same way', async () => {
  const roster = [ADA, JAMIE, fla('lin', '小林', '运营', 'project-b'), fla('lin-qa', '小林 测试', '测试', 'project-c')];
  for (const [prompt, expected] of [['#FLA jAmIe aSh continue', ['project-b', 'jamie']],
    ['@小林 测试 跑一下回归', ['project-c', 'lin-qa']], ['@小林 继续写周报', ['project-b', 'lin']],
    ['帮我 #FLA 小林 看下数据', ['project-b', 'lin']]]) {
    assert.deepEqual(owner(await fixture({ roster }).run(prompt)), expected, prompt);
  }
  // A Latin name may run into Chinese text; the longer name still wins over "Jamie".
  const jamies = [ADA, JAMIE, fla('jamie-s', 'Jamie', '运维', 'project-c')];
  assert.deepEqual(owner(await fixture({ roster: jamies }).run('@Jamie Ash继续')), ['project-b', 'jamie']);
  // Two Chinese runs never split: "小林子" is not "小林".
  for (const prompt of ['@小林子 帮我看下', '@小林继续写周报']) {
    const other = await fixture({ roster }).run(prompt);
    assert.equal(other.context.project_resolution.basis, 'repository_root', prompt);
    assert.equal(other.fla, undefined, prompt);
  }
});

test('the console\'s copied #FLA and its "continue here" phrasing continue that FLA, in both locales', async () => {
  const roster = [ADA, JAMIE, fla('lin', '小林', '运营', 'project-b')];
  for (const locale of CONSOLE_LOCALES) {
    for (const [name, expected] of [['Jamie Ash', ['project-b', 'jamie']], ['小林', ['project-b', 'lin']]]) {
      const copied = consolePhrasings(locale, name, null);
      // Pasted alone, typed on directly after, or pasted mid-sentence.
      for (const prompt of [copied.continue, `${copied.mention}看下进度`, `帮我 ${copied.mention}看下进度`]) {
        assert.deepEqual(owner(await fixture({ roster }).run(prompt)), expected, `${locale}: ${prompt}`);
      }
    }
  }
});

test('the roundtable page\'s "ask one FLA to ask another" and "continue here" examples continue the first FLA, in both locales', async () => {
  const roster = [ADA, JAMIE, fla('lin', '小林', '运营', 'project-b')];
  for (const locale of CONSOLE_LOCALES) {
    for (const [names, expected] of [[['Jamie Ash', '小林'], ['project-b', 'jamie']], [['小林', 'Jamie Ash'], ['project-b', 'lin']]]) {
      const copied = consoleConversationPhrasings(locale, names);
      for (const prompt of [`${copied.relay}上线时间`, copied.continue]) {
        assert.deepEqual(owner(await fixture({ roster }).run(prompt)), expected, `${locale}: ${prompt}`);
      }
    }
  }
});

test('a bare @FLA offers the person\'s FLAs as a native choice, recent first, without loading any of them', async () => {
  const { run, memoryReads } = fixture();
  const entry = await run('@FLA');
  assert.equal(entry.fla.status, 'choose');
  assert.equal(entry.human_interaction.presentation, 'host_native_single_choice');
  // Jefa (a FULI management role) and the temporary Agent are not FLAs a person continues.
  assert.deepEqual(entry.human_interaction.options, ['1. Ada Lead — Alpha — 负责人', '2. Jamie Ash — Beta — 开发',
    '3. Jade Lin — Gamma — 设计']);
  assert.match(entry.human_interaction.guidance, /#FLA N/);
  assert.match(entry.human_interaction.guidance, /do no task work as any FLA/);
  assert.doesNotMatch(entry.human_interaction.guidance, /Continue unrelated work/);
  assert.equal(entry.context.project_agent_id, null);
  assert.equal(entry.agent_receipt.owner, null);
  assert.match(entry.agent_receipt.markdown, /分配待确认.*等待选择 FLA/);
  assert.deepEqual(memoryReads(), []);
  assert.doesNotMatch(JSON.stringify(entry.human_interaction), /jamie"|project-b|jade"/, 'no internal ID is shown');
});

test('#FLA with part of a name narrows the choice, and a single close fit continues directly', async () => {
  const { run } = fixture({ roster: [ADA, JAMIE, JADE, fla('jo', 'Joan Wu', '运维', 'project-c')] });
  const narrowed = await run('#FLA Ja 继续');
  assert.deepEqual(narrowed.human_interaction.options, ['1. Jamie Ash — Beta — 开发', '2. Jade Lin — Gamma — 设计']);
  assert.equal(narrowed.fla.reason, 'partial');
  assert.deepEqual(owner(await fixture().run('#FLA Jad 看下设计稿')), ['project-c', 'jade']);
  assert.deepEqual(owner(await fixture().run('@FLA Ash 继续')), ['project-b', 'jamie']);
  // Letters in order only narrow the picker; they never continue.
  const fuzzy = await fixture().run('#FLA jsh 继续');
  assert.deepEqual(fuzzy.human_interaction.options, ['1. Jamie Ash — Beta — 开发']);
  assert.equal(fuzzy.context.project_agent_id, null);
});

test('a bare @word continues only an exact name or name word of exactly one FLA (D-68)', async () => {
  assert.deepEqual(owner(await fixture().run('@Jamie 继续')), ['project-b', 'jamie']);
  assert.deepEqual(owner(await fixture().run('@Ash 继续')), ['project-b', 'jamie']);
  // A name word is matched as written (D-68a); a whole name is not.
  assert.equal((await fixture().run('@ash 继续')).context.project_resolution.basis, 'repository_root');
  assert.deepEqual(owner(await fixture().run('@jamie ash 继续')), ['project-b', 'jamie']);
  // "Jamie" is a word of two FLAs: no guess, no picker, ordinary routing.
  const two = await fixture({ roster: [ADA, JAMIE, fla('jamie-l', 'Jamie Lee', '测试', 'project-c')] }).run('@Jamie 继续');
  assert.equal(two.context.project_resolution.basis, 'repository_root');
  assert.equal(two.human_interaction, undefined);
  // Part of a name: ordinary routing with one line on how to choose.
  const partial = await fixture().run('@Ja 继续');
  assert.equal(partial.context.project_resolution.basis, 'repository_root');
  assert.equal(partial.human_interaction, undefined);
  assert.deepEqual(partial.fla, { status: 'hint', hint: '想找 FLA？用 #FLA Ja 选一位，或用 @FLG 邀请几位一起讨论' });
});

test('a name word needs two characters, a Latin one as written, and an FLA that can continue (D-68a)', async () => {
  const ordinary = async (roster, prompt) => {
    const { run, tasks } = fixture({ roster: [ADA, ...roster] });
    const entry = await run(prompt);
    assert.equal(entry.context.project_resolution.basis, 'repository_root', prompt);
    assert.notEqual(entry.fla?.status, 'unavailable', prompt);
    assert.ok(!tasks.some(task => task.agentAssignment?.match_basis?.some(item => item.startsWith('fla_'))), prompt);
  };
  await ordinary([fla('jw', 'J Wu', '开发', 'project-b')], '@j 你好');
  await ordinary([fla('bot', 'Test Bot', '测试', 'project-b')], '@test 跑一下');
  await ordinary([fla('data', 'Data Wu', '开发', 'project-b', { status: 'archived' })], '@Data 注解报错');
  // As written, the word still names its FLA; a whole name may still say why it cannot.
  assert.deepEqual(owner(await fixture({ roster: [ADA, fla('data', 'Data Wu', '开发', 'project-b')] })
    .run('@Data 继续')), ['project-b', 'data']);
  const dismissed = await fixture({ roster: [ADA, fla('data', 'Data Wu', '开发', 'project-b', { status: 'archived' })] })
    .run('@Data Wu 继续');
  assert.equal(dismissed.fla.reason, 'dismissed');
});

test('accepted residual: a common word written exactly as an FLA\'s name word names that FLA', async () => {
  assert.deepEqual(owner(await fixture({ roster: [ADA, fla('mock', 'Mock Li', '测试', 'project-b')] })
    .run('@Mock 怎么用')), ['project-b', 'mock']);
});

test('the hint repeats only the typed word, never the rest of the prompt', async () => {
  const entry = await fixture().run(`@Ja，${'很长的说明'.repeat(300)}`);
  assert.deepEqual(entry.fla, { status: 'hint', hint: '想找 FLA？用 #FLA Ja 选一位，或用 @FLG 邀请几位一起讨论' });
});

test('ordinary prompts that start with @ never bind the session (review of #385)', async () => {
  for (const [agent, prompt] of [[fla('sarah', 'Sarah Chen', '开发', 'project-b'), '@src 里的代码有问题'],
    [fla('dana', 'Dana Tao', '开发', 'project-c'), '@Data 注解报错'],
    [fla('mei', 'Mei Lin', '开发', 'project-c'), '@me 看下这个报错'],
    [fla('ivy', 'Ivy Wu', '开发', 'project-b'), '@I think this is wrong']]) {
    const { run, tasks, memoryReads } = fixture({ roster: [ADA, agent] });
    const entry = await run(prompt);
    assert.deepEqual([entry.context.personal_project_id, entry.context.project_resolution.basis],
      ['project-a', 'repository_root'], prompt);
    assert.equal(entry.human_interaction, undefined, prompt);
    assert.ok(!memoryReads().some(read => read.startsWith(`${agent.agent_id}@`)), prompt);
    assert.ok(!tasks.some(task => task.agentAssignment?.match_basis?.some(item => item.startsWith('fla_'))), prompt);
    assert.deepEqual(owner(await run('继续')), ['project-a', 'ada'], prompt);
  }
});

test('a roster outage leaves a bare @word to ordinary routing; #FLA says the picker is unavailable', async () => {
  const { app, run } = fixture();
  app.personal.listProjectAgents = async () => { throw new Error('Synthetic outage'); };
  const bare = await run('@Makefile 看下');
  assert.equal(bare.context.project_resolution.basis, 'repository_root');
  assert.equal(bare.fla, undefined);
  assert.equal((await run('#FLA Jamie')).fla.status, 'unavailable');
});

test('picking by number binds the choice, by reply or by the host calling #FLA N', async () => {
  const { run, hook } = fixture({ roster: [ADA, JAMIE, JAMIE_C, JADE] });
  const ambiguous = await run('@Jamie Ash 继续');
  assert.equal(ambiguous.fla.reason, 'same_name');
  assert.deepEqual(ambiguous.human_interaction.options, ['1. Jamie Ash — Beta — 开发', '2. Jamie Ash — Gamma — 测试']);
  assert.match(ambiguous.human_interaction.question, /有多位「Jamie Ash」/);
  const picked = await run('2');
  assert.deepEqual(owner(picked), ['project-c', 'jamie-c']);
  assert.equal(picked.fla.notice, '本会话由 Jamie Ash 继续项目 Gamma 的工作');
  // A host that showed clickable options calls the entry with the chosen number.
  await hook('@FLA');
  assert.deepEqual(owner(await hook('#FLA 3')), ['project-c', 'jade']);
  // A number nobody was offered asks again instead of guessing.
  const unknown = await run('#FLA 9');
  assert.equal(unknown.fla.reason, 'choice_unknown');
});

test('the same name in several projects asks among exactly those; one FLA in this folder\'s project continues here', async () => {
  const { run } = fixture({ roster: [ADA, JAMIE, JAMIE_C, JADE] });
  const entry = await run('#FLA Jamie Ash');
  assert.equal(entry.human_interaction.options.length, 2);
  assert.equal(entry.context.project_agent_id, null);
  const twoProjects = fla('ada', 'Ada Lead', '负责人', 'project-a');
  twoProjects.assignments.push({ personal_project_id: 'project-b', status: 'active', updated_at: '2026-10-01T00:00:00Z' });
  assert.deepEqual(owner(await fixture({ roster: [twoProjects, JAMIE] }).run('@Ada Lead 继续')), ['project-a', 'ada']);
  // From outside both projects, its two projects are asked.
  const outside = await fixture({ roster: [twoProjects, JAMIE] }).run('@Ada Lead 继续', { projectPath: null });
  assert.deepEqual(outside.human_interaction.options, ['1. Ada Lead — Alpha — 负责人', '2. Ada Lead — Beta — 负责人']);
});

test('the binding holds for later turns, in hooks and MCP alike, until another FLA is named or it is released', async () => {
  const { run, hook, tasks } = fixture();
  await hook('@Jamie Ash 继续刚才的任务');
  const next = await hook('再跑一遍测试');
  assert.deepEqual(owner(next), ['project-b', 'jamie']);
  assert.equal(next.fla, undefined, 'a plain bound turn repeats no guidance');
  assert.match(next.agent_receipt.markdown, /· 本会话由 Jamie Ash 继续项目 Beta 的工作$/);
  assert.ok(tasks.at(-1).agentAssignment.match_basis.some(item => item.startsWith('fla_binding:jamie project-b ')));
  // Another session is not bound.
  assert.deepEqual(owner(await run('再跑一遍测试')), ['project-a', 'ada']);
  assert.deepEqual(owner(await hook('@Jade Lin 看下设计稿')), ['project-c', 'jade']);
  assert.deepEqual(owner(await hook('继续')), ['project-c', 'jade']);
  const released = await hook('@FLA 结束');
  assert.deepEqual(owner(released), ['project-a', 'ada']);
  assert.equal(released.fla.notice, '已结束本会话与 Jade Lin 的绑定，回到常规项目归属');
  assert.deepEqual(owner(await hook('继续')), ['project-a', 'ada']);
});

test('while bound, an @word the folder resolves goes there this turn; one that resolves nowhere stays bound', async () => {
  const jefa = fla('employee.jefa', 'Jefa', '项目经理', 'project-a');
  const { run } = fixture({ roster: [ADA, JAMIE, JADE, jefa] });
  await run('@Jamie Ash 继续');
  assert.deepEqual(owner(await run('@src 里的代码有问题')), ['project-b', 'jamie']);
  assert.deepEqual(owner(await run('@Jefa 看下进度')), ['project-a', 'employee.jefa']);
  assert.deepEqual(owner(await run('继续')), ['project-b', 'jamie']);
});

test('a hand-off\'s @{agentId} goes to that Agent and ends the binding; the bound one\'s own keeps it', async () => {
  const { run } = fixture();
  await run('@Jamie Ash 继续');
  assert.deepEqual(owner(await run('@{jamie} 继续')), ['project-b', 'jamie']);
  const handoff = await run('@{ada} 请接手');
  assert.deepEqual(owner(handoff), ['project-a', 'ada']);
  assert.match(handoff.agent_receipt.markdown, /已结束本会话与 Jamie Ash 的绑定/);
  assert.deepEqual(owner(await run('继续')), ['project-a', 'ada']);
});

test('a hand-off that reaches nobody keeps the binding', async () => {
  const { run } = fixture();
  await run('@Jamie Ash 继续');
  // Jade works in project-c, outside this folder's scope.
  const failed = await run('@{jade} 请接手');
  assert.equal(failed.context.project_agent_id, null);
  assert.doesNotMatch(failed.agent_receipt.markdown, /已结束/);
  assert.deepEqual(owner(await run('继续')), ['project-b', 'jamie']);
});

test('a roundtable wake in a bound session carries the binding unchanged', async () => {
  const { app, hook, tasks } = fixture();
  await hook('@Jamie Ash 继续');
  let waking = true;
  app.roundtable = { pending: () => [], attentionReplies: () => [],
    taskEntryDelegation: ({ sessionId }) => (waking && sessionId === 'synthetic-hook-session'
      ? { token: 'synthetic-delegation', sessionId } : null) };
  await hook('@{ada} [FULI 圆桌 · synthetic-thread]\n请看一下');
  assert.ok(tasks.at(-1).agentAssignment.match_basis.some(item => item.startsWith('fla_binding:jamie project-b ')));
  waking = false;
  assert.deepEqual(owner(await hook('继续')), ['project-b', 'jamie']);
});

test('an abandoned picker or refusal keeps the session where it was', async () => {
  for (const asking of ['@FLA', '#FLA Nobody', '@Jamie Ash 继续']) {
    const roster = asking.startsWith('@Jamie') ? [ADA, JADE, { ...JAMIE, profile: { ...JAMIE.profile, status: 'archived' } }]
      : undefined;
    const { app, hook } = fixture(roster ? { roster } : {});
    app.projectPathResolver = () => ({ status: 'not_provided', basis: null, personalProjectId: null });
    await hook('继续', { projectPath: null, personalProjectId: 'project-c' });
    assert.deepEqual(owner(await hook('继续', { projectPath: null })), ['project-c', 'jade']);
    assert.equal((await hook(asking, { projectPath: null })).context.project_agent_id, null, asking);
    const after = await hook('算了，接着刚才的', { projectPath: null });
    assert.deepEqual(owner(after), ['project-c', 'jade'], asking);
    assert.equal(after.context.project_resolution.basis, 'host_session_context');
  }
});

test('ranking: this session\'s FLA, then the current project, then recent activity', async () => {
  const roster = [ADA, JAMIE, JADE, fla('ann', 'Ann Alpha', '测试', 'project-a', { updated: '2026-09-01T00:00:00Z' })];
  const { run } = fixture({ roster });
  assert.deepEqual((await run('@FLA')).human_interaction.options.map(option => option.split(' — ')[0]),
    ['1. Ada Lead', '2. Ann Alpha', '3. Jamie Ash', '4. Jade Lin']);
  await run('@Jade Lin 继续');
  assert.deepEqual((await run('@FLA')).human_interaction.options.map(option => option.split(' — ')[0]),
    ['1. Jade Lin', '2. Ada Lead', '3. Ann Alpha', '4. Jamie Ash']);
});

test('an entry that already read the session\'s task does not read it again', async () => {
  const { app, hook } = fixture();
  let reads = 0;
  const current = app.taskContextRegistry.current;
  app.taskContextRegistry.current = async (...args) => { reads++; return current(...args); };
  await hook('继续看一下', { turnId: 'turn-1' });
  assert.equal(reads, 1);
  reads = 0;
  await hook('继续看一下');
  assert.equal(reads, 1);
});

test('a release outside any project does not leave the session in the FLA\'s project', async () => {
  const { app, hook } = fixture();
  app.projectPathResolver = () => ({ status: 'not_provided', basis: null, personalProjectId: null });
  await hook('@Jamie Ash 继续', { projectPath: null });
  assert.deepEqual(owner(await hook('继续', { projectPath: null })), ['project-b', 'jamie']);
  await hook('@FLA 结束', { projectPath: null });
  const after = await hook('随便问个问题', { projectPath: null });
  assert.equal(after.context.personal_project_id, null);
  assert.equal(after.context.project_resolution.basis, 'pending_assignment');
});

test('a dismissed or client-restricted FLA is reported with its reason; nobody else is loaded', async () => {
  // Each with the shortest legal fix the person has, if any.
  for (const [agent, reason, text] of [
    [{ ...JAMIE, profile: { ...JAMIE.profile, status: 'archived' } }, 'dismissed', '已被解雇，未改用其他 FLA'],
    [{ ...JAMIE, profile: { ...JAMIE.profile, allowed_clients: ['cursor'] } }, 'client_not_allowed',
      '不允许在当前客户端使用，未改用其他 FLA；可在控制台为 Jamie Ash 允许当前客户端']]) {
    const { run, memoryReads } = fixture({ roster: [ADA, agent] });
    const entry = await run('@Jamie Ash 继续');
    assert.equal(entry.fla.status, 'unavailable');
    assert.equal(entry.fla.reason, reason);
    assert.equal(entry.fla.notice, `Jamie Ash（Beta）无法继续：${text}`);
    assert.equal(entry.agent_receipt.owner, null);
    assert.deepEqual(memoryReads(), [], reason);
  }
});

test('a client list stored with `other` covers OpenCode', async () => {
  const legacy = { ...JAMIE, profile: { ...JAMIE.profile, allowed_clients: ['other'] } };
  const entry = await fixture({ roster: [ADA, legacy] }).run('@Jamie Ash 继续', { sourceApplication: 'opencode' });
  assert.deepEqual(owner(entry), ['project-b', 'jamie']);
});

test('an FLA dismissed while bound stays the binding and says why, never falling back to the folder', async () => {
  const roster = [ADA, structuredClone(JAMIE)];
  const { run, memoryReads, calls } = fixture({ roster });
  await run('@Jamie Ash 继续');
  roster[1].profile.status = 'archived';
  calls.length = 0;
  const next = await run('继续');
  assert.equal(next.fla.reason, 'dismissed');
  assert.equal(next.context.project_agent_id, null);
  assert.deepEqual(memoryReads(), []);
  assert.equal((await run('还在吗')).fla.reason, 'dismissed');
});

test('an FLA the Provider will not let this reader reach is reported as such, with no private context loaded', async () => {
  const { run, memoryReads, calls } = fixture({ refuse: id => id === 'jamie' });
  const entry = await run('@Jamie Ash 继续');
  assert.equal(entry.fla.reason, 'access_denied');
  assert.match(entry.fla.notice, /无权访问该 FLA 或其项目/);
  assert.equal(entry.project_agent_context.status, 'agent_unavailable');
  assert.equal(entry.project_agent_context.role, undefined);
  assert.deepEqual(memoryReads(), []);
  assert.ok(calls.filter(([kind]) => kind === 'preferences').every(([, , agent]) => agent === null));
});

// rec#58: FULI's own roles, as the Provider provisions them (their id and capability).
function builtIn(id, name, projectId, type = 'durable') {
  const agent = fla(`employee.${id}`, name, '内置角色', projectId, { type });
  agent.profile.capabilities = [`fuli.employee:${id}`];
  return agent;
}
const BOLE = builtIn('bole', 'Bole', 'project-a', 'hr');
const ASTRO = builtIn('assistant', 'Astro', null);

// The roles' own project scope (src/employees/recruitment.js authorize), refusing as it does.
function withScope(setup, allowed = () => true) {
  const authorized = [];
  setup.app.employees = { authorize: async input => {
    authorized.push([input.templateId, input.personalProjectId]);
    if (!allowed(input)) throw Object.assign(new Error('Recruit this employee into the selected project first'),
      { status: 403, code: 'assignment_required' });
    return { agentId: `employee.${input.templateId}` };
  }, taskEntry: async () => ({ status: 'ready', managers: [], worker_started: false }) };
  return { ...setup, authorized };
}

test('#FLA names a built-in role in this folder\'s project, through its own scope check; the picker never lists roles', async () => {
  for (const prompt of ['#FLA Bole 招一个前端', '@FLA bole 招一个前端', '帮我 #FLA Bole 招一个前端']) {
    const { run, authorized } = withScope(fixture({ roster: [ADA, JAMIE, BOLE, ASTRO] }));
    const entry = await run(prompt);
    assert.deepEqual(owner(entry), ['project-a', 'employee.bole'], prompt);
    assert.equal(entry.fla.notice, '本会话由 Bole 继续项目 Alpha 的工作', prompt);
    assert.deepEqual(authorized, [['bole', 'project-a']], prompt);
  }
  const picker = await withScope(fixture({ roster: [ADA, JAMIE, BOLE, ASTRO] })).run('#FLA');
  assert.deepEqual(picker.human_interaction.options, ['1. Ada Lead — Alpha — 负责人', '2. Jamie Ash — Beta — 开发']);
  // Astro works globally.
  const astro = await withScope(fixture({ roster: [ADA, BOLE, ASTRO] })).run('#FLA Astro 帮我想想');
  assert.deepEqual(owner(astro), [null, 'employee.assistant']);
  assert.equal(astro.fla.notice, '本会话由 Astro 继续其全局工作');
  // An Agent that only reuses a role's id is not that role.
  const impostor = await withScope(fixture({ roster: [ADA, JEFA] })).run('#FLA Jefa 看下进度');
  assert.equal(impostor.fla.reason, 'no_match');
});

test('a built-in role the person renamed answers to its new name and still to its built-in one (D-89)', async () => {
  const renamed = builtIn('bole', '伯乐', 'project-a', 'hr');
  renamed.profile.name = 'Bole';
  for (const prompt of ['#FLA 伯乐 招一个前端', '#FLA Bole 招一个前端', '#FLA bole 招一个前端']) {
    const entry = await withScope(fixture({ roster: [ADA, JAMIE, renamed, ASTRO] })).run(prompt);
    assert.deepEqual(owner(entry), ['project-a', 'employee.bole'], prompt);
    assert.equal(entry.fla.notice, '本会话由 伯乐 继续项目 Alpha 的工作', prompt);
  }
  // The built-in name is the role's own; an FLA's role text is never a name it answers to.
  const entry = await withScope(fixture({ roster: [ADA, JAMIE, renamed, ASTRO] })).run('#FLA 负责人 看下');
  assert.equal(entry.fla.reason, 'no_match');
});

test('a built-in role outside its scope or outside any project says why and how to fix it, never substituting', async () => {
  const refused = withScope(fixture({ roster: [ADA, BOLE] }), () => false);
  const entry = await refused.run('#FLA Bole 招一个前端');
  assert.equal(entry.fla.reason, 'not_responsible');
  assert.equal(entry.fla.notice, 'Bole（Alpha）无法继续：没有负责这个项目，未改用其他 FLA；可在控制台 Bole 的「管理负责项目」里加上 Alpha');
  assert.equal(entry.context.project_agent_id, null);
  assert.deepEqual(refused.memoryReads(), []);
  assert.match(entry.agent_receipt.markdown, /指定 Agent 未负责此项目/);
  const outside = withScope(fixture({ roster: [ADA, BOLE] }));
  outside.app.projectPathResolver = () => ({ status: 'not_provided', basis: null, personalProjectId: null });
  const nowhere = await outside.run('#FLA Bole 招一个前端', { projectPath: null });
  assert.equal(nowhere.fla.reason, 'needs_project');
  assert.equal(nowhere.fla.notice, 'Bole无法继续：只在项目里工作，当前会话不属于任何项目，未改用其他 FLA；请在项目文件夹里再叫 Bole');
  assert.deepEqual(outside.authorized, []);
});

test('an FLA sharing a built-in role\'s name is asked about, never guessed', async () => {
  const entry = await withScope(fixture({ roster: [ADA, BOLE, fla('bole-fla', 'Bole', '招聘', 'project-b')] }))
    .run('#FLA Bole 招一个前端');
  assert.equal(entry.fla.reason, 'same_name');
  assert.equal(entry.human_interaction.options.length, 2);
  assert.equal(entry.context.project_agent_id, null);
});

test('prose about the syntax stays an ordinary prompt; a leading @Bole keeps the folder\'s rule and binds nothing', async () => {
  for (const prompt of ['希望内置角色也可以用 #FLA Bole，解释一下这些写法', '让 #FLA 支持内置角色', '`#FLA Bole` 怎么用？']) {
    const { run, calls } = withScope(fixture({ roster: [ADA, BOLE] }));
    const entry = await run(prompt);
    assert.deepEqual(owner(entry), ['project-a', 'ada'], prompt);
    assert.equal(entry.fla, undefined, prompt);
    assert.equal(entry.human_interaction, undefined, prompt);
    assert.equal(calls.some(([kind, project]) => kind === 'roster' && project === null), prompt.startsWith('让'), prompt);
  }
  const { run } = withScope(fixture({ roster: [ADA, BOLE] }));
  const bare = await run('@Bole 看下人员分布');
  assert.deepEqual(owner(bare), ['project-a', 'employee.bole']);
  assert.equal(bare.fla, undefined);
  assert.deepEqual(owner(await run('继续')), ['project-a', 'ada']);
});

test('a member is held by its project lead as the requested Agent, and the sentence says so', async () => {
  const { run, memoryReads } = fixture({ holdBy: { 'project-b': 'ada' },
    roster: [{ ...ADA, assignments: [...ADA.assignments, { personal_project_id: 'project-b', status: 'active' }] }, JAMIE] });
  const entry = await run('@Jamie Ash 继续');
  assert.deepEqual(owner(entry), ['project-b', 'ada']);
  assert.equal(entry.project_agent_context.requested_agent_id, 'jamie');
  assert.equal(entry.fla.notice, 'Jamie Ash 是项目 Beta 的成员，本会话由负责人 Ada Lead 持有并请 Jamie Ash 处理');
  assert.ok(!memoryReads().some(read => read.startsWith('jamie@')), 'the member\'s private memory is not loaded');
});

test('the checkpoint receipt names the same FLA and project as the entry', async () => {
  const { run, tasks } = fixture();
  await run('@Jamie Ash 继续');
  const begun = tasks[0];
  let checkpoint = null;
  const task = () => ({ token: begun.token, sessionId: begun.sessionId, personalProjectId: begun.personalProjectId,
    projectAgentId: begun.projectAgentId, sourceApplication: 'codex', agentAssignment: begun.agentAssignment,
    projectScope: null, workLogRequired: false, checkpoint });
  const app = { config: { personal: { spaceId: SPACE } }, getCapturePolicy: () => ({ enabled: true }),
    taskContextRegistry: { context: async () => task(),
      prepare: async (_token, value) => { checkpoint = { ...value, phase: 'prepare' }; return task(); },
      checkpoint: async (_token, value) => { checkpoint = { ...checkpoint, ...value, phase: 'complete' }; return task(); } },
    personal: { conversation: async () => ({ status: 'saved', conversation_id: 'synthetic-conversation' }),
      getProjectAgent: async () => JAMIE } };
  const result = await checkpointTaskKnowledge(app, { taskContextToken: begun.token, sourceApplication: 'codex',
    disposition: 'retain_nothing', reason: 'Synthetic work continued' });
  assert.equal(result.agent_receipt.owner.agent_id, 'jamie');
  assert.match(result.agent_receipt.markdown, /· 本会话由 Jamie Ash 继续项目 Beta 的工作/);
  assert.doesNotMatch(result.agent_receipt.markdown, /fla_binding|project-b/);
});

test('token budget: no @FLA adds nothing; naming, binding and choosing add a bounded, measured amount', async (t) => {
  const plain = fixture();
  const ordinary = await plain.run('继续看一下构建');
  assert.equal(ordinary.fla, undefined);
  assert.equal(ordinary.human_interaction, undefined);
  assert.doesNotMatch(ordinary.agent_receipt.markdown, /本会话|FLA/);
  // The same FLA reached without a name (the folder's lead) against reached by name.
  const folderLead = bytes(ordinary);
  const named = fixture();
  const first = bytes(await named.run('@Ada Lead 继续看一下构建'));
  const later = bytes(await named.run('继续看一下构建'));
  const picker = await fixture().run('@FLA');
  const choice = Buffer.byteLength(JSON.stringify({ fla: picker.fla, human_interaction: picker.human_interaction }));
  t.diagnostic(`entry bytes (compact JSON): folder lead ${folderLead}, named first turn ${first} (+${first - folderLead}), `
    + `bound later turn ${later} (+${later - folderLead}); bare @FLA picker ${bytes(picker)} in all, `
    + `${choice} of them the choice (no Agent context)`);
  assert.ok(first - folderLead <= 700, `the first named turn adds ${first - folderLead} bytes`);
  assert.ok(later - folderLead <= 100, `a bound later turn adds ${later - folderLead} bytes`);
  assert.ok(choice <= 1800, `the choice takes ${choice} bytes`);
});
